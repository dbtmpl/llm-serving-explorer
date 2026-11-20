import { describe, expect, it } from "vitest";
import { kinds, run, world } from "../../testing.js";
import { FRONTEND_HOPS, tokenizeSeconds } from "../frontend.js";
import { LENGTH_JITTER, MIN_OUTPUT_TOKENS, liveSessions, setSessions, spawnBurst } from "../index.js";

describe("request lengths", () => {
  it("are drawn within the configured ranges around the means", () => {
    const w = world({ promptTokens: 3000, outputTokens: 150, returnProb: 0 });
    spawnBurst(w, 500);
    run(w, 1);
    const [pLo, pHi] = LENGTH_JITTER.firstPrompt;
    const [oLo, oHi] = LENGTH_JITTER.output;
    let prompts = 0;
    for (const r of w.reqs.values()) {
      expect(r.lIn).toBeGreaterThanOrEqual(Math.floor(3000 * pLo));
      expect(r.lIn).toBeLessThanOrEqual(Math.ceil(3000 * pHi));
      expect(r.lOut).toBeGreaterThanOrEqual(Math.max(MIN_OUTPUT_TOKENS, Math.floor(150 * oLo)));
      expect(r.lOut).toBeLessThanOrEqual(Math.ceil(150 * oHi));
      prompts += r.lIn;
    }
    expect(prompts / w.reqs.size).toBeGreaterThan(2850);
    expect(prompts / w.reqs.size).toBeLessThan(3150);
  });
});

describe("closed-loop sessions (Schroeder et al., NSDI 2006)", () => {
  it("send the next turn only after the previous answer, carrying the whole history", () => {
    const w = world({ returnProb: 1, maxTurns: 3, thinkTimeS: 1, followTokens: 100 });
    spawnBurst(w, 5);
    run(w, 120, () => w.m.completed === 15);
    expect(w.m.completed).toBe(15);
    expect(kinds(w).has("req.followup")).toBe(true);
    expect(kinds(w).has("store.read")).toBe(true);
    const done = new Map<number, number>();
    for (const e of w.events) {
      if (e.kind === "req.done") done.set(e.sid!, e.t);
      if (e.kind === "req.followup") {
        expect(done.has(e.sid!)).toBe(true);
        expect(e.t).toBeGreaterThan(done.get(e.sid!)!);
        expect(e.history as number).toBeGreaterThan(0);
      }
    }
  });
  it("stop after the configured number of turns", () => {
    const w = world({ returnProb: 1, maxTurns: 2, thinkTimeS: 0.5 });
    spawnBurst(w, 3);
    run(w, 120, () => w.m.completed === 6 && w.t > 30);
    expect(w.m.completed).toBe(6);
  });
});

describe("setting the number of sessions", () => {
  it("adds sessions up to the target and winds the extra ones down after their current turn", () => {
    const w = world({ returnProb: 1, maxTurns: 50, thinkTimeS: 1 });
    setSessions(w, 100);
    expect(liveSessions(w)).toBe(100);
    run(w, 20);
    expect(liveSessions(w)).toBe(100);
    // asking for the same number again changes nothing
    setSessions(w, 100);
    expect(liveSessions(w)).toBe(100);
    setSessions(w, 1);
    expect(liveSessions(w)).toBe(1);
    run(w, 120, () => w.reqs.size <= 1);
    run(w, 30);
    // the one session left keeps talking; the others sent no further turn
    expect([...w.sessions.values()].filter((s) => s.state !== "idle").length).toBe(1);
    expect(w.reqs.size).toBeLessThanOrEqual(1);
    setSessions(w, 10);
    expect(liveSessions(w)).toBe(10);
  });
});

describe("open-loop arrivals", () => {
  it("add sessions at the configured rate", () => {
    const w = world({ arrivalRate: 5, returnProb: 0, maxPods: 2 });
    run(w, 10);
    expect(w.sessions.size).toBeGreaterThanOrEqual(49);
    expect(w.sessions.size).toBeLessThanOrEqual(51);
  });
});

describe("front-end hops", () => {
  it("tokenisation time grows with prompt length", () => {
    expect(tokenizeSeconds(0)).toBe(FRONTEND_HOPS.tokenizeBase);
    expect(tokenizeSeconds(10000)).toBeCloseTo(0.07, 9);
  });
});
