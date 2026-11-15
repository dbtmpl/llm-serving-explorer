import { describe, expect, it } from "vitest";
import { advance, elapsed, spawnBurst } from "../../index.js";
import { run, world } from "../../testing.js";

describe("the clock starts at the first request", () => {
  it("stays at zero, and pays for no GPU time, while no request has been sent", () => {
    const w = world({ minPods: 1 });
    run(w, 30);
    expect(elapsed(w)).toBe(0);
    expect(w.startedAt).toBeNull();
    expect(w.m.gpuSeconds).toBe(0);
    expect(w.history).toHaveLength(0);
    // the warm pod still loaded its weights meanwhile
    expect(w.pods.some((p) => p.state === "ready")).toBe(true);
  });
  it("counts from the moment the first request is sent", () => {
    const w = world({ minPods: 1 });
    run(w, 30);
    spawnBurst(w, 1);
    advance(w, 0.5);
    expect(w.startedAt).not.toBeNull();
    expect(elapsed(w)).toBeGreaterThan(0.3);
    expect(elapsed(w)).toBeLessThanOrEqual(0.5);
    expect(w.m.gpuSeconds).toBeGreaterThan(0);
    expect(w.m.gpuSeconds).toBeLessThan(1);
    expect(w.history.length).toBeGreaterThan(0);
  });
});
