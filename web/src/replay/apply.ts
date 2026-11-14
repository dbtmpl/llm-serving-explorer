import type {
  HeaderRecord,
  PoolConfig,
  SimEvent
} from "@llm-viz/schema";
import type {
  ActiveKVTransfer,
  ActiveTierMove,
  ClusterTotals,
  GatewayState,
  KVBlockSlotState,
  PodLifecycleStatus,
  PodState,
  PoolRole,
  RequestLifecycleState,
  RequestPhaseName,
  RequestPhaseSpan,
  RooflineHistoryEntry,
  SimState
} from "./types.js";

export const DEFAULT_MAX_ROOFLINE_HISTORY = 256;

const EMPTY_OWNERS: readonly string[] = Object.freeze([]);
const EMPTY_BLOCKS: readonly number[] = Object.freeze([]);

function findPoolForRole(header: HeaderRecord, role: PoolRole): PoolConfig {
  return header.topology.pools.find((p) => p.role === role) ?? header.topology.pools[0];
}

function usableKVBlocksFromPool(pool: PoolConfig): number {
  // blis-vllm reserves block 0 as a null guard block, so usable TotalKVBlocks() = kv_blocks_per_gpu - 1.
  return pool.kv_blocks_per_gpu > 1 ? pool.kv_blocks_per_gpu - 1 : Math.max(0, pool.kv_blocks_per_gpu);
}

function createPodState(
  header: HeaderRecord,
  podId: string,
  poolRole: PoolRole,
  gpuIds: readonly string[],
  tpDegree: number,
  status: PodLifecycleStatus,
  createdAtUs: number,
  nodeId?: string
): PodState {
  const pool = findPoolForRole(header, poolRole);
  const kvTotalBlocks = usableKVBlocksFromPool(pool);
  return {
    podId,
    poolRole,
    gpuIds,
    tpDegree,
    nodeId,
    status,
    createdAtUs,
    readyAtUs: status === "ready" ? createdAtUs : undefined,
    kvBlockSizeTokens: Math.max(1, pool.kv_block_size_tokens),
    kvTotalBlocks,
    kvUsedBlocks: 0,
    kvCachedBlocks: 0,
    kvFreeBlocks: kvTotalBlocks,
    cpuTotalBlocks: Math.max(0, header.topology.tiers.cpu_ram_blocks),
    cpuUsedBlocks: 0,
    queuedRequestIds: new Set<string>(),
    runningRequestIds: new Set<string>(),
    kvBlocks: new Map<number, KVBlockSlotState>(),
    gpuCachedByHash: new Map<string, number>(),
    cpuBlocks: new Map<number, KVBlockSlotState>(),
    cpuCachedByHash: new Map<string, number>(),
    reqBlocks: new Map<string, readonly number[]>(),
    pendingCacheHitBlocks: new Map<string, number>(),
    preemptions: 0,
    completedRequests: 0,
    totalOutputTokens: 0,
    recentRoofline: []
  };
}

/**
 * Clones a single PodState's mutable containers while sharing immutable leaf entries.
 */
export function clonePodState(pod: PodState): PodState {
  return {
    ...pod,
    queuedRequestIds: new Set(pod.queuedRequestIds),
    runningRequestIds: new Set(pod.runningRequestIds),
    kvBlocks: new Map(pod.kvBlocks),
    gpuCachedByHash: new Map(pod.gpuCachedByHash),
    cpuBlocks: new Map(pod.cpuBlocks),
    cpuCachedByHash: new Map(pod.cpuCachedByHash),
    reqBlocks: new Map(pod.reqBlocks),
    pendingCacheHitBlocks: new Map(pod.pendingCacheHitBlocks),
    recentRoofline: pod.recentRoofline.slice()
  };
}

/**
 * Fast structural clone of SimState for timeline checkpoints and isolated forward replay.
 * Immutable leaf records (KVBlockSlotState, RequestLifecycleState, RequestPhaseSpan,
 * MetricsSnapshotEvent, RooflineHistoryEntry) are safely shared across clones.
 */
export function cloneState(state: SimState): SimState {
  const pods = new Map<string, PodState>();
  for (const [id, pod] of state.pods) {
    pods.set(id, clonePodState(pod));
  }
  return {
    tUs: state.tUs,
    lastSeq: state.lastSeq,
    eventIndex: state.eventIndex,
    header: state.header,
    pods,
    requests: new Map(state.requests),
    gateway: { ...state.gateway },
    clusterTotals: { ...state.clusterTotals },
    activeTransfers: new Map(state.activeTransfers),
    activeTierMoves: new Map(state.activeTierMoves),
    metricsSeries: state.metricsSeries.slice(),
    latestSnapshot: state.latestSnapshot,
    recentRoofline: state.recentRoofline.slice()
  };
}

/**
 * Initializes deterministic simulation state from the stream HeaderRecord.
 */
