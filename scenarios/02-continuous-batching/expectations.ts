import assert from "node:assert/strict";
import { selectFinalSummary, type ReplayTimeline } from "../../web/src/replay/index.js";

export function assertExpectations(timeline: ReplayTimeline, baseline?: ReplayTimeline): void {
  assert.ok(baseline, "expected baseline timeline for static vs continuous batching comparison");

  const primarySummary = selectFinalSummary(timeline.stateAt(timeline.durationUs));
  const baselineSummary = selectFinalSummary(baseline.stateAt(baseline.durationUs));

  assert.strictEqual(primarySummary.completedRequests, 12, "expected 12 completed requests in primary");
  assert.strictEqual(baselineSummary.completedRequests, 12, "expected 12 completed requests in baseline");

  assert.ok(
    primarySummary.outputTokS > 2.0 * baselineSummary.outputTokS,
    `expected continuous batching outputTokS (${primarySummary.outputTokS.toFixed(1)}) > 2x baseline (${baselineSummary.outputTokS.toFixed(1)})`
  );

  const batchSteps = timeline.events.filter((e) => e.type === "batch.step");
  const multiMemberSteps = batchSteps.filter((e) => e.type === "batch.step" && e.members.length > 1);
  const mixedSteps = batchSteps.filter((e) => e.type === "batch.step" && e.phase === "mixed");

  assert.ok(multiMemberSteps.length > 0, "expected batch.step events with members.length > 1");
  assert.ok(mixedSteps.length > 0, "expected mixed prefill+decode batch.step events (phase === 'mixed')");
}
