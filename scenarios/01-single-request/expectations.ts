import assert from "node:assert/strict";
import { selectFinalSummary, type ReplayTimeline } from "../../web/src/replay/index.js";

export function assertExpectations(timeline: ReplayTimeline): void {
  const finalState = timeline.stateAt(timeline.durationUs);
  const summary = selectFinalSummary(finalState);

  assert.strictEqual(summary.completedRequests, 1, "expected exactly 1 completed request");
  assert.strictEqual(summary.preemptions, 0, "expected 0 preemptions for a single request");

  const prefillEvents = timeline.events.filter((e) => e.type === "request.prefill");
  const decodeEvents = timeline.events.filter((e) => e.type === "request.decode_step");
  const allocEvents = timeline.events.filter((e) => e.type === "kv.block.allocated");
  const finishedEvents = timeline.events.filter((e) => e.type === "request.finished");

  assert.strictEqual(prefillEvents.length, 1, "expected 1 request.prefill event");
  assert.strictEqual(decodeEvents.length, 64, "expected 64 request.decode_step events");
  assert.ok(allocEvents.length > 0, "expected kv.block.allocated events > 0");
  assert.strictEqual(finishedEvents.length, 1, "expected 1 request.finished event");
  if (finishedEvents[0].type === "request.finished") {
    assert.strictEqual(finishedEvents[0].output_tokens, 64, "expected 64 output tokens");
  }
}
