/**
 * The conformance machinery itself: scenario parsing, the two translators, the BLIS reducer and the
 * comparison. None of this needs BLIS.
 */
import { describe, expect, it } from "vitest";
import { evaluate } from "../compare.js";
import { quantityOf, type Reduced, type RequestRow } from "../record.js";
import { reduceBlis } from "../run/blis.js";
import { parseScenario, type Check } from "../scenario.js";
import { toBlis } from "../translate/toBlis.js";
import { toTypescript } from "../translate/toTypescript.js";

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
    expect(tiny().requests).toEqual([
      { at: 1.5, session: 7, round: 0, newTokens: 1000, outputTokens: 50 },
      { at: 2, session: 8, round: 0, newTokens: 500, outputTokens: 30 },
      { at: 11.5, session: 7, round: 1, newTokens: 100, outputTokens: 40 }
    ]);
  });
  it("rejects an id that is not the file name", () => {
    expect(() => parseScenario("other.yaml", YAML)).toThrow(/must equal the file name/);
  });
  it("rejects a known_difference without a concrete reason", () => {
    const bad = YAML.replace("    tolerance: because", "    tolerance: because\n    known_difference:\n      reason: they differ\n      differences:\n        value: { typescript: 1, blis: 2 }");
    expect(() => parseScenario("tiny.yaml", bad)).toThrow(/concrete reason/);
  });
  it("rejects a block size the TypeScript model cannot honour", () => {
    expect(() => parseScenario("tiny.yaml", YAML.replace("block_size: 16", "block_size: 32"))).toThrow(/block_size/);
  });
  it("rejects a check kind that does not exist yet", () => {
    expect(() => parseScenario("tiny.yaml", YAML.replace("kind: exact", "kind: within"))).toThrow(/exact/);
  });
});

describe("translation to the TypeScript model", () => {
  it("names the TypeScript catalogue entries and fixes the fleet", () => {
    const { params, requests } = toTypescript(tiny());
    expect(params).toMatchObject({ model: "llama-3.1-8b", gpu: "h100", routing: "least-loaded", minPods: 2, maxPods: 2, dramGB: 0, ssdGB: 0, remoteGB: 0, returnProb: 0, arrivalRate: 0 });
    expect(requests).toHaveLength(3);
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
    const shed = toBlis({ ...tiny(), queueDeadlineS: 3 });
    expect(shed.files["scenarios/epp/least-active-requests.yaml"]).toMatch(/defaultRequestTTL: 3s/);
    expect(shed.files["scenarios/epp/least-active-requests.yaml"]).toMatch(/maxConcurrency: 16/);
  });
  it("hashes everything it hands to BLIS, so a changed request changes the hash", () => {
    const other = tiny();
    other.requests[0]!.newTokens += 1;
    expect(toBlis(other).inputHash).not.toBe(input.inputHash);
    expect(toBlis(tiny()).inputHash).toBe(input.inputHash);
  });
});

describe("BLIS reducer", () => {
  const result = (rows: object[], dropped?: Record<string, number>) =>
    ({
      engine: { version: "0.32.0" },
      data: { catalog: { hash: "c" }, registry: { hash: "r" } },
      request_rows: rows,
      requests: { dropped },
      reports: { engine: { cluster: { kv_capacity_tokens_per_replica: 1600, preemptions: 2 } } }
    }) as Parameters<typeof reduceBlis>[1];
  const done = { fate: "completed", arrival_us: 1500000, ttft_us: 50000, e2e_us: 400000, prompt_tokens: 1000, output_tokens: 50, instance: "instance_1", session_id: "s7" };
  it("turns a Result into per-request rows keyed by session and round, and KV tokens into blocks", () => {
    const r = reduceBlis(tiny(), result([done, { ...done, session_id: "s8", arrival_us: 2000000, cached_local_tokens: 0, instance: "instance_0" }, { ...done, round_index: 1, arrival_us: 11500000, cached_local_tokens: 1040 }]));
    expect(r.kvBlocksPerReplica).toBe(100);
    expect(r.preemptions).toBe(2);
    expect(r.requestsPerPod).toEqual([1, 2]);
    expect(r.requests.map((x) => [x.session, x.round, x.cachedTokens, x.pod])).toEqual([[7, 0, 0, 1], [7, 1, 1040, 1], [8, 0, 0, 0]]);
    expect(r.requests[0]!.firstTokenS).toBeCloseTo(1.55, 6);
  });
  it("attributes drops to a single cause and refuses to guess among several", () => {
    const dropped = { fate: "dropped", arrival_us: 2000000, session_id: "s8" };
    const rows = [done, dropped, { ...done, round_index: 1, arrival_us: 11500000 }];
    expect(reduceBlis(tiny(), result(rows, { gateway_expired: 1 })).requests.find((x) => x.session === 8)!.fate).toBe("shed");
    expect(() => reduceBlis(tiny(), result(rows, { gateway_expired: 1, dropped_unservable: 1 }))).toThrow(/several causes/);
  });
  it("fails when BLIS reports no row for a request that was sent", () => {
    expect(() => reduceBlis(tiny(), result([done]))).toThrow(/no row for/);
  });
});

describe("comparison", () => {
  const row = (session: number, round: number, pod: number | null, arrivalS: number, cachedTokens: number | null = 0): RequestRow => ({
    session, round, inputTokens: 1, outputTokens: 1, cachedTokens, pod, arrivalS, firstTokenS: null, lastTokenS: null, fate: "completed", preemptions: null
  });
  const rec = (simulator: Reduced["simulator"], rows: RequestRow[], blocks = 100): Reduced => ({ simulator, scenario: "x", kvBlocksPerReplica: blocks, requests: rows, preemptions: 0, requestsPerPod: [1, 1] });
  const check = (quantity: Check["quantity"]): Check => ({ id: "c", claim: "c", kind: "exact", quantity, tolerance: "t" });

  it("names replicas by first use, so a relabelling of interchangeable replicas is not a difference", () => {
    const a = rec("typescript", [row(1, 0, 0, 1), row(2, 0, 1, 2), row(3, 0, 0, 3)]);
    const b = rec("blis", [row(1, 0, 3, 1), row(2, 0, 2, 2), row(3, 0, 3, 3)]);
    expect(evaluate(check("routed_pod"), a, b).differences).toEqual({});
    const c = rec("blis", [row(1, 0, 3, 1), row(2, 0, 2, 2), row(3, 0, 2, 3)]);
    expect(evaluate(check("routed_pod"), a, c).differences).toEqual({ "s3/r0": { typescript: 0, blis: 1 } });
  });
  it("reports exactly the keys that differ, with both values, and a key on one side only", () => {
    const a = rec("typescript", [row(1, 0, 0, 1, 0), row(1, 1, 0, 2, 880)]);
    const b = rec("blis", [row(1, 0, 0, 1, 0), row(1, 1, 0, 2, 864)]);
    expect(evaluate(check("prefix_cached_tokens"), a, b).differences).toEqual({ "s1/r1": { typescript: 880, blis: 864 } });
    expect(evaluate(check("kv_blocks_per_replica"), rec("typescript", [], 10), rec("blis", [], 12)).differences).toEqual({ value: { typescript: 10, blis: 12 } });
  });
  it("counts how often a conversation changed replica", () => {
    const r = rec("blis", [row(1, 0, 0, 1), row(1, 1, 1, 2), row(1, 2, 1, 3), row(2, 0, 0, 1), row(2, 1, 0, 2)]);
    expect(quantityOf(r, "session_pod_changes")).toEqual({ s1: 1, s2: 0 });
  });
});
