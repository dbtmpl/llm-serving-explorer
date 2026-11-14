import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "../../core/params.js";
import { run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { AUTOSCALER } from "../index.js";

const signal = { inFlight: 100, targetPerPod: 12, minPods: 0, maxPods: 16 };

describe("target-concurrency autoscaling (Knative; llm-d with KEDA)", () => {
  it("wants ceil(inFlight / targetPerPod) pods: 100 requests at 12 per pod is 9", () => {
    expect(AUTOSCALER.desiredPods(signal)).toBe(9);
    expect(AUTOSCALER.desiredPods({ ...signal, inFlight: 12 })).toBe(1);
    expect(AUTOSCALER.desiredPods({ ...signal, inFlight: 13 })).toBe(2);
  });
  it("stays within the configured bounds, and scales to zero when allowed", () => {
    expect(AUTOSCALER.desiredPods({ ...signal, inFlight: 10000 })).toBe(16);
    expect(AUTOSCALER.desiredPods({ ...signal, inFlight: 0 })).toBe(0);
    expect(AUTOSCALER.desiredPods({ ...signal, inFlight: 0, minPods: 2 })).toBe(2);
  });
});

describe("autoscaling in the engine", () => {
  it("starts from zero pods and creates one for the first request", () => {
    const w = world({ returnProb: 0 });
    expect(w.pods.length).toBe(0);
    spawnBurst(w, 1);
    run(w, 30, () => w.m.completed === 1);
    const order = w.events.map((e) => e.kind);
    expect(order.indexOf("pod.created")).toBeGreaterThan(-1);
    expect(order.indexOf("pod.ready")).toBeLessThan(order.indexOf("req.routed"));
    // the first request pays for the cold start
    expect(w.m.ttft[0]!).toBeGreaterThan(DEFAULT_PARAMS.coldStartS);
  });
  it("100 requests at once scale to 9 pods, and every request finishes", () => {
    const w = world({ returnProb: 0 });
    spawnBurst(w, 100);
    run(w, 1);
    expect(w.pods.length).toBe(9);
    run(w, 120, () => w.m.completed === 100);
    expect(w.m.completed).toBe(100);
  });
  it("10,000 sessions stay within the pod cap, queue at the router and keep making progress", () => {
    const w = world({ returnProb: 0 });
    spawnBurst(w, 10000);
    const started = performance.now();
    run(w, 6);
    expect(performance.now() - started).toBeLessThan(4000);
    expect(w.pods.length).toBe(DEFAULT_PARAMS.maxPods);
    expect(w.m.completed).toBeGreaterThan(100);
    expect(w.gatewayQueue.length).toBeGreaterThan(8000);
  });
});
