/**
 * The conformance machinery itself: scenario parsing, the two translators, the BLIS reducer and the
 * comparison. None of this needs BLIS.
 */
import { describe, expect, it } from "vitest";
import { evaluate, round4 } from "../compare.js";
import { metricOf, quantityOf, NO_AGGREGATES, type Reduced, type RequestRow } from "../record.js";
import { reduceBlis } from "../refs/blis/run.js";
import { MAIN_ARM, expandStream, mainArm, parseScenario, type CalibratedCheck, type DirectionalCheck, type ExactCheck } from "../scenario.js";
import { scenarioInputHash, toBlis } from "../refs/blis/translate.js";
import { acceptanceForLength, toTypescript } from "../translate/toTypescript.js";

const YAML = `
id: tiny
title: A tiny scenario
model: llama-3.1-8b
gpu: h100
engine: { tp: 1, gpu_memory_utilisation: 0.9, max_num_seqs: 12, max_num_batched_tokens: 8192, block_size: 16, prefix_caching: true }
replicas: 2
routing: least-loaded
requests:
  - { session: 7, at: 1.5, gap_s: 10, turns: [[1000, 50], [100, 40]] }
  - { session: 8, at: 2, turns: [[500, 30]] }
checks:
  - id: c
    claim: a claim
    kind: exact
    quantity: routed_pod
    tolerance: because
`;
const tiny = () => parseScenario("tiny.yaml", YAML);

describe("scenario format", () => {
  it("expands conversations into time-ordered requests", () => {
    expect(mainArm(tiny()).requests).toEqual([
      { at: 1.5, session: 7, round: 0, newTokens: 1000, outputTokens: 50 },
      { at: 2, session: 8, round: 0, newTokens: 500, outputTokens: 30 },
      { at: 11.5, session: 7, round: 1, newTokens: 100, outputTokens: 40 }
    ]);
  });
  it("rejects an id that is not the file name", () => {
    expect(() => parseScenario("other.yaml", YAML)).toThrow(/must equal the file name/);
  });
  it("rejects a known_difference without a concrete reason", () => {
    const bad = YAML.replace("    tolerance: because", "    tolerance: because\n    known_difference:\n      reference: blis\n      cause: they differ\n      reason: they differ\n      differences:\n        value: { typescript: 1, blis: 2 }");
    expect(() => parseScenario("tiny.yaml", bad)).toThrow(/concrete reason/);
  });
  it("rejects a block size the TypeScript model cannot honour", () => {
    expect(() => parseScenario("tiny.yaml", YAML.replace("block_size: 16", "block_size: 32"))).toThrow(/block_size/);
  });
  it("rejects a check kind that does not exist", () => {
    expect(() => parseScenario("tiny.yaml", YAML.replace("kind: exact", "kind: within"))).toThrow(/kind must be/);
  });
  it("needs a tolerance for a calibrated check, a band for a directional one, and a known metric", () => {
    const cal = (extra: string) => YAML.replace("    kind: exact\n    quantity: routed_pod", `    kind: calibrated\n    metric: ttft_mean_s\n${extra}`);
    expect(() => parseScenario("tiny.yaml", cal(""))).toThrow(/rel_tol/);
    expect(() => parseScenario("tiny.yaml", cal("    rel_tol: 0.2"))).not.toThrow();
    expect(() => parseScenario("tiny.yaml", cal("    rel_tol: 0.2").replace("ttft_mean_s", "ttft_median"))).toThrow(/unknown metric/);
    const dir = YAML.replace("    kind: exact\n    quantity: routed_pod", "    kind: directional\n    metric: ttft_mean_s\n    baseline: a\n    intervention: b\n    effect: ratio\n    direction: decrease").replace("replicas: 2", "replicas: 2\narms: { a: {}, b: { replicas: 3 } }");
    expect(() => parseScenario("tiny.yaml", dir)).toThrow(/band/);
    expect(() => parseScenario("tiny.yaml", dir.replace("    direction: decrease", "    direction: decrease\n    band: [0.5, 2]"))).not.toThrow();
  });
  it("builds each arm from the scenario with the arm's fields replaced", () => {
    const s = parseScenario("tiny.yaml", YAML.replace("checks:", "arms:\n  small: {}\n  big: { replicas: 5, engine: { max_num_seqs: 64 } }\nchecks:"));
    expect(Object.keys(s.arms)).toEqual(["small", "big"]);
    expect(s.arms.small!.replicas).toBe(2);
    expect(s.arms.big).toMatchObject({ replicas: 5, engine: { maxNumSeqs: 64, tp: 1, maxNumBatchedTokens: 8192 } });
  });
  it("refuses a calibration scenario that states checks, and a checking scenario that states none", () => {
    expect(() => parseScenario("tiny.yaml", YAML.replace("id: tiny", "id: tiny\nrole: calibration"))).toThrow(/states no checks/);
    expect(() => parseScenario("tiny.yaml", YAML.replace(/checks:[\s\S]*/, "checks: []\n"))).toThrow(/at least one check/);
  });
  it("expands a stream into single-turn requests one rate-interval apart, the first after one interval", () => {
    expect(expandStream({ ratePerS: 4, count: 3, promptTokens: 100, outputTokens: 10 }).map((r) => r.at)).toEqual([0.25, 0.5, 0.75]);
  });
});

