import { describe, expect, it } from "vitest";
import { run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { SHEDDING } from "../index.js";

describe("deadline shedding (llm-d flow control)", () => {
  it("rejects a request that has waited longer than the deadline", () => {
    expect(SHEDDING.shouldShed(3.2, 3)).toBe(true);
    expect(SHEDDING.shouldShed(2.9, 3)).toBe(false);
    expect(SHEDDING.shouldShed(3, 3)).toBe(false);
  });
  it("is disabled by a deadline of zero", () => {
    expect(SHEDDING.shouldShed(1e6, 0)).toBe(false);
  });
});

describe("flow control in the engine", () => {
  it("sheds requests that wait too long at the router, and accounts for every request", () => {
    const w = world({ maxPods: 1, shedAfterS: 3, returnProb: 0, outputTokens: 600 });
    spawnBurst(w, 80);
    run(w, 200, () => w.reqs.size === 0);
    expect(w.m.failed).toBeGreaterThan(10);
    expect(w.m.completed + w.m.failed).toBe(80);
    for (const e of w.events) if (e.kind === "req.failed") expect(e.why).toMatch(/429/);
  });
  it("sheds nothing when disabled", () => {
    const w = world({ maxPods: 1, shedAfterS: 0, returnProb: 0, outputTokens: 60 });
    spawnBurst(w, 40);
    run(w, 300, () => w.reqs.size === 0);
    expect(w.m.failed).toBe(0);
    expect(w.m.completed).toBe(40);
  });
});
