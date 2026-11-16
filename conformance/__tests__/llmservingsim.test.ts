/**
 * The LLMServingSim adapter, without running the simulator: the translation (token ids that behave as the scenario says), the
 * reading of its output (CSV, log lines, per-request cached tokens) and the committed data it replays. The simulator itself is only run by
 * `pnpm conformance:reference --ref llmservingsim` and the nightly job.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DIR, DATA_DIR, loadPrefixData, lockedCommit } from "../refs/llmservingsim/data.js";
import { prefixStructure } from "../refs/llmservingsim/extract.js";
import { attributeHits, parseCsv, scrapeLog, type LogFacts } from "../refs/llmservingsim/run.js";
import { toLss } from "../refs/llmservingsim/translate.js";
import { referencesOf } from "../refs/index.js";
import { loadScenario, parseScenario } from "../scenario.js";

const BLOCK = 16;
/** The block-hash chain the simulator builds over `input ids + output ids` (the hashes themselves are Python's; only equality matters). */
const chain = (ids: number[]): string[] => {
  const out: string[] = [];
  let parent = "";
  for (let i = 0; i + BLOCK <= ids.length; i += BLOCK) out.push((parent = `${parent}|${ids.slice(i, i + BLOCK).join(",")}`));
  return out;
};
const sharedBlocks = (a: number[], b: number[]): number => {
  const x = chain(a);
  const y = chain(b);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
};