describe("translation to the TypeScript model", () => {
  it("names the TypeScript catalogue entries and fixes the fleet", () => {
    const { params, requests } = toTypescript(tiny());
    expect(params).toMatchObject({ model: "llama-3.1-8b", gpu: "h100", routing: "least-loaded", minPods: 2, maxPods: 2, dramGB: 0, ssdGB: 0, remoteGB: 0, returnProb: 0, arrivalRate: 0 });
    expect(requests).toHaveLength(3);
  });
  it("applies a timing override on top of the site's values and nothing else", () => {
    const { params } = toTypescript(tiny(), MAIN_ARM, { mbu: 0.31, hostMsBase: 4 });
    expect(params).toMatchObject({ mbu: 0.31, hostMsBase: 4, mfu: 0.5, hostMsPerSeq: 0.05 });
  });
  it("turns BLIS's mean tokens per step into the per-token acceptance that gives it", () => {
    for (const [length, k] of [[3, 4], [2.2, 3], [4.5, 7]] as const) {
      const beta = acceptanceForLength(length, k);
      expect((1 - beta ** (k + 1)) / (1 - beta)).toBeCloseTo(length, 9);
    }
  });
});

describe("translation to BLIS", () => {
  const input = toBlis(tiny());
  it("writes follow-ups as accumulate deltas with microsecond arrivals", () => {
    const rows = input.files["trace.csv"]!.trim().split("\n").map((l) => l.split(","));
    const col = Object.fromEntries(rows[0]!.map((name, i) => [name, i]));
    const r = rows.slice(1).map((c) => ({ s: c[col.session_id!], round: c[col.round_index!], input: c[col.input_tokens!], at: c[col.arrival_time_us!] }));
    expect(r).toEqual([
      { s: "s7", round: "0", input: "1000", at: "1500000" },
      { s: "s8", round: "0", input: "500", at: "2000000" },
      { s: "s7", round: "1", input: "100", at: "11500000" }
    ]);
    expect(input.files["trace.yaml"]).toContain("session_context_growth: accumulate");
  });
  it("replays open loop on two instances with the router configuration of the policy", () => {
    expect(input.args).toEqual(expect.arrayContaining(["--session-mode", "fixed-accumulate", "--num-instances", "2"]));
    expect(Object.keys(input.files)).toContain("scenarios/epp/least-active-requests.yaml");
    expect(input.files["scenarios/tiny.yaml"]).toContain("endpoint_picker_config: epp/least-active-requests.yaml");
  });
  it("adds flow control only when the scenario has a queue deadline", () => {
    expect(input.files["scenarios/epp/least-active-requests.yaml"]).not.toContain("flowControl");
    const s = tiny();
    mainArm(s).queueDeadlineS = 3;
    const shed = toBlis(s);
    expect(shed.files["scenarios/epp/least-active-requests.yaml"]).toMatch(/defaultRequestTTL: 3s/);
    expect(shed.files["scenarios/epp/least-active-requests.yaml"]).toMatch(/maxConcurrency: 16/);
  });
  it("hashes everything it hands to BLIS, so a changed request changes the hash", () => {
    const other = tiny();
    mainArm(other).requests[0]!.newTokens += 1;
    expect(toBlis(other).inputHash).not.toBe(input.inputHash);
    expect(toBlis(tiny()).inputHash).toBe(input.inputHash);
    expect(scenarioInputHash(other)).not.toBe(scenarioInputHash(tiny()));
  });
  const extras = (block: string) => parseScenario("tiny.yaml", YAML.replace("replicas: 2", `replicas: 3\n${block}`));
  it("states a speculative drafter, its acceptance length and no draft cost", () => {
    const b = toBlis(extras("speculative: { k: 4, acceptance_length: 3 }"));
    expect(b.files["scenarios/tiny.yaml"]).toMatch(/method: ngram/);
    expect(b.args).toEqual(expect.arrayContaining(["--speculative-acceptance-length", "3"]));
  });
  it("splits the pools for prefill/decode, with the threshold in the router's decider and a fabric", () => {
    const b = toBlis(extras("disagg: { prefill_replicas: 1, decode_replicas: 2, threshold_tokens: 700 }"));
    expect(b.args).toEqual(expect.arrayContaining(["--prefill-instances", "1", "--decode-instances", "2"]));
    expect(b.files["scenarios/epp/pd-prefix-based.yaml"]).toMatch(/nonCachedTokens: 700/);
    expect(b.files["scenarios/tiny.yaml"]).toMatch(/cost-model-fabric/);
    expect(b.files["scenarios/tiny.yaml"]).toMatch(/role: prefill/);
  });
  it("gives the replica a host-memory tier of the stated size", () => {
    const b = toBlis(extras("offload: { cpu_gb: 12 }"));
    expect(b.files["scenarios/tiny.yaml"]).toMatch(/bytes: 12000000000/);
    expect(b.files["scenarios/tiny.yaml"]).toMatch(/cost-model-offload-tiers/);
  });
});

