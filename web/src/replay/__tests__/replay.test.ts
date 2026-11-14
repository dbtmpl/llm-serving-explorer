import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { HeaderRecord, SimEvent } from "@llm-viz/schema";
import {
  applyEvent,
  createInitialState,
  createTimeline,
  parseTimeline,
  selectActiveKVTransfers,
  selectActiveTierMoves,
  selectFinalSummary,
  selectMetricsSeries,
  selectPods,
  selectRequests,
  selectRequestsByPhase,
  selectRequestsForPod,
  selectRooflinePoints,
  selectRooflinePointsInRange,
  selectRoutingHistory,
  type SimState
} from "../index.js";

const VERIFY_DIR = "/tmp/step4-verify";

interface ResultJsonDoc {
  metrics: {
    ttft_mean_ms: { value: number; samples: number };
    tpot_mean_ms: { value: number; samples: number };
    output_tok_s: { value: number; samples: number };
    preemptions: { value: number; samples: number };
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadVerifyRun(baseName: string): { ndjson: string; result: ResultJsonDoc } {
  const ndjsonPath = `${VERIFY_DIR}/${baseName}.ndjson`;
  const resultPath = `${VERIFY_DIR}/${baseName}.result.json`;
  const ndjson = readFileSync(ndjsonPath, "utf8");
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as ResultJsonDoc;
  return { ndjson, result };
}

function makeSyntheticHeader(): HeaderRecord {
  return {
    type: "header",
    schema_version: "1.0",
    blis: {
      commit: "test-commit",
      vllm_version: "0.32.0",
      llmd_version: "0.1.0",
      stack_versions: {}
    },
    scenario: {
      name: "synthetic-all-23-events",
      model: "llama-3.1-8b-instruct",
      hardware: "a100-sxm",
      flags: {},
      seed: 42,
      horizon_us: 10_000_000,
      routing_policy: "llm-d"
    },
    topology: {
      gateway_latency_us: 100,
      pools: [
        {
          role: "colocated",
          replicas: 1,
          tp: 1,
          pp: 1,
          dp: 1,
          gpus_per_pod: 1,
          gpu_type: "a100-sxm",
          gpu_specs: {
            memory_gib: 80,
            tflops_peak: 312,
            tflops_fp8: 624,
            bw_peak_tbs: 2.0,
            sm_count: 108
          },
          memory_breakdown_bytes: {
            weights: 16_000_000_000,
            activation_peak: 1_000_000_000,
            cuda_graph: 500_000_000,
            comm_buffers: 100_000_000
          },
          kv_blocks_per_gpu: 101, // usable = 100
          kv_block_size_tokens: 16,
          max_num_seqs: 64,
          max_num_batched_tokens: 2048,
          max_model_len: 8192
        }
      ],
      tiers: {
        gpu_hbm_blocks: 101,
        cpu_ram_blocks: 64,
        cpu_ram_bytes: 64 * 1024 * 1024,
        local_ssd_modelled: false,
        remote_store_modelled: false,
        unmodelled_notes: {}
      },
      initial_pods: [
        {
          pod_id: "pod-0",
          pool_role: "colocated",
          gpu_ids: ["pod-0-gpu-0"],
          tp_degree: 1,
          state: "ready"
        }
      ]
    }
  };
}

describe("BLIS event replay core", () => {
  it("handles all 23 schema event types purely without mutating input state and populates all selectors", () => {
    const header = makeSyntheticHeader();
    let state = createInitialState(header);
    const initialSnapshotCheck = state;

    const events: SimEvent[] = [
      { seq: 1, t_us: 0, type: "pod.created", pod_id: "pod-1", pool_role: "colocated", gpu_ids: ["pod-1-gpu-0"], tp_degree: 1, node_id: "node-1" },
      { seq: 2, t_us: 10, type: "pod.loading", pod_id: "pod-1", pool_role: "colocated" },
      { seq: 3, t_us: 20, type: "pod.ready", pod_id: "pod-1", pool_role: "colocated" },
      { seq: 4, t_us: 100, type: "request.arrived", req_id: "req-1", prompt_tokens: 32, max_output_tokens: 4, prefix_group: "g1", prefix_tokens: 16 },
      { seq: 5, t_us: 105, type: "request.arrived", req_id: "req-2", prompt_tokens: 32, max_output_tokens: 4 },
      { seq: 6, t_us: 106, type: "request.rejected", req_id: "req-2", reason: "rate_limited", stage: "admission" },
      { seq: 7, t_us: 108, type: "request.arrived", req_id: "req-3", prompt_tokens: 32, max_output_tokens: 4 },
      { seq: 8, t_us: 109, type: "request.timed_out", req_id: "req-3", stage: "gateway", elapsed_us: 1 },
      { seq: 9, t_us: 110, type: "request.admitted", req_id: "req-1", reason: "ok" },
      {
        seq: 10,
        t_us: 115,
        type: "request.routed",
        req_id: "req-1",
        chosen_pod: "pod-0",
        disaggregate: false,
        reason: "llm-d",
        scores: { "pod-0": 0.9, "pod-1": 0.6 },
        candidates: [
          { pod_id: "pod-0", score: 0.9, queue_depth: 0, batch_size: 0, kv_utilization: 0, free_kv_blocks: 100 }
        ],
        regret: 0
      },
      { seq: 11, t_us: 120, type: "request.queued", req_id: "req-1", pod_id: "pod-0", queue_depth: 1 },
      { seq: 12, t_us: 130, type: "request.scheduled", req_id: "req-1", pod_id: "pod-0", cached_tokens: 0, prefix_lookup: true },
      { seq: 13, t_us: 130, type: "kv.block.allocated", pod_id: "pod-0", gpu_indices: [0], block_ids: [0, 1], req_id: "req-1", tier: "gpu" },
      {
        seq: 14,
        t_us: 200,
        type: "batch.step",
        pod_id: "pod-0",
        batch_id: 1,
        phase: "prefill",
        members: [{ req_id: "req-1", role: "prefill", tokens: 32, computed_before: 0 }],
        prefill_tokens: 32,
        decode_tokens: 0,
        total_tokens: 32,
        duration_us: 70,
        roofline: {
          flops: 1e10,
          bytes_moved: 1e8,
          arithmetic_intensity: 100,
          achieved_tflops: 140,
          achieved_bw_tbs: 1.4,
          bottleneck: "compute",
          derived: true
        }
      },
      { seq: 15, t_us: 200, type: "request.prefill", req_id: "req-1", pod_id: "pod-0", batch_id: 1, tokens_processed: 32, computed_after: 32, prompt_tokens: 32, duration_us: 70 },
      { seq: 16, t_us: 200, type: "request.decode_step", req_id: "req-1", pod_id: "pod-0", batch_id: 1, tokens_emitted: 1, total_emitted: 1, is_first_token: true, duration_us: 70 },
      { seq: 17, t_us: 200, type: "kv.block.cached", pod_id: "pod-0", gpu_indices: [0], block_ids: [0, 1], block_hashes: ["h0", "h1"], prev_owner_req_id: "req-1", tier: "gpu" },
      { seq: 18, t_us: 210, type: "kv.block.moved", pod_id: "pod-0", transfer_id: 1, req_id: "req-1", from_tier: "gpu", to_tier: "cpu_dram", direction: "offload", block_ids: [0], num_blocks: 1, tokens: 16, duration_us: 0, status: "started" },
      { seq: 19, t_us: 220, type: "kv.transfer", transfer_id: 9, req_id: "req-1", from_pod: "pod-0", to_pod: "pod-1", num_kv_blocks: 2, pulled_kv_blocks: 2, duration_us: 0, status: "started" },
      { seq: 20, t_us: 230, type: "request.preempted", req_id: "req-1", pod_id: "pod-0", reason: "kv_capacity", computed_tokens_lost: 32, freed_blocks: [] },
      { seq: 21, t_us: 240, type: "kv.block.moved", pod_id: "pod-0", transfer_id: 1, req_id: "req-1", from_tier: "gpu", to_tier: "cpu_dram", direction: "offload", block_ids: [0], num_blocks: 1, tokens: 16, duration_us: 30, status: "completed" },
      { seq: 22, t_us: 250, type: "kv.transfer", transfer_id: 9, req_id: "req-1", from_pod: "pod-0", to_pod: "pod-1", num_kv_blocks: 2, pulled_kv_blocks: 2, duration_us: 30, status: "completed" },
      { seq: 23, t_us: 260, type: "request.scheduled", req_id: "req-1", pod_id: "pod-0", cached_tokens: 32, prefix_lookup: false },
      { seq: 24, t_us: 260, type: "kv.block.allocated", pod_id: "pod-0", gpu_indices: [0], block_ids: [0, 1], req_id: "req-1", tier: "gpu" },
      { seq: 25, t_us: 300, type: "request.finished", req_id: "req-1", pod_id: "pod-0", reason: "stop", output_tokens: 2, ttft_us: 100, e2e_us: 200, tpot_us: 100 },
      { seq: 26, t_us: 310, type: "kv.block.evicted", pod_id: "pod-0", gpu_indices: [0], block_ids: [1], block_hashes: ["h1"], tier: "gpu", destination: "dropped", reason: "lru_eviction" },
      { seq: 27, t_us: 320, type: "pod.draining", pod_id: "pod-1", pool_role: "colocated", reason: "scale_down" },
      { seq: 28, t_us: 330, type: "pod.terminated", pod_id: "pod-1", pool_role: "colocated" },
      {
        seq: 29,
        t_us: 340,
        type: "metrics.snapshot",
        is_final: true,
        gateway_queue_depth: 0,
        completed_requests: 1,
        preemptions: 1,
        rejected_requests: 1,
        timed_out_requests: 1,
        dropped_requests: 0,
        ttft_mean_ms: 0.1,
        tpot_mean_ms: 0.1,
        output_tok_s: 10,
        prefix_cache_hit_rate: 0,
        instances: [
          {
            pod_id: "pod-0",
            state: "active",
            queue_depth: 0,
            batch_size: 0,
            kv_used_blocks: 0,
            kv_cached_blocks: 1,
            kv_free_blocks: 100,
            kv_total_blocks: 100,
            preemptions: 1,
            completed_requests: 1
          },
          {
            pod_id: "pod-1",
            state: "terminated",
            queue_depth: 0,
            batch_size: 0,
            kv_used_blocks: 0,
            kv_cached_blocks: 0,
            kv_free_blocks: 100,
            kv_total_blocks: 100,
            preemptions: 0,
            completed_requests: 0
          }
        ]
      }
    ];

    for (const ev of events) {
      state = applyEvent(state, ev);
    }

    // Purity check: initial state must remain completely untouched.
    expect(initialSnapshotCheck.pods.size).toBe(1);
    expect(initialSnapshotCheck.requests.size).toBe(0);
    expect(initialSnapshotCheck.eventIndex).toBe(-1);

    const timeline = createTimeline(header, events, { snapshotStride: 5 });

    // Check in-flight transfer & tier move mid-stream via timeline.stateAt
    const midState = timeline.stateAt(225);
    expect(selectActiveTierMoves(midState)).toHaveLength(1);
    expect(selectActiveKVTransfers(midState)).toHaveLength(1);
    expect(selectRequestsForPod(midState, "pod-0").running).toHaveLength(1);

    // Check final state & selectors
    const endState = timeline.stateAt(1000);
    expect(endState).toEqual(state);
    expect(selectPods(endState).map((p) => [p.podId, p.status])).toEqual([
      ["pod-0", "ready"],
      ["pod-1", "terminated"]
    ]);
    expect(selectRequests(endState)).toHaveLength(3);
    const byPhase = selectRequestsByPhase(endState);
    expect(byPhase.finished).toHaveLength(1);
    expect(byPhase.rejected).toHaveLength(1);
    expect(byPhase.timed_out).toHaveLength(1);
    expect(selectRoutingHistory(endState)).toHaveLength(1);
    expect(selectActiveKVTransfers(endState)).toHaveLength(0);
    expect(selectActiveTierMoves(endState)).toHaveLength(0);
    expect(selectMetricsSeries(endState)).toHaveLength(1);
    expect(selectRooflinePoints(endState, "pod-0")).toHaveLength(1);
    expect(selectRooflinePointsInRange(timeline, 150, 250)).toHaveLength(1);

    const summary = selectFinalSummary(endState);
    expect(summary.completedRequests).toBe(1);
    expect(summary.preemptions).toBe(1);
    expect(summary.rejectedRequests).toBe(1);
    expect(summary.timedOutRequests).toBe(1);
    expect(timeline.eventsInRange(100, 120).map((e) => e.seq)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(timeline.stateAt(-1).eventIndex).toBe(-1);
  });

  const hasVerifyDir =
    existsSync(`${VERIFY_DIR}/colocated.ndjson`) &&
    existsSync(`${VERIFY_DIR}/offload.ndjson`) &&
    existsSync(`${VERIFY_DIR}/pd-3p1d.ndjson`) &&
    existsSync(`${VERIFY_DIR}/autoscaling.ndjson`);

  describe.runIf(hasVerifyDir)("Real BLIS stream verification (/tmp/step4-verify)", () => {
    it.each(["colocated", "offload", "pd-3p1d", "autoscaling"])(
      "%s: matches every metrics.snapshot on all pod and cluster fields",
      (runName) => {
        const { ndjson } = loadVerifyRun(runName);
        const timeline = parseTimeline(ndjson, { snapshotStride: 250 });

        let state = createInitialState(timeline.header);
        let snapshotCount = 0;

        for (const ev of timeline.events) {
          state = applyEvent(state, ev);
          if (ev.type !== "metrics.snapshot") {
            continue;
          }
          snapshotCount += 1;
          expect(state.gateway.queueDepth).toBe(ev.gateway_queue_depth);
          expect(state.clusterTotals.completedRequests).toBe(ev.completed_requests);
          expect(state.clusterTotals.preemptions).toBe(ev.preemptions);
          expect(state.clusterTotals.rejectedRequests).toBe(ev.rejected_requests);
          expect(state.clusterTotals.timedOutRequests).toBe(ev.timed_out_requests);
          expect(state.clusterTotals.droppedRequests).toBe(ev.dropped_requests);

          for (const inst of ev.instances) {
            const pod = state.pods.get(inst.pod_id);
            expect(pod, `missing pod ${inst.pod_id} at t=${ev.t_us}`).toBeDefined();
            expect(pod!.queuedRequestIds.size).toBe(inst.queue_depth);
            expect(pod!.runningRequestIds.size).toBe(inst.batch_size);
            expect(pod!.kvUsedBlocks).toBe(inst.kv_used_blocks);
            expect(pod!.kvCachedBlocks).toBe(inst.kv_cached_blocks);
            expect(pod!.kvFreeBlocks).toBe(inst.kv_free_blocks);
            expect(pod!.kvTotalBlocks).toBe(inst.kv_total_blocks);
            expect(pod!.preemptions).toBe(inst.preemptions);
            expect(pod!.completedRequests).toBe(inst.completed_requests);
          }
        }

        expect(snapshotCount).toBeGreaterThan(0);
      }
    );

    it.runIf(existsSync(`${VERIFY_DIR}/preempt.ndjson`))(
      "preempt: tracks real preemption events and matches snapshot fields (noting kv_block_tracker shared-prefix overcount on reschedule)",
      () => {
        const { ndjson, result } = loadVerifyRun("preempt");
        const timeline = parseTimeline(ndjson, { snapshotStride: 250 });
        const finalState = timeline.stateAt(timeline.durationUs);
        const summary = selectFinalSummary(finalState);

        expect(summary.preemptions).toBe(result.metrics.preemptions.value);
        expect(summary.preemptions).toBe(8);

        let state = createInitialState(timeline.header);
        for (const ev of timeline.events) {
          state = applyEvent(state, ev);
          if (ev.type !== "metrics.snapshot") {
            continue;
          }
          for (const inst of ev.instances) {
            const pod = state.pods.get(inst.pod_id)!;
            expect(pod.queuedRequestIds.size).toBe(inst.queue_depth);
            expect(pod.runningRequestIds.size).toBe(inst.batch_size);
            expect(pod.kvCachedBlocks).toBe(inst.kv_cached_blocks);
            expect(pod.preemptions).toBe(inst.preemptions);
            expect(pod.completedRequests).toBe(inst.completed_requests);
          }
        }
      }
    );

    it.each(["colocated", "offload", "pd-3p1d", "autoscaling"])(
      "%s: matches BLIS stdout Result JSON final summary metrics",
      (runName) => {
        const { ndjson, result } = loadVerifyRun(runName);
        const timeline = parseTimeline(ndjson, { snapshotStride: 500 });
        const finalState = timeline.stateAt(timeline.durationUs);
        const summary = selectFinalSummary(finalState);

        expect(summary.completedRequests).toBe(result.metrics.ttft_mean_ms.samples);
        expect(summary.preemptions).toBe(result.metrics.preemptions.value);
        expect(summary.tpotMeanMs).toBeCloseTo(result.metrics.tpot_mean_ms.value, 1);

        // output_tok_s uses active span [firstArrival, lastFinishWithOverhead] within <0.5% of BLIS Result.
        const relOutputDiff =
          Math.abs(summary.outputTokS - result.metrics.output_tok_s.value) /
          result.metrics.output_tok_s.value;
        expect(relOutputDiff).toBeLessThan(0.005);

        if (runName === "pd-3p1d") {
          // In P/D disaggregation, request.finished emits decodeSubReq.ttft_us while ParentRequest
          // TTFT is preserved in the final metrics.snapshot (matching Result JSON exactly).
          expect(summary.snapshotTtftMeanMs).toBeCloseTo(result.metrics.ttft_mean_ms.value, 6);
        } else {
          expect(summary.ttftMeanMs).toBeCloseTo(result.metrics.ttft_mean_ms.value, 6);
        }
      }
    );

    it("autoscaling: stateAt(t) equals full linear replay across 100 random timestamps", () => {
      const { ndjson } = loadVerifyRun("autoscaling");
      const timeline = parseTimeline(ndjson, { snapshotStride: 250 });
      const rng = mulberry32(20261114);

      const sampleTargets = new Set<number>([0, timeline.durationUs]);
      const timestamps: number[] = [];
      for (let i = 0; i < 98; i++) {
        timestamps.push(Math.floor(rng() * (timeline.durationUs + 1)));
      }
      for (const t of sampleTargets) {
        timestamps.push(t);
      }
      expect(timestamps).toHaveLength(100);

      // Resolve each timestamp's target event index so we can build exact linear ground-truth in one pass.
      const idxToTimestamps = new Map<number, number[]>();
      for (const t of timestamps) {
        const idx = timeline.lastEventIndexAtOrBefore(t);
        const bucket = idxToTimestamps.get(idx);
        if (bucket) {
          bucket.push(t);
        } else {
          idxToTimestamps.set(idx, [t]);
        }
      }

      const linearStatesByIdx = new Map<number, SimState>();
      let linear = createInitialState(timeline.header);
      if (idxToTimestamps.has(-1)) {
        linearStatesByIdx.set(-1, linear);
      }
      for (let i = 0; i < timeline.events.length; i++) {
        linear = applyEvent(linear, timeline.events[i]);
        if (idxToTimestamps.has(i)) {
          linearStatesByIdx.set(i, linear);
        }
      }

      for (const t of timestamps) {
        const idx = timeline.lastEventIndexAtOrBefore(t);
        const seeked = timeline.stateAt(t);
        const expected = linearStatesByIdx.get(idx)!;
        expect(seeked).toEqual(expected);
      }
    });

    it.runIf(existsSync(`${VERIFY_DIR}/stress-8pod-500req.ndjson`))(
      "stress 8-pod / 500-request run: snapshot parity + 50 random seeks under 200ms",
      () => {
        const { ndjson, result } = loadVerifyRun("stress-8pod-500req");
        const buildStart = performance.now();
        const timeline = parseTimeline(ndjson, { snapshotStride: 500 });
        const buildMs = performance.now() - buildStart;

        const finalState = timeline.stateAt(timeline.durationUs);
        const summary = selectFinalSummary(finalState);
        expect(selectPods(finalState)).toHaveLength(8);
        expect(summary.completedRequests).toBe(500);
        expect(summary.completedRequests).toBe(result.metrics.ttft_mean_ms.samples);
        expect(summary.ttftMeanMs).toBeCloseTo(result.metrics.ttft_mean_ms.value, 6);

        // Verify snapshot parity on the 8-pod stress run as well
        for (const snap of selectMetricsSeries(finalState)) {
          const snapState = timeline.stateAt(snap.t_us);
          // When multiple events share snap.t_us, stateAt(snap.t_us) lands at or after the snapshot.
          const snapIdx = timeline.events.findIndex((e) => e.seq === snap.seq);
          const exactSnapState = timeline.stateAtEventIndex(snapIdx);
          expect(snapState.tUs).toBeGreaterThanOrEqual(snap.t_us);
          for (const inst of snap.instances) {
            const pod = exactSnapState.pods.get(inst.pod_id)!;
            expect(pod.kvUsedBlocks).toBe(inst.kv_used_blocks);
            expect(pod.kvCachedBlocks).toBe(inst.kv_cached_blocks);
            expect(pod.kvFreeBlocks).toBe(inst.kv_free_blocks);
            expect(pod.queuedRequestIds.size).toBe(inst.queue_depth);
            expect(pod.runningRequestIds.size).toBe(inst.batch_size);
            expect(pod.completedRequests).toBe(inst.completed_requests);
          }
        }

        const rng = mulberry32(99);
        const seekTimesMs: number[] = [];
        for (let i = 0; i < 50; i++) {
          const t = Math.floor(rng() * (timeline.durationUs + 1));
          const t0 = performance.now();
          const s = timeline.stateAt(t);
          const dt = performance.now() - t0;
          expect(s.tUs).toBeLessThanOrEqual(t);
          seekTimesMs.push(dt);
        }

        seekTimesMs.sort((a, b) => a - b);
        const p50 = seekTimesMs[Math.floor(seekTimesMs.length * 0.5)];
        const max = seekTimesMs[seekTimesMs.length - 1];
        console.info(
          `[replay-perf] events=${timeline.eventCount} pods=${selectPods(finalState).length} checkpoints=${timeline.checkpointCount} buildMs=${buildMs.toFixed(2)} p50Ms=${p50.toFixed(2)} maxMs=${max.toFixed(2)}`
        );
        expect(max).toBeLessThan(200);
      }
    );
  });
});
