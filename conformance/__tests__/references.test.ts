/**
 * Comparing the model with several references at once, on synthetic records (no real scenario is
 * covered by two references yet), and the applicability rules of the `Reference` interface.
 */
import { describe, expect, it } from "vitest";
import { compare } from "../compare.js";
import { NO_AGGREGATES, type Reduced, type RequestRow } from "../record.js";
import { blis } from "../refs/blis/index.js";
import { canState, mechanismsOf, unsupportedBecause, type Reference } from "../refs/reference.js";
import { MAIN_ARM, parseScenario, mainArm, type CalibratedCheck, type DirectionalCheck, type ExactCheck } from "../scenario.js";

const row = (session: number, pod: number | null, ttft: number | null, decode = 0.01): RequestRow => ({
  session, round: 0, inputTokens: 1, outputTokens: 11, cachedTokens: 0, pod, arrivalS: 0, firstTokenS: ttft, lastTokenS: ttft === null ? null : ttft + 10 * decode, fate: "completed", preemptions: null
});
const rec = (source: string, rows: RequestRow[], blocks = 100): Reduced => ({ source, scenario: "x", kvBlocksPerReplica: blocks, requests: rows, preemptions: 0, requestsPerPod: [1, 1], aggregates: NO_AGGREGATES });
const timed = (source: string, ttft: number): Record<string, Reduced> => ({ [MAIN_ARM]: rec(source, [row(1, 0, ttft)]) });
const base = { id: "c", claim: "c", tolerance: "t", knownDifferences: [] };
const cal = (relTol = 0.1): CalibratedCheck => ({ ...base, kind: "calibrated", metric: "ttft_mean_s", relTol, arm: MAIN_ARM });
const blocks = (n: number, source: string) => ({ [MAIN_ARM]: rec(source, [], n) });
const exactCheck: ExactCheck = { ...base, kind: "exact", quantity: "kv_blocks_per_replica" };

