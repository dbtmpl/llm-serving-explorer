import assert from "node:assert/strict";
import { selectFinalSummary, type ReplayTimeline } from "../../web/src/replay/index.js";

export function assertExpectations(timeline: ReplayTimeline): void {
  const finalState = timeline.stateAt(timeline.durationUs);
  const summary = selectFinalSummary(finalState);

  assert.strictEqual(summary.completedRequests, 45, "expected 45 completed requests");
  assert.ok(timeline.header.topology.tiers.cpu_ram_blocks > 0, "expected cpu_ram_blocks > 0 in header");
  assert.strictEqual(timeline.header.topology.tiers.local_ssd_modelled, false);
  assert.strictEqual(timeline.header.topology.tiers.remote_store_modelled, false);

  const moved = timeline.events.filter((e) => e.type === "kv.block.moved");
  const offloads = moved.filter((e) => e.type === "kv.block.moved" && e.direction === "offload");
  const loads = moved.filter((e) => e.type === "kv.block.moved" && e.direction === "load");

  assert.ok(offloads.length > 0, "expected kv.block.moved with direction='offload' > 0");
  assert.ok(loads.length > 0, "expected kv.block.moved with direction='load' > 0");
}
