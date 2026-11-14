import assert from "node:assert/strict";
import { selectFinalSummary, type ReplayTimeline } from "../../web/src/replay/index.js";

export function assertExpectations(timeline: ReplayTimeline): void {
  const finalState = timeline.stateAt(timeline.durationUs);
  const summary = selectFinalSummary(finalState);

  assert.strictEqual(summary.completedRequests, 24, "expected all 24 requests to eventually complete");

  const evicted = timeline.events.filter((e) => e.type === "kv.block.evicted");
  const preempted = timeline.events.filter((e) => e.type === "request.preempted");

  assert.ok(evicted.length > 0, "expected kv.block.evicted events > 0");
  assert.ok(preempted.length > 0, "expected request.preempted events > 0");
  assert.strictEqual(
    summary.preemptions,
    preempted.length,
    "expected summary.preemptions to match request.preempted count"
  );
}
