import { describe, expect, it } from "vitest";
import { run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { costPerMTok, median } from "../selectors.js";
import { setParam } from "../tick.js";

describe("request lifecycle", () => {
  it("a request passes every stage in order and completes", () => {
    const w = world({ returnProb: 0 });
    spawnBurst(w, 1);
    run(w, 30, () => w.m.completed === 1);
    expect(w.m.completed).toBe(1);
    const order = w.events.map((e) => e.kind);
    const stages = ["req.new", "req.tokenized", "req.queued", "req.routed", "req.admitted", "req.firstToken", "req.done"];
    for (let i = 1; i < stages.length; i++) expect(order.indexOf(stages[i]!), stages[i]).toBeGreaterThan(order.indexOf(stages[i - 1]!));
  });
  it("every request is accounted for: completed plus failed plus in flight equals created", () => {
    const w = world({ maxPods: 2, shedAfterS: 5, arrivalRate: 4 });
    spawnBurst(w, 60);
    run(w, 40);
    const created = w.events.filter((e) => e.kind === "req.new").length;
    expect(w.m.completed + w.m.failed + w.reqs.size).toBe(created);
  });
});

describe("step scheduling (vLLM scheduler; Sarathi-Serve)", () => {
  it("never puts more sequences in a step than max_num_seqs, nor more prefill tokens than the budget", () => {
    const w = world({ maxPods: 1, maxNumSeqs: 8, tokenBudget: 4096, promptTokens: 9000, returnProb: 0 });
    spawnBurst(w, 30);
    for (let i = 0; i < 400; i++) {
      run(w, 0.05);
      const pod = w.pods[0];
      if (!pod?.last) continue;
      expect(pod.running.length).toBeLessThanOrEqual(8);
      expect(pod.last.batch).toBeLessThanOrEqual(8);
      expect(pod.last.prefillTok + pod.last.batch).toBeLessThanOrEqual(4096 + 8);
    }
  });
  it("a long prompt is prefilled in chunks that share steps with running decodes", () => {
    const w = world({ maxPods: 1, minPods: 1, promptTokens: 30000, outputTokens: 400, returnProb: 0 });
    run(w, 4);
    spawnBurst(w, 3);
    run(w, 6);
    spawnBurst(w, 1);
    run(w, 60, () => w.m.completed === 4);
    expect(w.events.some((e) => e.kind === "step.mixed")).toBe(true);
  });
});

describe("changing parameters mid-run", () => {
  it("changing the model restarts the fleet and still serves every request", () => {
    const w = world({ returnProb: 0 });
    spawnBurst(w, 10);
    run(w, 3);
    setParam(w, "model", "llama-3-70b");
    setParam(w, "tp", 4);
    run(w, 200, () => w.m.completed === 10);
    expect(w.m.completed).toBe(10);
    expect(w.pods.every((p) => p.spec.tp === 4)).toBe(true);
  });
  it("a model that does not fit its GPUs fails to start instead of serving", () => {
    const w = world({ model: "llama-3-70b", tp: 1 });
    spawnBurst(w, 1);
    run(w, 10);
    expect(w.pods[0]!.state).toBe("failed");
  });
});

describe("summaries", () => {
  it("median is the upper median, and 0 for no data", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(median([])).toBe(0);
  });
  it("cost per million tokens is GPU-seconds at the hourly price over tokens emitted", () => {
    const w = world({ pricePerGpuHour: 2.5 });
    w.m.gpuSeconds = 16 * 60;
    w.m.tokensOut = 500_000;
    expect(costPerMTok(w)).toBeCloseTo(1.333, 3);
  });
});
