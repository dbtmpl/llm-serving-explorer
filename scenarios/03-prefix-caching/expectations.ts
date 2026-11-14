import assert from "node:assert/strict";
import { selectFinalSummary, type ReplayTimeline } from "../../web/src/replay/index.js";

export function assertExpectations(timeline: ReplayTimeline, baseline?: ReplayTimeline): void {
  const finalState = timeline.stateAt(timeline.durationUs);
  const summary = selectFinalSummary(finalState);
  assert.strictEqual(summary.completedRequests, 8, "expected 8 completed requests");
  assert.ok(summary.prefixCacheHitRate > 0, `expected prefixCacheHitRate > 0, got ${summary.prefixCacheHitRate}`);

  const scheduled = timeline.events.filter((e) => e.type === "request.scheduled");
  const hits = scheduled.filter((e) => e.type === "request.scheduled" && e.cached_tokens > 0);
  const cachedEvents = timeline.events.filter((e) => e.type === "kv.block.cached");

  assert.ok(hits.length >= 6, `expected multiple requests with cached_tokens > 0, got ${hits.length}`);
  assert.ok(cachedEvents.length > 0, "expected kv.block.cached events > 0");

  const finished = timeline.events
    .filter((e) => e.type === "request.finished")
    .map((e) => (e.type === "request.finished" ? e : null))
    .filter((e): e is NonNullable<typeof e> => e !== null);

  const first = finished.find((f) => f.req_id === "request_0");
  const later = finished.filter((f) => f.req_id !== "request_0");
  assert.ok(first, "expected request_0 finished event");
  assert.ok(later.length > 0, "expected later finished events");
  assert.ok(
    later.every((f) => f.ttft_us < first.ttft_us),
    `expected all warm requests to have TTFT < first request (${first.ttft_us} us)`
  );

  if (baseline) {
    const baseSummary = selectFinalSummary(baseline.stateAt(baseline.durationUs));
    assert.ok(
      summary.ttftMeanMs < baseSummary.ttftMeanMs,
      `expected prefix caching TTFT (${summary.ttftMeanMs.toFixed(2)} ms) < baseline (${baseSummary.ttftMeanMs.toFixed(2)} ms)`
    );
  }
}
