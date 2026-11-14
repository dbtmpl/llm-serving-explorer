import { describe, expect, it } from "vitest";
import { run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { BATCHING, batchingMode } from "../index.js";

describe("batching modes", () => {
  it("static batching admits only into an empty batch (Clipper, Triton)", () => {
    const m = batchingMode("static");
    expect(m.admitsInto(0)).toBe(true);
    expect(m.admitsInto(1)).toBe(false);
    expect(m.admissionHonoursTokenBudget).toBe(false);
  });
  it("continuous batching admits at every step (Orca)", () => {
    const m = batchingMode("continuous");
    expect(m.admitsInto(0)).toBe(true);
    expect(m.admitsInto(11)).toBe(true);
    expect(m.admissionHonoursTokenBudget).toBe(true);
  });
  it("rejects an unknown mode", () => {
    expect(() => batchingMode("dynamic" as never)).toThrow(/Unknown Batching approach/);
    expect(BATCHING.approaches.map((a) => a.id)).toEqual(["static", "continuous"]);
  });
});

describe("batching in the engine", () => {
  it("under static batching a late arrival waits for the whole batch; under continuous batching it does not", () => {
    const worstTtft = (batching: "static" | "continuous") => {
      const w = world({ batching, maxPods: 1, minPods: 1, returnProb: 0, outputTokens: 400 });
      run(w, 5);
      spawnBurst(w, 4);
      run(w, 1.5);
      spawnBurst(w, 1);
      run(w, 120, () => w.m.completed === 5);
      return Math.max(...w.m.ttft);
    };
    expect(worstTtft("static")).toBeGreaterThan(3 * worstTtft("continuous"));
  });
});
