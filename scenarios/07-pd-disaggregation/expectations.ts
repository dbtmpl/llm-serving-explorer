import assert from "node:assert/strict";
import { selectFinalSummary, selectPods, type ReplayTimeline } from "../../web/src/replay/index.js";

export function assertExpectations(timeline: ReplayTimeline): void {
  const finalState = timeline.stateAt(timeline.durationUs);
  const summary = selectFinalSummary(finalState);
  assert.strictEqual(summary.completedRequests, 18, "expected 18 completed requests");

  const pods = selectPods(finalState);
  const prefillPods = new Set(pods.filter((p) => p.poolRole === "prefill").map((p) => p.podId));
  const decodePods = new Set(pods.filter((p) => p.poolRole === "decode").map((p) => p.podId));

  assert.strictEqual(prefillPods.size, 3, "expected 3 prefill pods");
  assert.strictEqual(decodePods.size, 1, "expected 1 decode pod");

  const routed = timeline.events.filter((e) => e.type === "request.routed");
  assert.strictEqual(routed.length, 18);
  for (const ev of routed) {
    if (ev.type !== "request.routed") continue;
    assert.strictEqual(ev.disaggregate, true, `expected disaggregate=true on ${ev.req_id}`);
    assert.ok(ev.prefill_pod && prefillPods.has(ev.prefill_pod), "expected valid prefill_pod");
    assert.ok(ev.decode_pod && decodePods.has(ev.decode_pod), "expected valid decode_pod");
  }

  const batchSteps = timeline.events.filter((e) => e.type === "batch.step");
  const prefillSteps = batchSteps.filter((e) => e.type === "batch.step" && prefillPods.has(e.pod_id));
  const decodeSteps = batchSteps.filter((e) => e.type === "batch.step" && decodePods.has(e.pod_id));
  assert.ok(prefillSteps.length > 0, "expected prefill pods to execute batch.step");
  assert.ok(decodeSteps.length > 0, "expected decode pod to execute batch.step");

  const transfers = timeline.events.filter((e) => e.type === "kv.transfer");
  const started = transfers.filter((e) => e.type === "kv.transfer" && e.status === "started");
  const completed = transfers.filter((e) => e.type === "kv.transfer" && e.status === "completed");
  assert.strictEqual(started.length, 18, "expected 18 kv.transfer started events");
  assert.strictEqual(completed.length, 18, "expected 18 kv.transfer completed events");
}