describe("BLIS reducer", () => {
  const result = (rows: object[], dropped?: Record<string, number>) =>
    ({
      engine: { version: "0.32.0" },
      data: { catalog: { hash: "c" }, registry: { hash: "r" } },
      request_rows: rows,
      requests: { dropped },
      reports: { engine: { cluster: { kv_capacity_tokens_per_replica: 1600, preemptions: 2, cache_hit_rate: 0.5, cpu_tier_hit_rate: 0.25 } } }
    }) as unknown as Parameters<typeof reduceBlis>[2];
  const done = { fate: "completed", arrival_us: 1500000, ttft_us: 50000, e2e_us: 400000, prompt_tokens: 1000, output_tokens: 50, instance: "instance_1", session_id: "s7" };
  it("turns a Result into per-request rows keyed by session and round, and KV tokens into blocks", () => {
    const r = reduceBlis(tiny(), MAIN_ARM, result([done, { ...done, session_id: "s8", arrival_us: 2000000, cached_local_tokens: 0, instance: "instance_0" }, { ...done, round_index: 1, arrival_us: 11500000, cached_local_tokens: 1040 }]));
    expect(r.kvBlocksPerReplica).toBe(100);
    expect(r.preemptions).toBe(2);
    expect(r.requestsPerPod).toEqual([1, 2]);
    expect(r.requests.map((x) => [x.session, x.round, x.cachedTokens, x.pod])).toEqual([[7, 0, 0, 1], [7, 1, 1040, 1], [8, 0, 0, 0]]);
    expect(r.requests[0]!.firstTokenS).toBeCloseTo(1.55, 6);
    expect(r.aggregates).toMatchObject({ prefixHitRate: 0.5, cpuTierHitRate: 0.25 });
  });
  it("attributes drops to a single cause and refuses to guess among several", () => {
    const dropped = { fate: "dropped", arrival_us: 2000000, session_id: "s8" };
    const rows = [done, dropped, { ...done, round_index: 1, arrival_us: 11500000 }];
    expect(reduceBlis(tiny(), MAIN_ARM, result(rows, { gateway_expired: 1 })).requests.find((x) => x.session === 8)!.fate).toBe("shed");
    expect(() => reduceBlis(tiny(), MAIN_ARM, result(rows, { gateway_expired: 1, dropped_unservable: 1 }))).toThrow(/several causes/);
  });
  it("fails when BLIS reports no row for a request that was sent", () => {
    expect(() => reduceBlis(tiny(), MAIN_ARM, result([done]))).toThrow(/no row for/);
  });
});

