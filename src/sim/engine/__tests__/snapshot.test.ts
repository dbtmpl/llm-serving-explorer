import { describe, expect, it } from "vitest";
import { run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { setParam } from "../tick.js";

/**
 * The interface rewinds step-through by cloning the World. That only works if the World is plain
 * data and every random choice comes from `w.seed`, so a clone replays exactly like the original.
 */
describe("a cloned World replays identically", () => {
  it("produces the same events and the same final state as the original", () => {
    const a = world({ returnProb: 0.6, thinkTimeS: 2, maxPods: 3, dramGB: 4, ssdGB: 8, promptTokens: 6000 });
    spawnBurst(a, 30, 3);
    run(a, 6);
    a.events.length = 0;
    const b = structuredClone(a);
    expect(b).not.toBe(a);
    expect(b.pods[0]).not.toBe(a.pods[0]);

    run(a, 12);
    run(b, 12);
    expect(a.events.length).toBeGreaterThan(50);
    expect(b.events).toEqual(a.events);
    expect(b.t).toBe(a.t);
    expect(b.seed).toBe(a.seed);
    expect(b.m).toEqual(a.m);
    expect(b.pods.map((p) => [p.id, p.state, p.running.length, p.usedBlocks])).toEqual(a.pods.map((p) => [p.id, p.state, p.running.length, p.usedBlocks]));
  });

  it("stays independent: changing the clone does not touch the original", () => {
    const a = world({ maxPods: 2 });
    spawnBurst(a, 10);
    run(a, 3);
    const t = a.t;
    const sessions = a.sessions.size;
    const b = structuredClone(a);
    setParam(b, "maxNumSeqs", 3);
    spawnBurst(b, 20);
    run(b, 2);
    expect(a.t).toBe(t);
    expect(a.sessions.size).toBe(sessions);
    expect(a.params.maxNumSeqs).not.toBe(3);
  });
});