describe("several references on one check", () => {
  it("is 'single' with one reference, and asserts the model against it", () => {
    const c = compare(cal(), timed("typescript", 0.105), { a: timed("a", 0.1) });
    expect(c.agreement).toBe("single");
    expect(c.assertions).toEqual([{ scope: "a", observed: {}, recorded: {} }]);
  });
  it("all agree: references within the tolerance of each other and the model within it of both", () => {
    const c = compare(cal(), timed("typescript", 0.102), { a: timed("a", 0.1), b: timed("b", 0.104) });
    expect(c.agreement).toBe("all_agree");
    expect(c.gap).toEqual({});
  });
  it("the model agrees with one reference only, though the references agree with each other", () => {
    const c = compare(cal(0.1), timed("typescript", 0.1), { a: timed("a", 0.1), b: timed("b", 0.109) });
    expect(c.agreement).toBe("all_agree");
    const d = compare(cal(0.1), timed("typescript", 0.0905), { a: timed("a", 0.1), b: timed("b", 0.109) });
    expect(d.agreement).toBe("typescript_with_some");
    expect(d.assertions.map((a) => [a.scope, Object.keys(a.observed)])).toEqual([["a", []], ["b", ["value"]]]);
  });
  it("the model agrees with neither although the references agree with each other", () => {
    const c = compare(cal(), timed("typescript", 0.2), { a: timed("a", 0.1), b: timed("b", 0.105) });
    expect(c.agreement).toBe("typescript_differs");
    expect(c.assertions.every((a) => "value" in a.observed)).toBe(true);
  });
  it("references that disagree: the gap must be recorded, and the model is held against their span", () => {
    const inside = compare(cal(), timed("typescript", 0.15), { a: timed("a", 0.1), b: timed("b", 0.2) });
    expect(inside.agreement).toBe("references_disagree_inside");
    expect(inside.gap).toEqual({ value: { a: 0.1, b: 0.2 } });
    expect(inside.span).toEqual({});
    expect(inside.assertions).toEqual([
      { scope: "gap", observed: { value: { a: 0.1, b: 0.2 } }, recorded: {} },
      { scope: "span", observed: {}, recorded: {} }
    ]);
    // just outside the span but within the tolerance of its edge: inside; beyond that: outside
    expect(compare(cal(0.1), timed("typescript", 0.215), { a: timed("a", 0.1), b: timed("b", 0.2) }).agreement).toBe("references_disagree_inside");
    const outside = compare(cal(0.1), timed("typescript", 0.3), { a: timed("a", 0.1), b: timed("b", 0.2) });
    expect(outside.agreement).toBe("references_disagree_outside");
    expect(outside.span).toEqual({ value: { typescript: 0.3, span: "[0.1, 0.2]" } });
  });
  it("matching the more convenient reference does not make a check pass without the gap being explained", () => {
    const c = compare(cal(), timed("typescript", 0.1), { a: timed("a", 0.1), b: timed("b", 0.2) });
    expect(c.span).toEqual({});
    const gap = c.assertions.find((a) => a.scope === "gap")!;
    expect(gap.observed).not.toEqual(gap.recorded);
  });
  it("uses the recorded gap and span difference when they are stated, and flags records that nothing uses", () => {
    const check: CalibratedCheck = {
      ...cal(),
      referenceGap: { reason: "x".repeat(90), differences: { value: { a: 0.1, b: 0.2 } } },
      knownDifferences: [
        { reference: "span", cause: "c", byDesign: false, reason: "y".repeat(90), differences: { value: { typescript: 0.3, span: "[0.1, 0.2]" } } },
        { reference: "a", cause: "c", byDesign: false, reason: "z".repeat(90), differences: { value: { typescript: 0.3, a: 0.1 } } }
      ]
    };
    const c = compare(check, timed("typescript", 0.3), { a: timed("a", 0.1), b: timed("b", 0.2) });
    for (const a of c.assertions) expect(a.observed).toEqual(a.recorded);
    expect(c.unusedRecords).toEqual(["a"]);
  });
  it("exact checks: a numeric value is inside the span between the references' values", () => {
    expect(compare(exactCheck, blocks(105, "typescript"), { a: blocks(100, "a"), b: blocks(110, "b") }).agreement).toBe("references_disagree_inside");
    const out = compare(exactCheck, blocks(120, "typescript"), { a: blocks(100, "a"), b: blocks(110, "b") });
    expect(out.span).toEqual({ value: { typescript: 120, span: "[100, 110]" } });
    expect(compare(exactCheck, blocks(100, "typescript"), { a: blocks(100, "a"), b: blocks(100, "b") }).agreement).toBe("all_agree");
  });
  it("exact checks on decisions: a decision is inside the span when some reference made it", () => {
    const pods = (source: string, ...p: number[]) => ({ [MAIN_ARM]: rec(source, p.map((x, i) => row(i + 1, x, null))) });
    const check: ExactCheck = { ...base, kind: "exact", quantity: "routed_pod" };
    const c = compare(check, pods("typescript", 0, 1, 0), { a: pods("a", 0, 1, 1), b: pods("b", 0, 0, 0) });
    expect(c.agreement).toBe("references_disagree_inside");
    expect(compare(check, pods("typescript", 0, 1, 2), { a: pods("a", 0, 1, 1), b: pods("b", 0, 0, 0) }).span).toEqual({ "s3/r0": { typescript: 2, span: "[0, 1]" } });
  });
  it("directional checks: the effect is held against the span of the references' effects", () => {
    const dir: DirectionalCheck = { ...base, kind: "directional", metric: "ttft_mean_s", baseline: "off", intervention: "on", effect: "ratio", direction: "decrease", band: [0.5, 2] };
    const arms = (s: string, off: number, on: number) => ({ off: timed(s, off)[MAIN_ARM]!, on: timed(s, on)[MAIN_ARM]! });
    const c = compare(dir, arms("typescript", 1, 0.5), { a: arms("a", 1, 0.3), b: arms("b", 1, 0.8) });
    expect(c.agreement).toBe("references_disagree_inside");
    expect(compare(dir, arms("typescript", 1, 1.2), { a: arms("a", 1, 0.3), b: arms("b", 1, 0.8) }).agreement).toBe("references_disagree_outside");
    expect(compare(dir, arms("typescript", 1, 0.5), { a: arms("a", 1, 0.45), b: arms("b", 1, 0.55) }).agreement).toBe("all_agree");
  });
});

