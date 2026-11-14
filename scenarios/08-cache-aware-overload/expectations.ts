import assert from "node:assert/strict";
import { selectFinalSummary, type ReplayTimeline } from "../../web/src/replay/index.js";

export function assertExpectations(timeline: ReplayTimeline, baseline?: ReplayTimeline): void {
  const finalState = timeline.stateAt(timeline.durationUs);
  const summary = selectFinalSummary(finalState);
  assert.strictEqual(summary.completedRequests, 60, "expected 60 completed requests");

  const queued = timeline.events.filter((e) => e.type === "request.queued");
  const maxQueueDepth = queued.reduce(
    (mx, e) => (e.type === "request.queued" ? Math.max(mx, e.queue_depth) : mx),
    0
  );
  assert.ok(maxQueueDepth >= 3, `expected non-zero queue buildup (>= 3), got maxQueueDepth=${maxQueueDepth}`);

  const routed = timeline.events.filter((e) => e.type === "request.routed");
  assert.strictEqual(routed.length, 60);

  const podCounts = new Map<string, number>();
  let maxCandidateLoadDiff = 0;

  for (const ev of routed) {
    if (ev.type !== "request.routed") continue;
    podCounts.set(ev.chosen_pod, (podCounts.get(ev.chosen_pod) ?? 0) + 1);
    if (ev.candidates && ev.candidates.length >= 2) {
      const loads = ev.candidates.map((c) => c.in_flight_requests ?? c.batch_size + c.queue_depth);
      const diff = Math.max(...loads) - Math.min(...loads);
      maxCandidateLoadDiff = Math.max(maxCandidateLoadDiff, diff);
    }
  }

  assert.ok(
    maxCandidateLoadDiff >= 10,
    `expected large candidate in-flight load imbalance during burst (>= 10), got ${maxCandidateLoadDiff}`
  );

  const counts = Array.from(podCounts.values());
  const maxPodReqs = Math.max(...counts);
  const minPodReqs = Math.min(...counts);
  assert.ok(
    maxPodReqs >= 3 * minPodReqs,
    `expected strong load skew across pods (max=${maxPodReqs}, min=${minPodReqs})`
  );

  if (baseline) {
    const baseRouted = baseline.events.filter((e) => e.type === "request.routed");
    const basePodCounts = new Map<string, number>();
    for (const ev of baseRouted) {
      if (ev.type === "request.routed") {
        basePodCounts.set(ev.chosen_pod, (basePodCounts.get(ev.chosen_pod) ?? 0) + 1);
      }
    }
    const baseCounts = Array.from(basePodCounts.values());
    const primaryRange = maxPodReqs - minPodReqs;
    const baseRange = Math.max(...baseCounts) - Math.min(...baseCounts);
    assert.ok(
      primaryRange > baseRange,
      `expected cache-affinity overload skew (${primaryRange}) > balanced baseline skew (${baseRange})`
    );
  }
}