export function createInitialState(header: HeaderRecord): SimState {
  const pods = new Map<string, PodState>();
  for (const initPod of header.topology.initial_pods) {
    pods.set(
      initPod.pod_id,
      createPodState(
        header,
        initPod.pod_id,
        initPod.pool_role,
        initPod.gpu_ids,
        initPod.tp_degree,
        initPod.state,
        0
      )
    );
  }

  const gateway: GatewayState = {
    queueDepth: 0,
    totalArrived: 0,
    totalAdmitted: 0,
    totalRejected: 0,
    totalTimedOut: 0
  };

  const clusterTotals: ClusterTotals = {
    completedRequests: 0,
    preemptions: 0,
    rejectedRequests: 0,
    timedOutRequests: 0,
    droppedRequests: 0,
    totalOutputTokens: 0,
    ttftSumUs: 0,
    ttftCount: 0,
    tpotSumUs: 0,
    tpotCount: 0,
    prefixQueryTokens: 0,
    prefixHitTokens: 0
  };

  return {
    tUs: 0,
    lastSeq: 0,
    eventIndex: -1,
    header,
    pods,
    requests: new Map<string, RequestLifecycleState>(),
    gateway,
    clusterTotals,
    activeTransfers: new Map<string, ActiveKVTransfer>(),
    activeTierMoves: new Map<string, ActiveTierMove>(),
    metricsSeries: [],
    recentRoofline: []
  };
}

function parseSubRequestRelation(reqId: string): { parentReqId?: string; subRole?: "prefill" | "decode" } {
  if (reqId.endsWith("_prefill")) {
    return { parentReqId: reqId.slice(0, -"_prefill".length), subRole: "prefill" };
  }
  if (reqId.endsWith("_decode")) {
    return { parentReqId: reqId.slice(0, -"_decode".length), subRole: "decode" };
  }
  return {};
}

function appendOrExtendPhase(
  phases: readonly RequestPhaseSpan[],
  phase: RequestPhaseName,
  startUs: number,
  endUs?: number,
  podId?: string
): readonly RequestPhaseSpan[] {
  const next = phases.slice();
  const last = next.length > 0 ? next[next.length - 1] : undefined;
  if (last && last.phase === phase && last.podId === podId && (phase === "prefill" || phase === "decode")) {
    next[next.length - 1] = {
      ...last,
      endUs: endUs ?? startUs
    };
    return next;
  }
  if (last && last.endUs === undefined) {
    next[next.length - 1] = {
      ...last,
      endUs: startUs
    };
  }
  next.push({
    phase,
    startUs,
    endUs,
    podId
  });
  return next;
}

function ensureRequest(
  state: SimState,
  reqId: string,
  tUs: number,
  fallbackStatus: RequestPhaseName = "arrived"
): RequestLifecycleState {
  const existing = state.requests.get(reqId);
  if (existing) {
    return existing;
  }
  const rel = parseSubRequestRelation(reqId);
  const parent = rel.parentReqId ? state.requests.get(rel.parentReqId) : undefined;
  return {
    reqId,
    parentReqId: rel.parentReqId,
    subRole: rel.subRole,
    promptTokens: parent?.promptTokens ?? 0,
    maxOutputTokens: parent?.maxOutputTokens ?? 0,
    prefixGroup: parent?.prefixGroup,
    prefixTokens: parent?.prefixTokens,
    sloClass: parent?.sloClass,
    sessionId: parent?.sessionId,
    status: fallbackStatus,
    arrivedAtUs: parent?.arrivedAtUs ?? tUs,
    prefillPod: parent?.prefillPod,
    decodePod: parent?.decodePod,
    computedTokens: 0,
    emittedTokens: 0,
    cachedTokens: 0,
    cpuHitTokens: 0,
    preemptionCount: 0,
    allocatedBlockIds: EMPTY_BLOCKS,
    phases: [{ phase: fallbackStatus, startUs: tUs }]
  };
}

function getOrCreatePod(
  state: SimState,
  podId: string,
  poolRole: PoolRole,
  tUs: number,
  copyOnWrite: boolean
): PodState {
  let pod = state.pods.get(podId);
  if (!pod) {
    pod = createPodState(state.header, podId, poolRole, [`${podId}-gpu-0`], 1, "loading", tUs);
    state.pods.set(podId, pod);
    return pod;
  }
  if (copyOnWrite) {
    const cloned = clonePodState(pod);
    state.pods.set(podId, cloned);
    return cloned;
  }
  return pod;
}

function getPodForMutation(state: SimState, podId: string, copyOnWrite: boolean): PodState | undefined {
  const pod = state.pods.get(podId);
  if (!pod) {
    return undefined;
  }
  if (copyOnWrite) {
    const cloned = clonePodState(pod);
    state.pods.set(podId, cloned);
    return cloned;
  }
  return pod;
}

function releaseReqBlocks(pod: PodState, reqId: string): void {
  const held = pod.reqBlocks.get(reqId);
  if (!held || held.length === 0) {
    pod.reqBlocks.delete(reqId);
    return;
  }
  pod.reqBlocks.delete(reqId);
  for (const bid of held) {
    const existing = pod.kvBlocks.get(bid);
    if (!existing) {
      continue;
    }
    const nextOwners = existing.ownerReqIds.filter((id) => id !== reqId);
    if (nextOwners.length === 0) {
      pod.kvUsedBlocks = Math.max(0, pod.kvUsedBlocks - 1);
      if (existing.hash !== undefined) {
        pod.kvBlocks.set(bid, {
          ...existing,
          status: "cached",
          ownerReqIds: EMPTY_OWNERS
        });
      } else {
        pod.kvBlocks.delete(bid);
      }
    } else {
      pod.kvBlocks.set(bid, {
        ...existing,
        ownerReqIds: nextOwners
      });
    }
  }
  pod.kvFreeBlocks = Math.max(0, pod.kvTotalBlocks - pod.kvUsedBlocks);
}

function pushRooflineBounded<T>(arr: T[], entry: T, maxLen: number): void {
  arr.push(entry);
  if (arr.length > maxLen) {
    arr.splice(0, arr.length - maxLen);
  }
}