const YAML = (extra: string) => `
id: tiny
title: t
model: llama-3.1-8b
gpu: h100
engine: { tp: 1, gpu_memory_utilisation: 0.9, max_num_seqs: 12, max_num_batched_tokens: 8192, block_size: 16, prefix_caching: true }
replicas: 2
routing: least-loaded
${extra}
requests:
  - { session: 7, at: 1.5, gap_s: 10, turns: [[1000, 50], [100, 40]] }
checks:
  - id: c
    claim: a claim
    kind: exact
    quantity: routed_pod
    tolerance: because
`;

describe("what a reference supports", () => {
  const stub = (over: Partial<Reference["supports"]>): Pick<Reference, "supports" | "name"> => ({ name: "Stub", supports: { ...blis.supports, ...over } });
  const s = parseScenario("tiny.yaml", YAML(""));
  it("derives the mechanisms a scenario exercises", () => {
    expect(mechanismsOf(mainArm(s))).toEqual(["multi-replica", "multi-turn"]);
    expect(mechanismsOf(mainArm(parseScenario("tiny.yaml", YAML("queue_deadline_s: 2\nspeculative: { k: 3, acceptance_length: 2 }"))))).toEqual(["multi-replica", "multi-turn", "speculative", "shedding"]);
  });
  it("says why a reference cannot answer a scenario: GPU, model, mechanism or arms", () => {
    expect(unsupportedBecause(blis, s)).toBeNull();
    expect(unsupportedBecause(stub({ gpus: ["rtx-4090"] }), s)).toMatch(/no data for the GPU h100/);
    expect(unsupportedBecause(stub({ models: [] }), s)).toMatch(/no data for the model/);
    expect(unsupportedBecause(stub({ mechanisms: [] }), s)).toMatch(/does not model multi-replica, multi-turn/);
    const withArms = parseScenario("tiny.yaml", YAML("arms: { a: {}, b: { replicas: 3 } }").replace(/checks:[\s\S]*/, "checks:\n  - { id: d, claim: c, kind: directional, metric: ttft_mean_s, baseline: a, intervention: b, effect: ratio, direction: decrease, band: [0.5, 2], tolerance: t }\n"));
    expect(unsupportedBecause(stub({ arms: false }), withArms)).toMatch(/cannot answer a scenario with arms/);
  });
  it("tells which checks it can state", () => {
    expect(canState(stub({ quantities: [] }), s.checks[0]!)).toBe(false);
    expect(canState(blis, s.checks[0]!)).toBe(true);
  });
  it("parses per-reference known differences, a gap and a reference list, and rejects malformed ones", () => {
    const withKnown = YAML("").replace("    tolerance: because", `    tolerance: because\n    references: [blis]\n    known_difference:\n      reference: blis\n      cause: a few words\n      reason: ${"r".repeat(90)}\n      differences:\n        s7/r0: { typescript: 0, blis: 1 }\n    reference_gap:\n      reason: ${"g".repeat(90)}\n      differences:\n        s7/r0: { blis: 1, other: 0 }`);
    const c = parseScenario("tiny.yaml", withKnown).checks[0]!;
    expect(c.references).toEqual(["blis"]);
    expect(c.knownDifferences[0]!.reference).toBe("blis");
    expect(c.referenceGap!.differences).toEqual({ "s7/r0": { blis: 1, other: 0 } });
    expect(() => parseScenario("tiny.yaml", withKnown.replace("{ typescript: 0, blis: 1 }", "{ typescript: 0, other: 1 }"))).toThrow(/must give the values/);
    expect(() => parseScenario("tiny.yaml", withKnown.replace("      reference: blis\n", ""))).toThrow(/"reference"/);
  });
});