describe("LLMServingSim data and attribution", () => {
  it("keeps the licence, names the repository and commit, and records a SHA-256 for every source file", () => {
    expect(readFileSync(path.join(DIR, "LICENSE-LLMServingSim"), "utf8")).toMatch(/MIT License[\s\S]*CASYS Lab/);
    for (const id of ["rtx-pro-6000-llama-3.1-8b", "rtx-4090-llama-3.1-8b"]) {
      const d = loadPrefixData(id);
      expect(d.source).toMatchObject({ repository: "https://github.com/casys-kaist/LLMServingSim", licence: "MIT", commit: lockedCommit() });
      expect(Object.values(d.source.files).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
      expect(d.requests).toHaveLength(300);
    }
    expect(existsSync(path.join(DATA_DIR, "rtx-pro-6000-llama-3.1-8b.json"))).toBe(true);
  });
  it("is the same workload as the measured run (same token counts in the same order)", () => {
    const s = loadScenario("measured-8b-rtx-pro-6000");
    const d = loadPrefixData("rtx-pro-6000-llama-3.1-8b");
    const rows = Object.values(s.arms)[0]!.requests.slice().sort((a, b) => a.at - b.at || a.session - b.session);
    rows.forEach((r, i) => expect([r.newTokens, r.outputTokens]).toEqual([d.requests[i]!.inputTokens, d.requests[i]!.outputTokens]));
  });
  it("rebuilds the prefix trie exactly: synthetic ids share a block with an earlier request exactly where the real ones do", () => {
    // the real ids are not committed, so test the construction on random sequences with planted sharing
    let seed = 12345;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
    const real: number[][] = [];
    for (let i = 0; i < 60; i++) {
      const base = i && rnd(3) ? real[rnd(i)]!.slice(0, rnd(120)) : [];
      real.push([...base, ...Array.from({ length: 20 + rnd(150) }, () => 1_000_000 + i * 1000 + rnd(900))]);
    }
    const structure = prefixStructure(real);
    const synthetic: number[][] = [];
    let fresh = 10_000_000;
    real.forEach((r, i) => {
      const { parent, shared } = structure[i]!;
      synthetic.push([...(parent >= 0 ? synthetic[parent]!.slice(0, shared) : []), ...Array.from({ length: r.length - shared }, () => fresh++)]);
    });
    for (let i = 0; i < real.length; i++) for (let j = 0; j < i; j++) expect(sharedBlocks(synthetic[i]!, synthetic[j]!), `${i} with ${j}`).toBe(sharedBlocks(real[i]!, real[j]!));
  });
});

describe("translation to LLMServingSim", () => {
  it("gives a follow-up the previous prompt and output as its prefix and every new token a fresh id", () => {
    const s = loadScenario("lss-prefix-cache");
    const input = toLss(s, "main");
    const rows = input.workload.trim().split("\n").map((l) => JSON.parse(l) as { input_toks: number; output_toks: number; arrival_time_ns: number; input_tok_ids: number[]; output_tok_ids: number[] });
    expect(rows).toHaveLength(11);
    const at = (session: number, round: number): number => input.requests.findIndex((r) => r.session === session && r.round === round);
    const r0 = rows[at(1, 0)]!;
    const r1 = rows[at(1, 1)]!;
    expect(r0.input_toks).toBe(1000);
    expect(r1.input_toks).toBe(1000 + 50 + 100);
    expect(r1.input_tok_ids.slice(0, 1050)).toEqual([...r0.input_tok_ids, ...r0.output_tok_ids]);
    expect(r1.arrival_time_ns).toBe(21_300_000_000);
    // different conversations share nothing
    const other = rows[at(2, 0)]!;
    expect(new Set([...r0.input_tok_ids, ...r0.output_tok_ids]).size).toBe(1050);
    expect(other.input_tok_ids.some((t) => r0.input_tok_ids.includes(t))).toBe(false);
    expect(rows.every((r) => r.input_tok_ids.length === r.input_toks && r.output_tok_ids.length === r.output_toks)).toBe(true);
  });
  it("replays the measured example with its own cluster configuration and the real sharing", () => {
    const input = toLss(loadScenario("measured-8b-rtx-pro-6000"), "main");
    expect(input.replay).toBe("rtx-pro-6000-llama-3.1-8b");
    expect(input.cluster).toEqual(loadPrefixData("rtx-pro-6000-llama-3.1-8b").cluster);
    const rows = input.workload.trim().split("\n").map((l) => JSON.parse(l) as { input_tok_ids: number[] });
    const d = loadPrefixData("rtx-pro-6000-llama-3.1-8b");
    d.requests.forEach((p, i) => {
      if (p.parent >= 0) expect(rows[i]!.input_tok_ids.slice(0, p.shared)).toEqual(rows[p.parent]!.input_tok_ids.slice(0, p.shared));
      else expect(rows[i]!.input_tok_ids.length).toBe(p.inputTokens);
    });
    expect(input.args).toContain("--max-num-seqs");
  });
  it("builds the cluster of a plain scenario from the example's instance, with the scenario's memory utilisation, replicas and tiers", () => {
    const s = loadScenario("lss-tiers-offload");
    const withTier = toLss(s, "with-dram");
    const node = (withTier.cluster.nodes as Record<string, any>[])[0]!;
    expect(node.instances).toHaveLength(1);
    expect(node.instances[0].npu_mem.mem_util).toBe(0.25);
    expect(node.cpu_mem.mem_size).toBeCloseTo(32e9 / 2 ** 30, 6);
    expect(withTier.args).toEqual(expect.arrayContaining(["--prefix-storage", "CPU"]));
    expect(toLss(s, "gpu-only").args).not.toContain("--prefix-storage");
    const pd = (toLss(loadScenario("lss-pd-disaggregation"), "split").cluster.nodes as Record<string, any>[])[0]!;
    expect(pd.instances.map((i: any) => i.pd_type)).toEqual(["prefill", "decode", "decode"]);
    const spec = toLss(loadScenario("lss-spec-decoding"), "on");
    expect(spec.args).toEqual(expect.arrayContaining(["--num-speculative-tokens", "3"]));
    expect(Number(spec.args[spec.args.indexOf("--spec-acceptance-rate") + 1])).toBeCloseTo(0.4, 12);
  });
  it("refuses what it cannot run instead of translating it loosely", () => {
    const s = loadScenario("lss-prefix-cache");
    s.arms.main!.engine.tp = 2;
    expect(() => toLss(s, "main")).toThrow(/tensor parallel degree 2/);
    const t = loadScenario("lss-routing-round-robin");
    t.arms.main!.routing = "prefix-aware";
    expect(() => toLss(t, "main")).toThrow(/prefix-aware routing/);
  });
  it("answers only the scenarios that name it or that nothing narrows, and only on its GPUs", () => {
    expect(referencesOf(loadScenario("lss-prefix-cache")).map((r) => r.id)).toEqual(["llmservingsim"]);
    expect(referencesOf(loadScenario("measured-8b-rtx-4090")).map((r) => r.id).sort()).toEqual(["llmservingsim", "vllm-measured"]);
    expect(referencesOf(loadScenario("prefix-cache")).map((r) => r.id)).toEqual(["blis"]);
  });
  it("parses a scenario-level references list and rejects an empty one", () => {
    const yaml = (extra: string) => `id: x\ntitle: t\n${extra}\nmodel: llama-3.1-8b\ngpu: rtx-pro-6000\nengine: { tp: 1, gpu_memory_utilisation: 0.9, max_num_seqs: 4, max_num_batched_tokens: 2048, block_size: 16 }\nreplicas: 1\nrouting: round-robin\nrequests:\n  - { session: 1, at: 1, turns: [[10, 10]] }\nchecks:\n  - { id: c, claim: c, kind: exact, quantity: preemptions, tolerance: t }\n`;
    expect(parseScenario("x.yaml", yaml("references: [llmservingsim]")).references).toEqual(["llmservingsim"]);
    expect(() => parseScenario("x.yaml", yaml("references: []"))).toThrow(/references/);
  });
});

const LOG = `
  • Instance [0] : 593440 tokens / 37090 blocks (72.44 GiB/rank at util 0.92)
▶ Starting simulation...
[1.0s] Avg prompt throughput: 9069.0 tokens/s, Avg generation throughput: 218.0 tokens/s
        ├─Running Instance[0]: 9 reqs, Waiting: 0 reqs, Total # 1 NPUs, Each NPU Memory Usage 16484.51 MB (16.945 % Used), Prefix Cache Hit ratio 0.00 %, (0 / 9069)
[22.0s] Avg prompt throughput: 1.0 tokens/s, Avg generation throughput: 2.0 tokens/s
        ├─Running Instance[0]: 1 reqs, Waiting: 0 reqs, Total # 1 NPUs, Each NPU Memory Usage 1 MB (1 % Used), Prefix Cache Hit ratio 3.00 %, (1040 / 9100)
[23.0s] Avg prompt throughput: 1.0 tokens/s, Avg generation throughput: 2.0 tokens/s
        ├─Running Instance[0]: 1 reqs, Waiting: 0 reqs, Total # 1 NPUs, Each NPU Memory Usage 1 MB (1 % Used), Prefix Cache Hit ratio 3.00 %, (1840 / 9900)
Total requests:                                                     4
Preemptions:                                                        2
Total requested prompt tokens:                                      9900
NPU prefix hit prompt tokens:                                       1840
`;

describe("reading LLMServingSim's output", () => {
  it("reads the capacity, the preemption count, the hit totals and the per-second counters", () => {
    const f = scrapeLog(LOG, 1, true, false);
    expect(f).toMatchObject({ blocks: [37090], preemptions: 2, requestedTokens: 9900, npuHitTokens: 1840 });
    expect(f.ticks[0]).toEqual([{ t: 1, hit: 0, requested: 9069 }, { t: 22, hit: 1040, requested: 9100 }, { t: 23, hit: 1840, requested: 9900 }]);
    expect(scrapeLog(LOG.replace("Preemptions:                                                        2\n", ""), 1, true, false).preemptions).toBe(0);
  });
  it("fails loudly when the format changed", () => {
    expect(() => scrapeLog(LOG.replace("37090 blocks", "37090 pages"), 1, true, false)).toThrow(/KV capacity line of instance 0/);
    expect(() => scrapeLog(LOG.replace("Total requests:", "Requests:"), 1, true, false)).toThrow(/summary/);
    expect(() => scrapeLog(LOG.replace("NPU prefix hit prompt tokens", "Prefix hits"), 1, true, false)).toThrow(/prefix-cache summary/);
  });
  it("reads the CSV with its quoted inter-token list", () => {
    const rows = parseCsv('instance id,request id,input,ITL\n0,0,100,"[1, 2, 3]"\n1,1,200,"[4]"\n');
    expect(rows).toEqual([{ "instance id": "0", "request id": "0", input: "100", ITL: "[1, 2, 3]" }, { "instance id": "1", "request id": "1", input: "200", ITL: "[4]" }]);
  });
  const facts = (hits: number[], total: number): LogFacts => ({ blocks: [1], preemptions: 0, requestedTokens: 1, npuHitTokens: total, cpuHitTokens: null, ticks: [hits.map((hit, i) => ({ t: i + 1, hit, requested: 0 }))] });
  it("attributes the increase of the counter to the request admitted in that second", () => {
    // admissions at 0.5 s (no hit), 2.5 s (800 tokens) and 4.5 s (1,000 tokens)
    expect(attributeHits(facts([0, 0, 800, 800, 1800], 1800), [0.5, 2.5, 4.5], [0, 0, 0], 1)).toEqual([0, 800, 1000]);
  });
  it("refuses to attribute when two admissions share a second with an increase, when the counters do not add up, or when an admission has no line", () => {
    expect(attributeHits(facts([0, 800], 800), [1.2, 1.7], [0, 0], 1)).toBeNull();
    expect(attributeHits(facts([0, 800], 700), [1.2], [0, 0], 1)).toBeNull();
  });
});