function syncPodKVFree(pod: PodState): void {
  pod.kvFreeBlocks = Math.max(0, pod.kvTotalBlocks - pod.kvUsedBlocks);
}

function applyEventInternal(
  state: SimState,
  event: SimEvent,
  copyOnWrite: boolean,
  maxRooflineHistory: number
): void {
  state.tUs = event.t_us;
  state.lastSeq = event.seq;
  state.eventIndex += 1;

  switch (event.type) {
    case "pod.created": {
      const existing = state.pods.get(event.pod_id);
      if (!existing) {
        state.pods.set(
          event.pod_id,
          createPodState(
            state.header,
            event.pod_id,
            event.pool_role,
            event.gpu_ids,
            event.tp_degree,
            "loading",
            event.t_us,
            event.node_id
          )
        );
      } else {
        const pod = copyOnWrite ? clonePodState(existing) : existing;
        pod.poolRole = event.pool_role;
        pod.gpuIds = event.gpu_ids;
        pod.tpDegree = event.tp_degree;
        if (event.node_id !== undefined) {
          pod.nodeId = event.node_id;
        }
        state.pods.set(event.pod_id, pod);
      }
      return;
    }

    case "pod.loading": {
      const pod = getOrCreatePod(state, event.pod_id, event.pool_role, event.t_us, copyOnWrite);
      pod.status = "loading";
      return;
    }

    case "pod.ready": {
      const pod = getOrCreatePod(state, event.pod_id, event.pool_role, event.t_us, copyOnWrite);
      pod.status = "ready";
      if (pod.readyAtUs === undefined) {
        pod.readyAtUs = event.t_us;
      }
      return;
    }

    case "pod.draining": {
      const pod = getOrCreatePod(state, event.pod_id, event.pool_role, event.t_us, copyOnWrite);
      pod.status = "draining";
      if (pod.drainingAtUs === undefined) {
        pod.drainingAtUs = event.t_us;
      }
      if (event.reason !== undefined) {
        pod.drainReason = event.reason;
      }
      return;
    }

    case "pod.terminated": {
      const pod = getOrCreatePod(state, event.pod_id, event.pool_role, event.t_us, copyOnWrite);
      pod.status = "terminated";
      pod.terminatedAtUs = event.t_us;
      return;
    }

    case "request.arrived": {
      const req: RequestLifecycleState = {
        reqId: event.req_id,
        promptTokens: event.prompt_tokens,
        maxOutputTokens: event.max_output_tokens,
        prefixGroup: event.prefix_group,
        prefixTokens: event.prefix_tokens,
        blockHashes: event.block_hashes,
        sloClass: event.slo_class,
        sessionId: event.session_id,
        status: "arrived",
        arrivedAtUs: event.t_us,
        computedTokens: 0,
        emittedTokens: 0,
        cachedTokens: 0,
        cpuHitTokens: 0,
        preemptionCount: 0,
        allocatedBlockIds: EMPTY_BLOCKS,
        phases: [{ phase: "arrived", startUs: event.t_us }]
      };
      state.requests.set(event.req_id, req);
      state.gateway.totalArrived += 1;
      state.gateway.queueDepth += 1;
      if (state.clusterTotals.firstArrivalUs === undefined || event.t_us < state.clusterTotals.firstArrivalUs) {
        state.clusterTotals.firstArrivalUs = event.t_us;
      }
      return;
    }

    case "request.admitted": {
      const req = ensureRequest(state, event.req_id, event.t_us, "arrived");
      state.requests.set(event.req_id, {
        ...req,
        status: "admitted",
        admittedAtUs: event.t_us,
        phases: appendOrExtendPhase(req.phases, "admitted", event.t_us)
      });
      state.gateway.totalAdmitted += 1;
      state.gateway.queueDepth = Math.max(0, state.gateway.queueDepth - 1);
      return;
    }

    case "request.rejected": {
      const req = ensureRequest(state, event.req_id, event.t_us, "arrived");
      const wasAtGateway = req.admittedAtUs === undefined && req.routedAtUs === undefined;
      state.requests.set(event.req_id, {
        ...req,
        status: "rejected",
        rejectedAtUs: event.t_us,
        rejectReason: event.reason,
        rejectStage: event.stage,
        phases: appendOrExtendPhase(req.phases, "rejected", event.t_us, event.t_us)
      });
      if (wasAtGateway) {
        state.gateway.queueDepth = Math.max(0, state.gateway.queueDepth - 1);
      }
      if (event.stage === "unservable") {
        state.clusterTotals.droppedRequests += 1;
      } else if (event.stage === "decode_kv") {
        state.clusterTotals.droppedRequests += 1;
        // Release any prefill blocks retained for this parent request if decode rejected it.
        const prefillId = `${event.req_id}_prefill`;
        if (req.prefillPod) {
          const pod = getPodForMutation(state, req.prefillPod, copyOnWrite);
          if (pod) {
            releaseReqBlocks(pod, prefillId);
            releaseReqBlocks(pod, event.req_id);
          }
        }
      } else {
        state.clusterTotals.rejectedRequests += 1;
        state.gateway.totalRejected += 1;
      }
      return;
    }

    case "request.routed": {
      const req = ensureRequest(state, event.req_id, event.t_us, "admitted");
      const routing = {
        tUs: event.t_us,
        chosenPod: event.chosen_pod,
        prefillPod: event.prefill_pod,
        decodePod: event.decode_pod,
        disaggregate: event.disaggregate,
        reason: event.reason,
        scores: event.scores,
        candidates: event.candidates,
        regret: event.regret
      };
      state.requests.set(event.req_id, {
        ...req,
        status: "routed",
        routedAtUs: event.t_us,
        assignedPod: event.chosen_pod,
        prefillPod: event.prefill_pod ?? req.prefillPod,
        decodePod: event.decode_pod ?? req.decodePod,
        routing,
        phases: appendOrExtendPhase(req.phases, "routed", event.t_us, undefined, event.chosen_pod)
      });
      state.gateway.lastRoutingDecision = {
        reqId: event.req_id,
        ...routing
      };
      return;
    }

    case "request.queued": {
      const pod = getOrCreatePod(state, event.pod_id, "colocated", event.t_us, copyOnWrite);
      pod.runningRequestIds.delete(event.req_id);
      pod.queuedRequestIds.add(event.req_id);

      const req = ensureRequest(state, event.req_id, event.t_us, "queued");
      state.requests.set(event.req_id, {
        ...req,
        status: "queued",
        queuedAtUs: req.queuedAtUs ?? event.t_us,
        assignedPod: req.assignedPod ?? event.pod_id,
        phases: appendOrExtendPhase(req.phases, "queued", event.t_us, undefined, event.pod_id)
      });
      if (req.parentReqId) {
        const parent = state.requests.get(req.parentReqId);
        if (parent) {
          state.requests.set(req.parentReqId, {
            ...parent,
            status: "queued",
            phases: appendOrExtendPhase(parent.phases, "queued", event.t_us, undefined, event.pod_id)
          });
        }
      }
      return;
    }

    case "request.scheduled": {
      const pod = getOrCreatePod(state, event.pod_id, "colocated", event.t_us, copyOnWrite);
      pod.queuedRequestIds.delete(event.req_id);
      pod.runningRequestIds.add(event.req_id);
      const hitBlocks = event.cached_tokens > 0 ? Math.floor(event.cached_tokens / pod.kvBlockSizeTokens) : 0;
      pod.pendingCacheHitBlocks.set(event.req_id, hitBlocks);

      const req = ensureRequest(state, event.req_id, event.t_us, "scheduled");
      const isFirstSchedule = req.scheduledAtUs === undefined;
      if (event.prefix_lookup && isFirstSchedule) {
        state.clusterTotals.prefixQueryTokens += req.promptTokens;
        state.clusterTotals.prefixHitTokens += event.cached_tokens;
      }

      state.requests.set(event.req_id, {
        ...req,
        status: "scheduled",
        scheduledAtUs: req.scheduledAtUs ?? event.t_us,
        assignedPod: event.pod_id,
        cachedTokens: isFirstSchedule ? event.cached_tokens : req.cachedTokens,
        cpuHitTokens: isFirstSchedule ? (event.cpu_hit_tokens ?? 0) : req.cpuHitTokens,
        phases: appendOrExtendPhase(req.phases, "scheduled", event.t_us, undefined, event.pod_id)
      });
      if (req.parentReqId) {
        const parent = state.requests.get(req.parentReqId);
        if (parent) {
          const parentFirst = parent.scheduledAtUs === undefined;
          state.requests.set(req.parentReqId, {
            ...parent,
            status: "scheduled",
            scheduledAtUs: parent.scheduledAtUs ?? event.t_us,
            cachedTokens: parentFirst && event.prefix_lookup ? event.cached_tokens : parent.cachedTokens,
            cpuHitTokens: parentFirst && event.prefix_lookup ? (event.cpu_hit_tokens ?? 0) : parent.cpuHitTokens,
            phases: appendOrExtendPhase(parent.phases, "scheduled", event.t_us, undefined, event.pod_id)
          });
        }
      }
      return;
    }

    case "request.prefill": {
      const req = ensureRequest(state, event.req_id, event.t_us, "prefill");
      const startUs = Math.max(0, event.t_us - event.duration_us);
      state.requests.set(event.req_id, {
        ...req,
        status: "prefill",
        assignedPod: event.pod_id,
        promptTokens: Math.max(req.promptTokens, event.prompt_tokens),
        computedTokens: event.computed_after,
        lastStepAtUs: event.t_us,
        phases: appendOrExtendPhase(req.phases, "prefill", startUs, event.t_us, event.pod_id)
      });
      if (req.parentReqId && req.subRole === "prefill") {
        const parent = state.requests.get(req.parentReqId);
        if (parent) {
          state.requests.set(req.parentReqId, {
            ...parent,
            status: "prefill",
            computedTokens: event.computed_after,
            lastStepAtUs: event.t_us,
            phases: appendOrExtendPhase(parent.phases, "prefill", startUs, event.t_us, event.pod_id)
          });
        }
      }
      return;
    }

    case "request.decode_step": {
      const req = ensureRequest(state, event.req_id, event.t_us, "decode");
      const startUs = Math.max(0, event.t_us - event.duration_us);
      const nextFirstTokenUs = event.is_first_token ? (req.firstTokenAtUs ?? event.t_us) : req.firstTokenAtUs;
      state.requests.set(event.req_id, {
        ...req,
        status: "decode",
        assignedPod: event.pod_id,
        emittedTokens: event.total_emitted,
        firstTokenAtUs: nextFirstTokenUs,
        lastStepAtUs: event.t_us,
        phases: appendOrExtendPhase(req.phases, "decode", startUs, event.t_us, event.pod_id)
      });
      if (req.parentReqId && req.subRole === "decode") {
        const parent = state.requests.get(req.parentReqId);
        if (parent) {
          state.requests.set(req.parentReqId, {
            ...parent,
            status: "decode",
            emittedTokens: event.total_emitted,
            firstTokenAtUs: event.is_first_token ? (parent.firstTokenAtUs ?? event.t_us) : parent.firstTokenAtUs,
            lastStepAtUs: event.t_us,
            phases: appendOrExtendPhase(parent.phases, "decode", startUs, event.t_us, event.pod_id)
          });
        }
      }
      return;
    }

    case "request.preempted": {
      const pod = getOrCreatePod(state, event.pod_id, "colocated", event.t_us, copyOnWrite);
      pod.preemptions += 1;
      pod.runningRequestIds.delete(event.req_id);
      pod.queuedRequestIds.add(event.req_id);
      pod.pendingCacheHitBlocks.delete(event.req_id);
      releaseReqBlocks(pod, event.req_id);

      state.clusterTotals.preemptions += 1;

      const req = ensureRequest(state, event.req_id, event.t_us, "preempted");
      state.requests.set(event.req_id, {
        ...req,
        status: "preempted",
        computedTokens: 0,
        preemptionCount: req.preemptionCount + 1,
        allocatedBlockIds: EMPTY_BLOCKS,
        phases: appendOrExtendPhase(req.phases, "preempted", event.t_us, event.t_us, event.pod_id)
      });
      return;
    }

    case "request.finished": {
      const pod = getOrCreatePod(state, event.pod_id, "colocated", event.t_us, copyOnWrite);
      pod.runningRequestIds.delete(event.req_id);
      pod.queuedRequestIds.delete(event.req_id);
      pod.pendingCacheHitBlocks.delete(event.req_id);

      const isPrefillRetained =
        pod.poolRole === "prefill" && (event.reason === "stop" || event.reason === "length");
      if (!isPrefillRetained) {
        releaseReqBlocks(pod, event.req_id);
      }

      if (event.reason !== "abort") {
        pod.completedRequests += 1;
        pod.totalOutputTokens += event.output_tokens;
      }

      const req = ensureRequest(state, event.req_id, event.t_us, "finished");
      state.requests.set(event.req_id, {
        ...req,
        status: "finished",
        assignedPod: event.pod_id,
        finishedAtUs: event.t_us,
        finishReason: event.reason,
        outputTokens: event.output_tokens,
        emittedTokens: Math.max(req.emittedTokens, event.output_tokens),
        ttftUs: event.ttft_us,
        e2eUs: event.e2e_us,
        tpotUs: event.tpot_us,
        allocatedBlockIds: isPrefillRetained ? req.allocatedBlockIds : EMPTY_BLOCKS,
        phases: appendOrExtendPhase(req.phases, "finished", event.t_us, event.t_us, event.pod_id)
      });

      const isPrefillSubRequest = pod.poolRole === "prefill" || event.req_id.endsWith("_prefill");
      if (!isPrefillSubRequest && event.reason !== "abort") {
        state.clusterTotals.completedRequests += 1;
        state.clusterTotals.totalOutputTokens += event.output_tokens;
        state.clusterTotals.ttftSumUs += event.ttft_us;
        state.clusterTotals.ttftCount += 1;
        state.clusterTotals.tpotSumUs += event.tpot_us;
        state.clusterTotals.tpotCount += 1;
        if (state.clusterTotals.lastFinishUs === undefined || event.t_us > state.clusterTotals.lastFinishUs) {
          state.clusterTotals.lastFinishUs = event.t_us;
        }
        const endWithOverhead = req.arrivedAtUs + event.e2e_us;
        if (
          state.clusterTotals.lastFinishWithOverheadUs === undefined ||
          endWithOverhead > state.clusterTotals.lastFinishWithOverheadUs
        ) {
          state.clusterTotals.lastFinishWithOverheadUs = endWithOverhead;
        }
      }

      if (req.parentReqId && req.subRole === "decode") {
        const parent = state.requests.get(req.parentReqId);
        if (parent) {
          state.requests.set(req.parentReqId, {
            ...parent,
            status: "finished",
            finishedAtUs: event.t_us,
            finishReason: event.reason,
            outputTokens: event.output_tokens,
            emittedTokens: Math.max(parent.emittedTokens, event.output_tokens),
            ttftUs: event.ttft_us,
            e2eUs: event.e2e_us,
            tpotUs: event.tpot_us,
            phases: appendOrExtendPhase(parent.phases, "finished", event.t_us, event.t_us, event.pod_id)
          });
        }
      }
      return;
    }

    case "request.timed_out": {
      const req = ensureRequest(state, event.req_id, event.t_us, "timed_out");
      if (event.pod_id) {
        const pod = getPodForMutation(state, event.pod_id, copyOnWrite);
        if (pod) {
          pod.runningRequestIds.delete(event.req_id);
          pod.queuedRequestIds.delete(event.req_id);
          pod.pendingCacheHitBlocks.delete(event.req_id);
          releaseReqBlocks(pod, event.req_id);
        }
      }
      if (event.stage === "gateway") {
        state.gateway.queueDepth = Math.max(0, state.gateway.queueDepth - 1);
        state.gateway.totalTimedOut += 1;
      }
      state.clusterTotals.timedOutRequests += 1;
      state.requests.set(event.req_id, {
        ...req,
        status: "timed_out",
        timedOutAtUs: event.t_us,
        timeoutStage: event.stage,
        allocatedBlockIds: EMPTY_BLOCKS,
        phases: appendOrExtendPhase(req.phases, "timed_out", event.t_us, event.t_us, event.pod_id)
      });
      return;
    }

    case "batch.step": {
      const pod = getOrCreatePod(state, event.pod_id, "colocated", event.t_us, copyOnWrite);
      pod.lastBatchStep = {
        tUs: event.t_us,
        batchId: event.batch_id,
        phase: event.phase,
        memberCount: event.members.length,
        prefillTokens: event.prefill_tokens,
        decodeTokens: event.decode_tokens,
        totalTokens: event.total_tokens,
        durationUs: event.duration_us,
        roofline: event.roofline
      };
      const entry: RooflineHistoryEntry = {
        tUs: event.t_us,
        podId: event.pod_id,
        batchId: event.batch_id,
        phase: event.phase,
        totalTokens: event.total_tokens,
        prefillTokens: event.prefill_tokens,
        decodeTokens: event.decode_tokens,
        durationUs: event.duration_us,
        roofline: event.roofline
      };
      pushRooflineBounded(pod.recentRoofline, entry, Math.min(64, maxRooflineHistory));
      pushRooflineBounded(state.recentRoofline, entry, maxRooflineHistory);
      return;
    }

    case "kv.block.allocated": {
      const pod = getOrCreatePod(state, event.pod_id, "colocated", event.t_us, copyOnWrite);
      if (event.tier === "cpu_dram") {
        for (const bid of event.block_ids) {
          const existing = pod.cpuBlocks.get(bid);
          if (!existing) {
            pod.cpuBlocks.set(bid, {
              blockId: bid,
              tier: "cpu_dram",
              status: "active",
              ownerReqIds: [event.req_id],
              sharedWithReqs: event.shared_with_reqs
            });
            pod.cpuUsedBlocks += 1;
          } else if (!existing.ownerReqIds.includes(event.req_id)) {
            if (existing.ownerReqIds.length === 0) {
              pod.cpuUsedBlocks += 1;
            }
            pod.cpuBlocks.set(bid, {
              ...existing,
              status: "active",
              ownerReqIds: [...existing.ownerReqIds, event.req_id]
            });
          }
        }
        return;
      }

      const prevHeld = pod.reqBlocks.get(event.req_id);
      const isFirstAlloc = !prevHeld || prevHeld.length === 0;
      const hitBudget = isFirstAlloc ? (pod.pendingCacheHitBlocks.get(event.req_id) ?? 0) : 0;
      pod.pendingCacheHitBlocks.delete(event.req_id);

      const nextHeld = prevHeld ? prevHeld.slice() : [];
      const heldSet = prevHeld && prevHeld.length > 0 ? new Set(prevHeld) : undefined;

      for (let i = 0; i < event.block_ids.length; i++) {
        const bid = event.block_ids[i];
        const isHitSlot = i < hitBudget;
        const existing = pod.kvBlocks.get(bid);

        if (!existing) {
          pod.kvBlocks.set(bid, {
            blockId: bid,
            tier: "gpu",
            status: "active",
            ownerReqIds: [event.req_id],
            sharedWithReqs: event.shared_with_reqs
          });
          pod.kvUsedBlocks += 1;
        } else if (!isHitSlot && existing.ownerReqIds.length === 0 && existing.hash !== undefined) {
          // Physical slot reclaimed from unreferenced prefix cache by BLIS allocSlot().
          if (pod.gpuCachedByHash.get(existing.hash) === bid) {
            pod.gpuCachedByHash.delete(existing.hash);
          }
          pod.kvCachedBlocks = Math.max(0, pod.kvCachedBlocks - 1);
          pod.kvBlocks.set(bid, {
            blockId: bid,
            tier: "gpu",
            status: "active",
            ownerReqIds: [event.req_id],
            sharedWithReqs: event.shared_with_reqs
          });
          pod.kvUsedBlocks += 1;
        } else if (!existing.ownerReqIds.includes(event.req_id)) {
          if (existing.ownerReqIds.length === 0) {
            pod.kvUsedBlocks += 1;
          }
          pod.kvBlocks.set(bid, {
            ...existing,
            status: "active",
            ownerReqIds: [...existing.ownerReqIds, event.req_id],
            sharedWithReqs: event.shared_with_reqs ?? existing.sharedWithReqs
          });
        }

        if (!heldSet || !heldSet.has(bid)) {
          nextHeld.push(bid);
          if (heldSet) {
            heldSet.add(bid);
          }
        }
      }

      pod.reqBlocks.set(event.req_id, nextHeld);
      syncPodKVFree(pod);

      const req = state.requests.get(event.req_id);
      if (req) {
        state.requests.set(event.req_id, {
          ...req,
          allocatedBlockIds: nextHeld
        });
      }
      return;
    }

    case "kv.block.cached": {
      const pod = getOrCreatePod(state, event.pod_id, "colocated", event.t_us, copyOnWrite);
      if (event.tier === "cpu_dram") {
        for (let i = 0; i < event.block_ids.length; i++) {
          const bid = event.block_ids[i];
          const hash = event.block_hashes[i];
          const existing = pod.cpuBlocks.get(bid);
          if (existing?.hash !== undefined) {
            if (existing.hash !== hash && pod.cpuCachedByHash.get(existing.hash) === bid) {
              pod.cpuCachedByHash.delete(existing.hash);
            }
            pod.cpuBlocks.set(bid, {
              ...existing,
              hash,
              prevOwnerReqId: event.prev_owner_req_id ?? existing.prevOwnerReqId
            });
          } else {
            pod.cpuUsedBlocks += 1;
            pod.cpuBlocks.set(bid, {
              blockId: bid,
              tier: "cpu_dram",
              status: existing && existing.ownerReqIds.length > 0 ? "active" : "cached",
              ownerReqIds: existing ? existing.ownerReqIds : EMPTY_OWNERS,
              hash,
              prevOwnerReqId: event.prev_owner_req_id
            });
          }
          if (hash !== undefined) {
            pod.cpuCachedByHash.set(hash, bid);
          }
        }
        return;
      }

      for (let i = 0; i < event.block_ids.length; i++) {
        const bid = event.block_ids[i];
        const hash = event.block_hashes[i];
        const existing = pod.kvBlocks.get(bid);
        if (existing?.hash !== undefined) {
          if (existing.hash !== hash && pod.gpuCachedByHash.get(existing.hash) === bid) {
            pod.gpuCachedByHash.delete(existing.hash);
          }
          pod.kvBlocks.set(bid, {
            ...existing,
            hash,
            prevOwnerReqId: event.prev_owner_req_id ?? existing.prevOwnerReqId
          });
        } else {
          pod.kvCachedBlocks += 1;
          pod.kvBlocks.set(bid, {
            blockId: bid,
            tier: "gpu",
            status: existing && existing.ownerReqIds.length > 0 ? "active" : "cached",
            ownerReqIds: existing ? existing.ownerReqIds : EMPTY_OWNERS,
            hash,
            prevOwnerReqId: event.prev_owner_req_id ?? existing?.prevOwnerReqId,
            sharedWithReqs: existing?.sharedWithReqs
          });
        }
        if (hash !== undefined) {
          pod.gpuCachedByHash.set(hash, bid);
        }
      }
      return;
    }

    case "kv.block.evicted": {
      const pod = getOrCreatePod(state, event.pod_id, "colocated", event.t_us, copyOnWrite);
      if (event.tier === "cpu_dram") {
        for (let i = 0; i < event.block_ids.length; i++) {
          const hash = event.block_hashes?.[i];
          const targetBid = hash !== undefined ? pod.cpuCachedByHash.get(hash) : event.block_ids[i];
          if (targetBid === undefined) {
            continue;
          }
          if (hash !== undefined) {
            pod.cpuCachedByHash.delete(hash);
          }
          const existing = pod.cpuBlocks.get(targetBid);
          if (!existing || (hash !== undefined && existing.hash !== hash)) {
            continue;
          }
          if (existing.hash !== undefined && hash === undefined && pod.cpuCachedByHash.get(existing.hash) === targetBid) {
            pod.cpuCachedByHash.delete(existing.hash);
          }
          pod.cpuUsedBlocks = Math.max(0, pod.cpuUsedBlocks - 1);
          pod.cpuBlocks.delete(targetBid);
        }
        return;
      }

      for (let i = 0; i < event.block_ids.length; i++) {
        const hash = event.block_hashes?.[i];
        // Prefer hash lookup because prior allocSlot() reclamation can leave fallback block_ids=[0] in kv.block.evicted.
        const targetBid = hash !== undefined ? pod.gpuCachedByHash.get(hash) : event.block_ids[i];
        if (targetBid === undefined) {
          continue;
        }
        if (hash !== undefined) {
          pod.gpuCachedByHash.delete(hash);
        }
        const existing = pod.kvBlocks.get(targetBid);
        if (!existing || (hash !== undefined && existing.hash !== hash)) {
          continue;
        }
        if (existing.hash !== undefined) {
          if (hash === undefined && pod.gpuCachedByHash.get(existing.hash) === targetBid) {
            pod.gpuCachedByHash.delete(existing.hash);
          }
          pod.kvCachedBlocks = Math.max(0, pod.kvCachedBlocks - 1);
        }
        if (existing.ownerReqIds.length > 0) {
          pod.kvBlocks.set(targetBid, {
            ...existing,
            status: "active",
            hash: undefined
          });
        } else {
          pod.kvBlocks.delete(targetBid);
        }
      }
      return;
    }

    case "kv.block.moved": {
      const key = `${event.pod_id}:${event.transfer_id}`;
      if (event.status === "started") {
        state.activeTierMoves.set(key, {
          key,
          podId: event.pod_id,
          transferId: event.transfer_id,
          reqId: event.req_id,
          fromTier: event.from_tier,
          toTier: event.to_tier,
          direction: event.direction,
          blockIds: event.block_ids,
          numBlocks: event.num_blocks,
          tokens: event.tokens,
          startedAtUs: event.t_us
        });
      } else {
        state.activeTierMoves.delete(key);
      }
      return;
    }

    case "kv.transfer": {
      const key =
        event.transfer_id !== undefined
          ? String(event.transfer_id)
          : `${event.req_id}:${event.from_pod}->${event.to_pod}`;
      if (event.status === "started") {
        state.activeTransfers.set(key, {
          key,
          transferId: event.transfer_id,
          reqId: event.req_id,
          fromPod: event.from_pod,
          toPod: event.to_pod,
          numKVBlocks: event.num_kv_blocks,
          pulledKVBlocks: event.pulled_kv_blocks,
          startedAtUs: event.t_us
        });
        const req = state.requests.get(event.req_id);
        if (req) {
          state.requests.set(event.req_id, {
            ...req,
            status: "kv_transfer",
            phases: appendOrExtendPhase(req.phases, "kv_transfer", event.t_us, undefined, event.to_pod)
          });
        }
      } else {
        state.activeTransfers.delete(key);
        const prefillSubReqId = `${event.req_id}_prefill`;
        const fromPod = getPodForMutation(state, event.from_pod, copyOnWrite);
        if (fromPod) {
          releaseReqBlocks(fromPod, event.req_id);
          releaseReqBlocks(fromPod, prefillSubReqId);
        }
        const prefillSubReq = state.requests.get(prefillSubReqId);
        if (prefillSubReq && prefillSubReq.allocatedBlockIds.length > 0) {
          state.requests.set(prefillSubReqId, {
            ...prefillSubReq,
            allocatedBlockIds: EMPTY_BLOCKS
          });
        }
        const req = state.requests.get(event.req_id);
        if (req) {
          const nextPhases = req.phases.slice();
          const last = nextPhases[nextPhases.length - 1];
          if (last && last.phase === "kv_transfer" && last.endUs === undefined) {
            nextPhases[nextPhases.length - 1] = { ...last, endUs: event.t_us };
          }
          state.requests.set(event.req_id, {
            ...req,
            phases: nextPhases
          });
        }
      }
      return;
    }

    case "metrics.snapshot": {
      state.metricsSeries.push(event);
      state.latestSnapshot = event;
      for (const inst of event.instances) {
        const pod = getPodForMutation(state, inst.pod_id, copyOnWrite);
        if (pod) {
          pod.kvTotalBlocks = inst.kv_total_blocks;
          syncPodKVFree(pod);
          if (inst.cpu_total_blocks !== undefined) {
            pod.cpuTotalBlocks = inst.cpu_total_blocks;
          }
        }
      }
      return;
    }
  }
}

