import { describe, expect, it } from "vitest";
import { MIN_OUTPUT_TOKENS } from "../index.js";
import { kinds, run, world } from "../../testing.js";
import { loadTrace, validateTrace, type TraceRequest } from "../trace.js";

const trace = (rows: Partial<TraceRequest>[]): TraceRequest[] =>
  rows.map((r, i) => ({ at: i, session: 1, round: i, newTokens: 100, outputTokens: 10, ...r }));

/** One pod, ready at once, no random returns: only the trace sends requests. */
const traceWorld = () => world({ minPods: 1, maxPods: 1, coldStartS: 0.1, returnProb: 0 });

describe("trace replay (docstring example)", () => {
  it("builds each follow-up from the whole history: 1,000 + 50 + 100 = 1,150 tokens, 1,040 of them cached", () => {
    const w = traceWorld();
    loadTrace(
      w,
      [
        { at: 1, session: 7, round: 0, newTokens: 1000, outputTokens: 50 },
        { at: 20, session: 7, round: 1, newTokens: 100, outputTokens: 40 }
      ],
      MIN_OUTPUT_TOKENS
    );
    run(w, 60, () => w.m.completed === 2);
    expect(w.m.completed).toBe(2);
    const admitted = w.events.filter((e) => e.kind === "req.admitted");
    expect(admitted.map((e) => [e.lIn, e.cached])).toEqual([
      [1000, 0],
      [1150, 1040]
    ]);
    expect(kinds(w).has("trace.overlap")).toBe(false);
  });
});

describe("trace replay edge cases", () => {
  it("injects nothing before the first request is due, and everything exactly once", () => {
    const w = traceWorld();
    loadTrace(w, trace([{ at: 5 }, { at: 5.05, session: 2, round: 0 }]), MIN_OUTPUT_TOKENS);
    run(w, 4);
    expect(w.events.some((e) => e.kind === "req.new")).toBe(false);
    run(w, 20, () => w.m.completed === 2);
    expect(w.events.filter((e) => e.kind === "req.new")).toHaveLength(2);
    expect(w.trace).toHaveLength(0);
  });
  it("flags a follow-up that is sent while the previous answer is still being produced", () => {
    const w = traceWorld();
    loadTrace(w, trace([{ at: 1, outputTokens: 400 }, { at: 1.5 }]), MIN_OUTPUT_TOKENS);
    run(w, 20, () => w.m.completed === 2);
    expect(kinds(w).has("trace.overlap")).toBe(true);
  });
  it("does not draw random numbers, so the seed does not matter", () => {
    const rows = trace([{ at: 1 }, { at: 2, session: 2, round: 0 }]);
    const a = traceWorld();
    const b = world({ minPods: 1, maxPods: 1, coldStartS: 0.1, returnProb: 0 }, 99);
    loadTrace(a, rows, MIN_OUTPUT_TOKENS);
    loadTrace(b, rows, MIN_OUTPUT_TOKENS);
    run(a, 30, () => a.m.completed === 2);
    run(b, 30, () => b.m.completed === 2);
    const lengths = (w: typeof a) => w.events.filter((e) => e.kind === "req.new").map((e) => e.lIn);
    expect(lengths(a)).toEqual(lengths(b));
  });
});

describe("trace validation", () => {
  it("rejects a round that skips ahead, naming the request", () => {
    expect(() => validateTrace(trace([{ round: 1 }]), MIN_OUTPUT_TOKENS)).toThrow(/request 0.*expected round 0/);
  });
  it("rejects an output shorter than the engine can produce", () => {
    expect(() => validateTrace(trace([{ outputTokens: 1 }]), MIN_OUTPUT_TOKENS)).toThrow(/outputTokens/);
  });
  it("rejects an empty prompt and a negative time", () => {
    expect(() => validateTrace(trace([{ newTokens: 0 }]), MIN_OUTPUT_TOKENS)).toThrow(/newTokens/);
    expect(() => validateTrace(trace([{ at: -1 }]), MIN_OUTPUT_TOKENS)).toThrow(/time/);
  });
});
