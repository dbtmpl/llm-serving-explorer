/**
 * Measured vLLM as a reference: real per-request timings, engine settings and KV block counts of vLLM
 * runs on real GPUs, published with LLMServingSim (MIT licence; see `LICENSE-LLMServingSim`). Not a
 * simulator: nothing is run, the committed reduction of the measurements is loaded (`extract.ts` makes
 * it from a clone at the commit in `lock`). The measurements are the only thing used from that repository.
 *
 * What a record is: 300 ShareGPT requests sent at about 10 requests per second to one vLLM engine on one GPU, with the
 * engine's settings. The scenario carries those requests (arrival, input tokens, output tokens) and the engine
 * settings, and `translate` refuses a scenario that differs from the run in any of them, so a scenario cannot be tuned
 * away from the measurement.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Reduced, ReferenceFile, RequestRow } from "../../record.js";
import { BLOCK_TOKENS, mainArm, type Scenario } from "../../scenario.js";
import type { GenerateContext, Reference } from "../reference.js";
import { DATA_DIR, loadMeasured, lockedCommit, type Measured } from "./measured.js";

const datasetId = (s: Scenario): string => {
  const d = mainArm(s);
  return `${d.gpu}-${d.model}`;
};

/** What the scenario is checked against: the run it must reproduce. */
export interface MeasuredInput {
  measured: Measured;
}

const same = (what: string, a: unknown, b: unknown): string | null => (a === b ? null : `${what}: the scenario says ${String(a)}, the measured run had ${String(b)}`);

export function translate(s: Scenario, arm: string): MeasuredInput {
  if (Object.keys(s.arms).length !== 1 || arm !== "main") throw new Error(`${s.id}: measured data answers one deployment, not arms`);
  const d = mainArm(s);
  let measured: Measured;
  try {
    measured = loadMeasured(datasetId(s));
  } catch {
    throw new Error(`${s.id}: no measurements for ${datasetId(s)} in conformance/refs/vllm-measured/data`);
  }
  const e = measured.engine;
  const problems = [
    same("replicas", d.replicas, 1),
    same("tensor parallel degree", d.engine.tp, e.tensorParallelSize),
    same("gpu_memory_utilisation", d.engine.gpuMemoryUtilisation, e.gpuMemoryUtilisation),
    same("max_num_seqs", d.engine.maxNumSeqs, e.maxNumSeqs),
    same("max_num_batched_tokens", d.engine.maxNumBatchedTokens, e.maxNumBatchedTokens),
    same("prefix caching", d.engine.prefixCaching, e.enablePrefixCaching),
    same("async scheduling", d.engine.asyncScheduling === true, e.asyncScheduling === true),
    same("block size", BLOCK_TOKENS, e.blockSize),
    same("number of requests", d.requests.length, measured.requests.length)
  ].filter((x): x is string => x !== null);
  const sorted = d.requests.slice().sort((a, b) => a.at - b.at || a.session - b.session);
  measured.requests.forEach((m, i) => {
    const r = sorted[i];
    if (!r) return;
    if (r.round !== 0 || r.session !== i + 1) problems.push(`request ${i}: expected session ${i + 1}, round 0`);
    if (r.at !== m.arrivalS) problems.push(`request ${i}: arrives at ${r.at} s in the scenario, ${m.arrivalS} s in the run`);
    if (r.newTokens !== m.inputTokens) problems.push(`request ${i}: ${r.newTokens} input tokens in the scenario, ${m.inputTokens} in the run`);
    if (r.outputTokens !== m.outputTokens) problems.push(`request ${i}: ${r.outputTokens} output tokens in the scenario, ${m.outputTokens} in the run`);
  });
  if (problems.length) throw new Error(`${s.id} is not the measured run:\n  ${problems.slice(0, 8).join("\n  ")}`);
  return { measured };
}

function reduce(s: Scenario, _arm: string, m: Measured): Reduced {
  const rows: RequestRow[] = m.requests.map((r, i) => ({
    session: i + 1,
    round: 0,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedTokens: null,
    pod: 0,
    arrivalS: r.arrivalS,
    firstTokenS: r.firstTokenS,
    lastTokenS: r.lastTokenS,
    fate: "completed",
    preemptions: null
  }));
  const t = m.timeseries;
  return {
    source: "vllm-measured",
    scenario: s.id,
    kvBlocksPerReplica: m.engine.numGpuBlocks,
    requests: rows,
    preemptions: t.preemptedMax,
    requestsPerPod: [rows.length],
    aggregates: {
      prefixHitRate: t.cachedPromptTokens === null ? null : t.cachedPromptTokens / t.promptTokens,
      cpuTierHitRate: null,
      kvTransferMeanS: null,
      specTokensPerStep: null,
      prefillPoolRequests: null,
      peakReplicas: 1
    }
  };
}

const dataHash = (id: string): string => createHash("sha256").update(readFileSync(path.join(DATA_DIR, `${id}.json`))).digest("hex");

export const vllmMeasured: Reference<MeasuredInput, Measured> = {
  id: "vllm-measured",
  name: "Measured vLLM",
  kind: "measurement",
  evidence:
    "Real vLLM timings on two workstation GPUs under one workload: 300 ShareGPT requests at about 10 requests per second to one engine, with the engine's own settings and KV block count. It says how far the model is from hardware for that workload and those engine versions; it says nothing about routing, other GPUs, other models, other loads, or multi-replica behaviour.",
  supports: {
    models: ["llama-3.1-8b"],
    gpus: ["rtx-pro-6000", "rtx-4090"],
    mechanisms: [],
    quantities: ["kv_blocks_per_replica", "preemptions"],
    metrics: ["ttft_mean_s", "ttft_p50_s", "ttft_p99_s", "tpot_mean_s", "tpot_p50_s", "tpot_p99_s", "e2e_mean_s", "e2e_p50_s", "e2e_p99_s", "throughput_tokens_per_s", "completed"],
    arms: false
  },
  lock: lockedCommit,
  translate,
  run: (input: MeasuredInput, _context: GenerateContext) => input.measured,
  reduce,
  inputHash: (s) => dataHash(datasetId(s)),
  prepare() {
    // nothing to run: the committed reduction is loaded. `pnpm conformance:extract` remakes it from a clone.
  },
  generate(s, context) {
    const input = this.translate(s, "main");
    return {
      scenario: s.id,
      reference: "vllm-measured",
      inputHash: this.inputHash(s),
      provenance: {
        lock: lockedCommit(),
        repository: input.measured.source.repository,
        licence: input.measured.source.licence,
        vllmVersion: input.measured.engine.vllmVersion,
        device: input.measured.engine.deviceName,
        dataSha256: dataHash(input.measured.id)
      },
      records: { main: this.reduce(s, "main", this.run(input, context)) }
    } satisfies ReferenceFile;
  },
  provenanceProblem(p) {
    if (p.lock !== lockedCommit()) return "made from another LLMServingSim commit than conformance/refs/vllm-measured/lock; regenerate";
    return null;
  }
};