function prepareDraftForEvent(state: SimState, event: SimEvent): SimState {
  // Clone only top-level containers that this event mutates; touched PodStates are cloned lazily.
  const draft: SimState = {
    tUs: state.tUs,
    lastSeq: state.lastSeq,
    eventIndex: state.eventIndex,
    header: state.header,
    pods: state.pods,
    requests: state.requests,
    gateway: state.gateway,
    clusterTotals: state.clusterTotals,
    activeTransfers: state.activeTransfers,
    activeTierMoves: state.activeTierMoves,
    metricsSeries: state.metricsSeries,
    latestSnapshot: state.latestSnapshot,
    recentRoofline: state.recentRoofline
  };

  switch (event.type) {
    case "pod.created":
    case "pod.loading":
    case "pod.ready":
    case "pod.draining":
    case "pod.terminated":
    case "kv.block.cached":
    case "kv.block.evicted":
      draft.pods = new Map(state.pods);
      break;
    case "kv.block.allocated":
      draft.pods = new Map(state.pods);
      draft.requests = new Map(state.requests);
      break;
    case "request.arrived":
    case "request.admitted":
      draft.requests = new Map(state.requests);
      draft.gateway = { ...state.gateway };
      draft.clusterTotals = { ...state.clusterTotals };
      break;
    case "request.rejected":
      draft.pods = new Map(state.pods);
      draft.requests = new Map(state.requests);
      draft.gateway = { ...state.gateway };
      draft.clusterTotals = { ...state.clusterTotals };
      break;
    case "request.routed":
      draft.requests = new Map(state.requests);
      draft.gateway = { ...state.gateway };
      break;
    case "request.queued":
    case "request.scheduled":
      draft.pods = new Map(state.pods);
      draft.requests = new Map(state.requests);
      draft.clusterTotals = { ...state.clusterTotals };
      break;
    case "request.prefill":
    case "request.decode_step":
      draft.requests = new Map(state.requests);
      break;
    case "request.preempted":
    case "request.finished":
      draft.pods = new Map(state.pods);
      draft.requests = new Map(state.requests);
      draft.clusterTotals = { ...state.clusterTotals };
      break;
    case "request.timed_out":
      draft.pods = new Map(state.pods);
      draft.requests = new Map(state.requests);
      draft.gateway = { ...state.gateway };
      draft.clusterTotals = { ...state.clusterTotals };
      break;
    case "batch.step":
      draft.pods = new Map(state.pods);
      draft.recentRoofline = state.recentRoofline.slice();
      break;
    case "kv.block.moved":
      draft.activeTierMoves = new Map(state.activeTierMoves);
      break;
    case "kv.transfer":
      draft.pods = new Map(state.pods);
      draft.requests = new Map(state.requests);
      draft.activeTransfers = new Map(state.activeTransfers);
      break;
    case "metrics.snapshot":
      draft.pods = new Map(state.pods);
      draft.metricsSeries = state.metricsSeries.slice();
      break;
  }

  return draft;
}

/**
 * Pure deterministic state transition for all 23 BLIS schema event types.
 * Never mutates the input `state`.
 */
export function applyEvent(
  state: SimState,
  event: SimEvent,
  maxRooflineHistory: number = DEFAULT_MAX_ROOFLINE_HISTORY
): SimState {
  const draft = prepareDraftForEvent(state, event);
  applyEventInternal(draft, event, true, maxRooflineHistory);
  return draft;
}

/**
 * Mutating transition for exclusive draft states owned by ReplayTimeline during indexing/seeking.
 * Identical semantics to applyEvent.
 */
export function applyEventOwned(
  ownedState: SimState,
  event: SimEvent,
  maxRooflineHistory: number = DEFAULT_MAX_ROOFLINE_HISTORY
): void {
  applyEventInternal(ownedState, event, false, maxRooflineHistory);
}