import { evaluate } from "../compare.js";
import { distributionOf, groupOf, rowOf } from "../deviation.js";
import type { CapacityCheck } from "../scenario.js";

describe("deviations and capacity checks", () => {
  const capacity = (relTol = 0.001): CapacityCheck => ({ ...base, kind: "capacity", quantity: "kv_blocks_per_replica", relTol });
  it("a capacity within its relative tolerance holds, and carries the signed relative deviation", () => {
    const o = evaluate(capacity(), blocks(27928, "typescript"), blocks(27926, "blis"));
    expect(o.differences).toEqual({});
    expect(o.classification).toBe("within_tolerance");
    expect(o.deviation).toEqual({ kind: "relative", value: 2 / 27926 });
    expect(evaluate(capacity(0.00005), blocks(27928, "typescript"), blocks(27926, "blis")).differences).toEqual({ value: { typescript: 27928, blis: 27926 } });
  });
  it("exact decisions: the share that differ, and the largest relative difference of integers per row", () => {
    const check: ExactCheck = { ...base, kind: "exact", quantity: "prefix_cached_tokens" };
    const r = (source: string, a: number, b: number) => ({ [MAIN_ARM]: rec(source, [{ ...row(1, 0, null), cachedTokens: a }, { ...row(2, 0, null), cachedTokens: b }]) });
    const o = evaluate(check, r("typescript", 100, 55), r("blis", 100, 50));
    expect(o.deviation).toEqual({ kind: "decisions", differing: 1, total: 2, share: 0.5, maxRelative: 0.1 });
  });
  it("directional effects: the ratio of the effects and whether the direction matches", () => {
    const dir: DirectionalCheck = { ...base, kind: "directional", metric: "ttft_mean_s", baseline: "off", intervention: "on", effect: "ratio", direction: "decrease", band: [0.5, 2] };
    const arms = (s: string, off: number, on: number) => ({ off: timed(s, off)[MAIN_ARM]!, on: timed(s, on)[MAIN_ARM]! });
    expect(evaluate(dir, arms("typescript", 1, 0.5), arms("blis", 1, 0.4)).deviation).toEqual({ kind: "effect", ratio: 0.5 / 0.4, directionMatches: true });
    expect(evaluate(dir, arms("typescript", 1, 0.5), arms("blis", 1, 1.2)).deviation).toMatchObject({ directionMatches: false });
  });
  it("puts every check in one group and summarises a distribution with unbounded values kept out of the bins", () => {
    expect(groupOf(capacity())).toBe("capacity");
    expect(groupOf(cal())).toBe("timings");
    expect(groupOf({ ...base, kind: "exact", quantity: "routed_pod" })).toBe("decisions");
    const d = distributionOf([0, 0.004, 0.06, 0.2, null]);
    expect(d).toMatchObject({ n: 5, median: 0.06, max: null, unbounded: 1, within: { "1": 2, "5": 2, "10": 3, "25": 4 } });
    expect(distributionOf([0.01, 0.03]).max).toBe(0.03);
  });
  it("describes a row for the report and the README: both values, the deviation, the tolerance", () => {
    const c = compare(cal(0.3), timed("typescript", 0.7586), { blis: timed("blis", 0.5452) });
    const row = rowOf("s", c, "blis");
    expect(row).toMatchObject({ ours: "759 ms", theirs: "545 ms", deviationText: "+39.1%", tolerance: "30%", holds: false, group: "timings" });
  });
});
