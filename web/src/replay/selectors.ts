import type { ReplayTimeline } from "./timeline.js";
import type {
  ActiveKVTransfer,
  ActiveTierMove,
  FinalSummaryMetrics,
  MetricsSeriesPoint,
  PodState,
  RequestLifecycleState,
  RequestPhaseName,
  RequestRoutingInfo,
  RooflineHistoryEntry,
  RunningRequestState,
  SimState
} from "./types.js";

const ALL_REQUEST_PHASES: readonly RequestPhaseName[] = [
  "arrived",
  "admitted",
  "routed",
  "queued",
  "scheduled",
  "prefill",
  "kv_transfer",
  "decode",
  "preempted",
  "finished",
  "rejected",
  "timed_out"
];

/**
 * Returns all pods present in the current simulation state.
 */
export function selectPods(state: SimState): PodState[] {
  return Array.from(state.pods.values());
}

/**
 * Returns requests from the current state. By default excludes internal P/D sub-requests
 * (`_prefill` / `_decode`); pass `{ includeSubRequests: true }` to include them.
 */
export function selectRequests(
  state: SimState,
  options: { includeSubRequests?: boolean } = {}
): RequestLifecycleState[] {
  const includeSub = options.includeSubRequests ?? false;
  const out: RequestLifecycleState[] = [];
  for (const req of state.requests.values()) {
    if (!includeSub && req.parentReqId !== undefined) {
      continue;
    }
    out.push(req);
  }
  return out;
}

/**
 * Returns queued and actively running requests assigned to `podId`.
 */
export function selectRequestsForPod(
  state: SimState,
  podId: string
): {
  podId: string;
  queued: RequestLifecycleState[];
  running: RunningRequestState[];
} {
  const pod = state.pods.get(podId);
  if (!pod) {
    return { podId, queued: [], running: [] };
  }

  const queued: RequestLifecycleState[] = [];
  for (const reqId of pod.queuedRequestIds) {
    const req = state.requests.get(reqId);
    if (req) {
      queued.push(req);
    }
  }

  const running: RunningRequestState[] = [];
  for (const reqId of pod.runningRequestIds) {
    const req = state.requests.get(reqId);
    const blockIds = pod.reqBlocks.get(reqId) ?? req?.allocatedBlockIds ?? [];
    running.push({
      reqId,
      podId,
      status: req?.status ?? "scheduled",
      promptTokens: req?.promptTokens ?? 0,
      computedTokens: req?.computedTokens ?? 0,
      emittedTokens: req?.emittedTokens ?? 0,
      maxOutputTokens: req?.maxOutputTokens ?? 0,
      blockIds
    });
  }

  return { podId, queued, running };
}

/**
 * Groups requests by their current lifecycle phase.
 */
export function selectRequestsByPhase(
  state: SimState,
  options: { includeSubRequests?: boolean } = {}
): Record<RequestPhaseName, RequestLifecycleState[]> {
  const grouped = {} as Record<RequestPhaseName, RequestLifecycleState[]>;
  for (const phase of ALL_REQUEST_PHASES) {
    grouped[phase] = [];
  }
  const includeSub = options.includeSubRequests ?? false;
  for (const req of state.requests.values()) {
    if (!includeSub && req.parentReqId !== undefined) {
      continue;
    }
    grouped[req.status].push(req);
  }
  return grouped;
}

/**
 * Returns gateway routing decisions ordered chronologically by `tUs`.
 */
export function selectRoutingHistory(
  state: SimState
): Array<RequestRoutingInfo & { readonly reqId: string }> {
  const decisions: Array<RequestRoutingInfo & { readonly reqId: string }> = [];
  for (const req of state.requests.values()) {
    if (req.routing !== undefined) {
      decisions.push({
        reqId: req.reqId,
        ...req.routing
      });
    }
  }
  decisions.sort((a, b) => a.tUs - b.tUs);
  return decisions;
}

/**
 * Returns currently in-flight inter-pod KV cache transfers (for P/D disaggregation).
 */
export function selectActiveKVTransfers(state: SimState): ActiveKVTransfer[] {
  return Array.from(state.activeTransfers.values());
}

/**
 * Returns currently in-flight GPU <-> CPU DRAM tier moves.
 */
export function selectActiveTierMoves(state: SimState): ActiveTierMove[] {
  return Array.from(state.activeTierMoves.values());
}

/**
 * Returns the time-series of `metrics.snapshot` records observed up to `state.tUs`.
 */
export function selectMetricsSeries(state: SimState): readonly MetricsSeriesPoint[] {
  return state.metricsSeries;
}

/**
 * Returns recent roofline step points from `state` (optionally filtered to a single pod).
 */
export function selectRooflinePoints(
  state: SimState,
  podId?: string
): readonly RooflineHistoryEntry[] {
  if (podId !== undefined) {
    return state.pods.get(podId)?.recentRoofline ?? [];
  }
  return state.recentRoofline;
}

/**
 * Extracts all roofline points from `timeline` inside `[from_us, to_us]`.
 */
export function selectRooflinePointsInRange(
  timeline: ReplayTimeline,
  from_us: number,
  to_us: number,
  podId?: string
): RooflineHistoryEntry[] {
  const events = timeline.eventsInRange(from_us, to_us);
  const out: RooflineHistoryEntry[] = [];
  for (const ev of events) {
    if (ev.type !== "batch.step") {
      continue;
    }
    if (podId !== undefined && ev.pod_id !== podId) {
      continue;
    }
    out.push({
      tUs: ev.t_us,
      podId: ev.pod_id,
      batchId: ev.batch_id,
      phase: ev.phase,
      totalTokens: ev.total_tokens,
      prefillTokens: ev.prefill_tokens,
      decodeTokens: ev.decode_tokens,
      durationUs: ev.duration_us,
      roofline: ev.roofline
    });
  }
  return out;
}

/**
 * Computes summary metrics from the replayed state, alongside any authoritative BLIS snapshot values.
 */
export function selectFinalSummary(state: SimState): FinalSummaryMetrics {
  const totals = state.clusterTotals;
  const ttftMeanMs = totals.ttftCount > 0 ? totals.ttftSumUs / totals.ttftCount / 1000 : 0;
  const tpotMeanMs = totals.tpotCount > 0 ? totals.tpotSumUs / totals.tpotCount / 1000 : 0;

  let outputTokS = 0;
  const startUs = totals.firstArrivalUs ?? 0;
  const endUs = totals.lastFinishWithOverheadUs ?? totals.lastFinishUs ?? state.tUs;
  const spanUs = endUs - startUs;
  if (spanUs > 0 && totals.totalOutputTokens > 0) {
    outputTokS = totals.totalOutputTokens / (spanUs / 1_000_000);
  }

  const prefixCacheHitRate =
    totals.prefixQueryTokens > 0
      ? Math.min(1, Math.max(0, totals.prefixHitTokens / totals.prefixQueryTokens))
      : (state.latestSnapshot?.prefix_cache_hit_rate ?? 0);

  return {
    completedRequests: totals.completedRequests,
    preemptions: totals.preemptions,
    rejectedRequests: totals.rejectedRequests,
    timedOutRequests: totals.timedOutRequests,
    droppedRequests: totals.droppedRequests,
    ttftMeanMs,
    tpotMeanMs,
    outputTokS,
    snapshotOutputTokS: state.latestSnapshot?.output_tok_s,
    snapshotTtftMeanMs: state.latestSnapshot?.ttft_mean_ms,
    snapshotTpotMeanMs: state.latestSnapshot?.tpot_mean_ms,
    prefixCacheHitRate,
    durationUs: state.tUs
  };
}