describe("comparison", () => {
  const row = (session: number, round: number, pod: number | null, arrivalS: number, cachedTokens: number | null = 0): RequestRow => ({
    session, round, inputTokens: 1, outputTokens: 1, cachedTokens, pod, arrivalS, firstTokenS: null, lastTokenS: null, fate: "completed", preemptions: null
  });
  const rec = (source: Reduced["source"], rows: RequestRow[], blocks = 100): Reduced => ({ source, scenario: "x", kvBlocksPerReplica: blocks, requests: rows, preemptions: 0, requestsPerPod: [1, 1], aggregates: NO_AGGREGATES });
  const check = (quantity: ExactCheck["quantity"]): ExactCheck => ({ id: "c", claim: "c", kind: "exact", quantity, tolerance: "t", knownDifferences: [] });
  const one = (r: Reduced) => ({ [MAIN_ARM]: r });

  it("names replicas by first use, so a relabelling of interchangeable replicas is not a difference", () => {
    const a = rec("typescript", [row(1, 0, 0, 1), row(2, 0, 1, 2), row(3, 0, 0, 3)]);
    const b = rec("blis", [row(1, 0, 3, 1), row(2, 0, 2, 2), row(3, 0, 3, 3)]);
    expect(evaluate(check("routed_pod"), one(a), one(b)).differences).toEqual({});
    const c = rec("blis", [row(1, 0, 3, 1), row(2, 0, 2, 2), row(3, 0, 2, 3)]);
    expect(evaluate(check("routed_pod"), one(a), one(c)).differences).toEqual({ "s3/r0": { typescript: 0, blis: 1 } });
  });
  it("reports exactly the keys that differ, with both values, and a key on one side only", () => {
    const a = rec("typescript", [row(1, 0, 0, 1, 0), row(1, 1, 0, 2, 880)]);
    const b = rec("blis", [row(1, 0, 0, 1, 0), row(1, 1, 0, 2, 864)]);
    expect(evaluate(check("prefix_cached_tokens"), one(a), one(b)).differences).toEqual({ "s1/r1": { typescript: 880, blis: 864 } });
    expect(evaluate(check("kv_blocks_per_replica"), one(rec("typescript", [], 10)), one(rec("blis", [], 12))).differences).toEqual({ value: { typescript: 10, blis: 12 } });
  });
  it("counts how often a conversation changed replica", () => {
    const r = rec("blis", [row(1, 0, 0, 1), row(1, 1, 1, 2), row(1, 2, 1, 3), row(2, 0, 0, 1), row(2, 1, 0, 2)]);
    expect(quantityOf(r, "session_pod_changes")).toEqual({ s1: 1, s2: 0 });
  });

  /** Requests that arrive at 0 and see their first token / last token after the given delays; 11 output tokens. */
  const timed = (source: Reduced["source"], ttft: number[], decode = 0.01, extra: Partial<Reduced["aggregates"]> = {}): Reduced => ({
    ...rec(source, ttft.map((t, i) => ({ ...row(i + 1, 0, 0, 0), outputTokens: 11, firstTokenS: t, lastTokenS: t + 10 * decode }))),
    aggregates: { ...NO_AGGREGATES, ...extra }
  });
  it("derives timings from the rows, the same way for both simulators", () => {
    const r = timed("blis", [0.1, 0.3], 0.02);
    expect(metricOf(r, "ttft_mean_s")).toBeCloseTo(0.2, 12);
    expect(metricOf(r, "tpot_mean_s")).toBeCloseTo(0.02, 12);
    expect(metricOf(r, "e2e_mean_s")).toBeCloseTo(0.4, 12);
    expect(metricOf(r, "throughput_tokens_per_s")).toBeCloseTo(22 / 0.5, 9);
    expect(metricOf(r, "ttft_p50_s")).toBeCloseTo(0.2, 12);
  });
  const cal = (relTol: number): CalibratedCheck => ({ id: "t", claim: "c", kind: "calibrated", metric: "ttft_mean_s", relTol, arm: MAIN_ARM, tolerance: "t", knownDifferences: [] });
  it("accepts a calibrated metric within its tolerance and reports both values outside it", () => {
    const blis = one(timed("blis", [0.1]));
    expect(evaluate(cal(0.1), one(timed("typescript", [0.109])), blis).differences).toEqual({});
    const o = evaluate(cal(0.1), one(timed("typescript", [0.12])), blis);
    expect(o.differences).toEqual({ value: { typescript: 0.12, blis: 0.1 } });
    expect(o.detail.relError).toBeCloseTo(0.2, 12);
    expect(o.classification).toBe("known_difference");
    expect(evaluate(cal(0.1), one(timed("typescript", [0.109])), blis).classification).toBe("within_tolerance");
  });
  const dir = (over: Partial<DirectionalCheck> = {}): DirectionalCheck => ({ id: "d", claim: "c", kind: "directional", metric: "ttft_mean_s", baseline: "off", intervention: "on", effect: "ratio", direction: "decrease", band: [0.5, 2], tolerance: "t", knownDifferences: [], ...over });
  const arms = (sim: Reduced["source"], off: number, on: number) => ({ off: timed(sim, [off], 0.01), on: timed(sim, [on], 0.01) });
  it("compares the direction and size of an intervention's effect between the simulators", () => {
    expect(evaluate(dir(), arms("typescript", 1, 0.5), arms("blis", 1, 0.4)).differences).toEqual({});
    expect(evaluate(dir(), arms("typescript", 1, 0.5), arms("blis", 1, 0.4)).classification).toBe("directional_agree");
    // same direction, effect 4 times as large in BLIS: outside the band
    expect(evaluate(dir(), arms("typescript", 1, 0.8), arms("blis", 1, 0.2)).differences).toEqual({ effect: { typescript: 0.8, blis: 0.2 } });
    // BLIS moves the other way
    expect(evaluate(dir(), arms("typescript", 1, 0.5), arms("blis", 1, 1.3)).differences).toEqual({ effect: { typescript: 0.5, blis: 1.3 } });
  });
  it("measures a difference-type effect on rates that start at zero", () => {
    const hit = (sim: Reduced["source"], off: number, on: number) => ({ off: timed(sim, [1], 0.01, { cpuTierHitRate: off }), on: timed(sim, [1], 0.01, { cpuTierHitRate: on }) });
    const c = dir({ metric: "cpu_tier_hit_rate", effect: "difference", direction: "increase" });
    expect(evaluate(c, hit("typescript", 0, 0.4), hit("blis", 0, 0.5)).differences).toEqual({});
    expect(evaluate(c, hit("typescript", 0, 0), hit("blis", 0, 0.5)).differences).toEqual({ effect: { typescript: 0, blis: 0.5 } });
  });
  it("rounds recorded values to four significant digits", () => {
    expect(round4(0.123456789)).toBe(0.1235);
    expect(round4(12345.678)).toBe(12350);
  });
});
