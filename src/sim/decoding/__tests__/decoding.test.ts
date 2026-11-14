import { describe, expect, it } from "vitest";
import { run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { decodeStrategy, type DecodeSettings } from "../index.js";
import { expectedSpeedup, expectedTokensPerStep } from "../speculative.js";

const settings: DecodeSettings = { draftTokens: 4, acceptance: 0.7, draftCost: 0.04 };

/** A small deterministic generator, so the Monte-Carlo checks below are repeatable. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

describe("autoregressive decoding", () => {
  it("yields one token per step and consumes no randomness", () => {
    const a = decodeStrategy("autoregressive");
    let draws = 0;
    expect(a.tokensThisStep(() => (draws++, 0), settings)).toBe(1);
    expect(draws).toBe(0);
    expect(a.positionsEvaluated(settings)).toBe(1);
    expect(a.overheadFactor(settings)).toBe(0);
  });
});

describe("speculative decoding (Leviathan et al., ICML 2023)", () => {
  const s = decodeStrategy("speculative");
  it("equation 1: expected tokens per target run is (1 − α^(γ+1)) / (1 − α)", () => {
    expect(expectedTokensPerStep(settings)).toBeCloseTo(2.773, 3);
    expect(expectedTokensPerStep({ acceptance: 0.5, draftTokens: 1 })).toBeCloseTo(1.5, 12);
  });
  it("theorem 3.8: speed-up is that over (γ c + 1)", () => {
    expect(expectedSpeedup(settings)).toBeCloseTo(2.773 / 1.16, 2);
    // a draft as slow as the target can never pay off
    expect(expectedSpeedup({ draftTokens: 4, acceptance: 0.7, draftCost: 1 })).toBeLessThan(1);
  });
  it("accepts between 1 and γ + 1 tokens, with the mean of equation 1", () => {
    const draw = lcg(42);
    const n = 100_000;
    let total = 0;
    let fewest = Infinity;
    let most = 0;
    for (let i = 0; i < n; i++) {
      const tokens = s.tokensThisStep(draw, settings);
      fewest = Math.min(fewest, tokens);
      most = Math.max(most, tokens);
      total += tokens;
    }
    expect(fewest).toBe(1);
    expect(most).toBe(settings.draftTokens + 1);
    expect(total / n).toBeCloseTo(expectedTokensPerStep(settings), 1);
  });
  it("never accepts with α = 0 and always accepts with α = 1", () => {
    expect(s.tokensThisStep(() => 0.5, { ...settings, acceptance: 0 })).toBe(1);
    expect(s.tokensThisStep(() => 0.5, { ...settings, acceptance: 1 })).toBe(settings.draftTokens + 1);
  });
  it("the target verifies γ + 1 positions and the draft costs γ c target runs", () => {
    expect(s.positionsEvaluated(settings)).toBe(5);
    expect(s.overheadFactor(settings)).toBeCloseTo(0.16, 12);
  });
});

describe("speculative decoding in the engine", () => {
  it("emits more than one token per sequence per step", () => {
    const steps = (specDecode: boolean) => {
      const w = world({ specDecode, returnProb: 0, outputTokens: 300 });
      spawnBurst(w, 4);
      run(w, 120, () => w.m.completed === 4);
      return w.pods[0]!.steps;
    };
    expect(steps(true)).toBeLessThan(0.6 * steps(false));
  });
  it("reproduces tokens per step (eq. 1) and the speed-up (theorem 3.8) end to end", () => {
    const stats = (specDecode: boolean) => {
      // sequences run one at a time with no host overhead, so a step is one target run plus drafts
      const w = world({ specDecode, specAccept: settings.acceptance, specK: settings.draftTokens, specCost: settings.draftCost, hostMsBase: 0, hostMsPerSeq: 0, returnProb: 0, outputTokens: 1500, promptTokens: 200 }, 11);
      spawnBurst(w, 6, 400);
      run(w, 2000, () => w.m.completed === 6);
      return { tpot: w.m.tpot.reduce((a, b) => a + b, 0) / w.m.tpot.length, w };
    };
    const off = stats(false);
    const on = stats(true);
    const decodeSteps = on.w.events.filter((e) => e.kind === "step.tokens").length;
    const tokensPerStep = on.w.m.tokensOut / decodeSteps;
    expect(tokensPerStep).toBeGreaterThan(expectedTokensPerStep(settings) * 0.93);
    expect(tokensPerStep).toBeLessThan(expectedTokensPerStep(settings) * 1.07);
    expect(off.tpot / on.tpot).toBeGreaterThan(expectedSpeedup(settings) * 0.9);
    expect(off.tpot / on.tpot).toBeLessThan(expectedSpeedup(settings) * 1.1);
  });
});
