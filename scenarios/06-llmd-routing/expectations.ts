import assert from "node:assert/strict";
import { selectFinalSummary, type ReplayTimeline } from "../../web/src/replay/index.js";

export function assertExpectations(timeline: ReplayTimeline, baseline?: ReplayTimeline): void {
  const finalState = timeline.stateAt(timeline.durationUs);
  const summary = selectFinalSummary(finalState);
  assert.strictEqual(summary.completedRequests, 48, "expected 48 completed requests");

  const routed = timeline.events.filter((e) => e.type === "request.routed");
  assert.strictEqual(routed.length, 48, "expected 48 request.routed events");

  const distinctPods = new Set<string>();
  let differentiatedCount = 0;

  for (const ev of routed) {
    if (ev.type !== "request.routed") continue;
    distinctPods.add(ev.chosen_pod);
    assert.ok(ev.candidates, `expected candidates on ${ev.req_id}`);
    assert.strictEqual(ev.candidates.length, 4, `expected 4 candidate scores on ${ev.req_id}`);

    const scores = ev.candidates.map((c) => c.score);
    const spread = Math.max(...scores) - Math.min(...scores);
    if (spread > 0.01) {
      differentiatedCount += 1;
    }
  }

  assert.strictEqual(distinctPods.size, 4, `expected all 4 pods to receive requests, got ${distinctPods.size}`);
  assert.ok(
    differentiatedCount > 20,
    `expected candidate scores to differentiate pods on most decisions, got ${differentiatedCount}/48`
  );

  if (baseline) {
    const baseSummary = selectFinalSummary(baseline.stateAt(baseline.durationUs));
    assert.ok(
      summary.prefixCacheHitRate > baseSummary.prefixCacheHitRate,
      `expected prefix-aware routing hit rate (${summary.prefixCacheHitRate.toFixed(3)}) > load-only (${baseSummary.prefixCacheHitRate.toFixed(3)})`
    );
  }
}
