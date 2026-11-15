import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, advance, createWorld, spawnBurst, type Params, type World } from "../../index.js";

/** FNV-1a over the full event stream: any change in order, timing or payload changes the hash. */
function fingerprint(w: World) {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const e of w.events) feed(JSON.stringify(e, (_k, v) => (typeof v === "number" ? Number(v.toPrecision(12)) : v)));
  const { ttft, tpot, ...counters } = w.m;
  return {
    events: w.events.length,
    hash: (h >>> 0).toString(16),
    counters: { ...counters, gpuSeconds: Number(counters.gpuSeconds.toFixed(6)) },
    meanTtft: Number((ttft.reduce((a, b) => a + b, 0) / Math.max(1, ttft.length)).toFixed(9)),
    meanTpot: Number((tpot.reduce((a, b) => a + b, 0) / Math.max(1, tpot.length)).toFixed(9)),
    pods: w.pods.length
  };
}

function play(over: Partial<Params>, bursts: [number, number, number][], seconds: number, seed = 7) {
  const w = createWorld({ ...DEFAULT_PARAMS, ...over }, seed);
  let next = 0;
  for (let i = 0; i < seconds / 0.05; i++) {
    while (next < bursts.length && bursts[next]![0] <= w.t) {
      spawnBurst(w, bursts[next]![1], bursts[next]![2]);
      next++;
    }
    advance(w, 0.05);
  }
  return fingerprint(w);
}

/**
 * Behaviour snapshots. The simulation is seeded and deterministic, so each scenario has one exact
 * event stream. A refactor must leave these untouched; a deliberate change to the model updates
 * them with `pnpm test -u` and says why in the commit.
 */
describe("simulation behaviour snapshots", () => {
  const cases: Record<string, () => unknown> = {
    "default stack, 30 sessions with follow-ups": () => play({}, [[0, 30, 2]], 40),
    "tiers under pressure": () => play({ promptTokens: 24000, outputTokens: 40, maxPods: 1, dramGB: 8, ssdGB: 16, remoteGB: 12, returnProb: 0.6, thinkTimeS: 8, maxTurns: 4, scaleDownIdleS: 1e9 }, [[0, 40, 15]], 120),
    "on-demand admission overload (preemption)": () => play({ promptTokens: 36000, outputTokens: 1200, maxPods: 1, maxNumSeqs: 16, returnProb: 0 }, [[0, 16, 0]], 300),
    "whole-prompt admission": () => play({ admission: "prompt", promptTokens: 20000, maxPods: 1, returnProb: 0 }, [[0, 20, 1]], 80),
    "static batching, reserve to completion, round-robin": () => play({ batching: "static", admission: "reserve", tokenBudget: 65536, prefixCaching: false, routing: "round-robin", dramGB: 0, ssdGB: 0, remoteGB: 0 }, [[0, 20, 3]], 60),
    "least-loaded routing, no prefix cache": () => play({ routing: "least-loaded", prefixCaching: false }, [[0, 40, 4]], 40),
    "disaggregated prefill/decode": () => play({ disagg: true, returnProb: 1, maxTurns: 2, thinkTimeS: 1 }, [[0, 20, 0]], 60),
    "speculative decoding with overlap": () => play({ specDecode: true, overlap: true, outputTokens: 300 }, [[0, 12, 1]], 40, 11),
    "load shedding with steady arrivals": () => play({ maxPods: 1, shedAfterS: 3, outputTokens: 600, arrivalRate: 3 }, [[0, 40, 0]], 40),
    "70B on 4 GPUs, scale up and down": () => play({ model: "llama-3.1-70b", tp: 4, maxPods: 4, scaleDownIdleS: 3, returnProb: 0 }, [[0, 30, 0]], 80)
  };
  for (const [name, run] of Object.entries(cases)) {
    it(name, () => {
      expect(run()).toMatchSnapshot();
    });
  }
});
