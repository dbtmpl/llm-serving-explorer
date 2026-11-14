import assert from "node:assert/strict";
import { selectFinalSummary, selectPods, type ReplayTimeline } from "../../web/src/replay/index.js";

export function assertExpectations(timeline: ReplayTimeline): void {
  const finalState = timeline.stateAt(timeline.durationUs);
  const summary = selectFinalSummary(finalState);
  assert.ok(summary.completedRequests >= 60, `expected >= 60 completed requests, got ${summary.completedRequests}`);

  const requiredLifecycle = [
    "pod.created",
    "pod.loading",
    "pod.ready",
    "pod.draining",
    "pod.terminated"
  ] as const;

  for (const evType of requiredLifecycle) {
    const count = timeline.events.filter((e) => e.type === evType).length;
    assert.ok(count > 0, `expected at least one ${evType} event, got ${count}`);
  }

  const pods = selectPods(finalState);
  assert.ok(pods.length >= 2, `expected at least 2 pods in lifecycle history, got ${pods.length}`);
  assert.ok(
    pods.some((p) => p.status === "terminated"),
    "expected at least one pod to reach 'terminated' status"
  );
  assert.ok(
    pods.some((p) => p.status === "ready"),
    "expected at least one pod to remain 'ready'"
  );
}
