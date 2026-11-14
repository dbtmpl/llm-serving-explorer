import type {
  CandidateScore,
  HeaderRecord,
  MetricsSnapshotEvent,
  PoolConfig,
  RooflinePoint,
  SimEvent
} from "@llm-viz/schema";

export type PoolRole = PoolConfig["role"];
export type PodLifecycleStatus = "loading" | "ready" | "draining" | "terminated";
export type KVTier = "gpu" | "cpu_dram";

/**
 * State of a single physical KV block slot in GPU HBM or CPU DRAM.
 */
export interface KVBlockSlotState {
  readonly blockId: number;
  readonly tier: KVTier;
  readonly status: "active" | "cached";
  readonly ownerReqIds: readonly string[];
  readonly hash?: string;
  readonly prevOwnerReqId?: string;
  readonly sharedWithReqs?: readonly string[];
}

export interface PodLastBatchStep {
  readonly tUs: number;
  readonly batchId: number;
  readonly phase: "prefill" | "decode" | "mixed";
  readonly memberCount: number;
  readonly prefillTokens: number;
  readonly decodeTokens: number;
  readonly totalTokens: number;
  readonly durationUs: number;
  readonly roofline: RooflinePoint;
}

export interface RooflineHistoryEntry {
  readonly tUs: number;
  readonly podId: string;
  readonly batchId: number;
  readonly phase: "prefill" | "decode" | "mixed";
  readonly totalTokens: number;
  readonly prefillTokens: number;
  readonly decodeTokens: number;
  readonly durationUs: number;
  readonly roofline: RooflinePoint;
}

/**
 * Per-pod runtime state reconstructed from BLIS header + events.
 */
export interface PodState {
  podId: string;
  poolRole: PoolRole;
  gpuIds: readonly string[];
  tpDegree: number;
  nodeId?: string;
  status: PodLifecycleStatus;
  createdAtUs: number;
  readyAtUs?: number;
  drainingAtUs?: number;
  terminatedAtUs?: number;
  drainReason?: string;

  kvBlockSizeTokens: number;
  kvTotalBlocks: number;
  kvUsedBlocks: number;
  kvCachedBlocks: number;
  kvFreeBlocks: number;

  cpuTotalBlocks: number;
  cpuUsedBlocks: number;

  queuedRequestIds: Set<string>;
  runningRequestIds: Set<string>;

  /** Sparse map of currently active or prefix-cached GPU KV block slots by blockId. */
  kvBlocks: Map<number, KVBlockSlotState>;
  /** Reverse index from GPU block hash -> blockId for O(1) eviction lookups. */
  gpuCachedByHash: Map<string, number>;
  /** Sparse map of currently cached CPU DRAM KV block slots by blockId. */
  cpuBlocks: Map<number, KVBlockSlotState>;
  /** Reverse index from CPU block hash -> blockId. */
  cpuCachedByHash: Map<string, number>;
  /** Blocks currently held by active requests on this pod. */
  reqBlocks: Map<string, readonly number[]>;
  /** Remaining prefix-hit block budget from the most recent request.scheduled event. */
  pendingCacheHitBlocks: Map<string, number>;

  preemptions: number;
  completedRequests: number;
  totalOutputTokens: number;
  lastBatchStep?: PodLastBatchStep;
  recentRoofline: RooflineHistoryEntry[];
}

export type RequestPhaseName =
  | "arrived"
  | "admitted"
  | "routed"
  | "queued"
  | "scheduled"
  | "prefill"
  | "kv_transfer"
  | "decode"
  | "preempted"
  | "finished"
  | "rejected"
  | "timed_out";

export type RequestStatus = RequestPhaseName;

export interface RequestPhaseSpan {
  readonly phase: RequestPhaseName;
  readonly startUs: number;
  readonly endUs?: number;
  readonly podId?: string;
}

export interface RequestRoutingInfo {
  readonly tUs: number;
  readonly chosenPod: string;
  readonly prefillPod?: string;
  readonly decodePod?: string;
  readonly disaggregate: boolean;
  readonly reason?: string;
  readonly scores?: Readonly<Record<string, number | undefined>>;
  readonly candidates?: readonly CandidateScore[];
  readonly regret?: number;
}

/**
 * Full lifecycle state of a request (or disaggregated prefill/decode sub-request).
 */
export interface RequestLifecycleState {
  readonly reqId: string;
  readonly parentReqId?: string;
  readonly subRole?: "prefill" | "decode";
  readonly promptTokens: number;
  readonly maxOutputTokens: number;
  readonly prefixGroup?: string;
  readonly prefixTokens?: number;
  readonly blockHashes?: readonly string[];
  readonly sloClass?: string;
  readonly sessionId?: string;

  readonly status: RequestStatus;
  readonly arrivedAtUs: number;
  readonly admittedAtUs?: number;
  readonly routedAtUs?: number;
  readonly queuedAtUs?: number;
  readonly scheduledAtUs?: number;
  readonly firstTokenAtUs?: number;
  readonly finishedAtUs?: number;
  readonly rejectedAtUs?: number;
  readonly timedOutAtUs?: number;
  readonly lastStepAtUs?: number;

  readonly assignedPod?: string;
  readonly prefillPod?: string;
  readonly decodePod?: string;
  readonly routing?: RequestRoutingInfo;

  readonly computedTokens: number;
  readonly emittedTokens: number;
  readonly cachedTokens: number;
  readonly cpuHitTokens: number;
  readonly preemptionCount: number;
  readonly allocatedBlockIds: readonly number[];

  readonly finishReason?: "stop" | "length" | "abort" | "error";
  readonly outputTokens?: number;
  readonly ttftUs?: number;
  readonly e2eUs?: number;
  readonly tpotUs?: number;

  readonly rejectReason?: string;
  readonly rejectStage?: "admission" | "flow_control" | "routing" | "unservable" | "decode_kv";
  readonly timeoutStage?: "gateway" | "engine";

  readonly phases: readonly RequestPhaseSpan[];
}

/**
 * Projection of a request currently executing on a pod.
 */
export interface RunningRequestState {
  readonly reqId: string;
  readonly podId: string;
  readonly status: RequestStatus;
  readonly promptTokens: number;
  readonly computedTokens: number;
  readonly emittedTokens: number;
  readonly maxOutputTokens: number;
  readonly blockIds: readonly number[];
}

export interface ActiveKVTransfer {
  readonly key: string;
  readonly transferId?: number;
  readonly reqId: string;
  readonly fromPod: string;
  readonly toPod: string;
  readonly numKVBlocks: number;
  readonly pulledKVBlocks: number;
  readonly startedAtUs: number;
}

export interface ActiveTierMove {
  readonly key: string;
  readonly podId: string;
  readonly transferId: number;
  readonly reqId: string;
  readonly fromTier: KVTier;
  readonly toTier: KVTier;
  readonly direction: "offload" | "load";
  readonly blockIds: readonly number[];
  readonly numBlocks: number;
  readonly tokens: number;
  readonly startedAtUs: number;
}

export interface GatewayState {
  queueDepth: number;
  totalArrived: number;
  totalAdmitted: number;
  totalRejected: number;
  totalTimedOut: number;
  lastRoutingDecision?: RequestRoutingInfo & { readonly reqId: string };
}

export interface ClusterTotals {
  completedRequests: number;
  preemptions: number;
  rejectedRequests: number;
  timedOutRequests: number;
  droppedRequests: number;
  totalOutputTokens: number;
  firstArrivalUs?: number;
  lastFinishUs?: number;
  lastFinishWithOverheadUs?: number;
  ttftSumUs: number;
  ttftCount: number;
  tpotSumUs: number;
  tpotCount: number;
  prefixQueryTokens: number;
  prefixHitTokens: number;
}

export type MetricsSeriesPoint = MetricsSnapshotEvent;

/**
 * Deterministic simulation state at a given event index / timestamp.
 */
export interface SimState {
  tUs: number;
  lastSeq: number;
  eventIndex: number;
  header: HeaderRecord;
  pods: Map<string, PodState>;
  requests: Map<string, RequestLifecycleState>;
  gateway: GatewayState;
  clusterTotals: ClusterTotals;
  activeTransfers: Map<string, ActiveKVTransfer>;
  activeTierMoves: Map<string, ActiveTierMove>;
  metricsSeries: MetricsSeriesPoint[];
  latestSnapshot?: MetricsSnapshotEvent;
  recentRoofline: RooflineHistoryEntry[];
}

export interface ReplayTimelineOptions {
  /** Number of events between cached state checkpoints (default: 500). */
  snapshotStride?: number;
  /** Maximum recent roofline points retained on SimState (default: 256). */
  maxRooflineHistory?: number;
}

export interface TimelineSeekResult {
  tUs: number;
  eventIndex: number;
  state: SimState;
}

export interface FinalSummaryMetrics {
  completedRequests: number;
  preemptions: number;
  rejectedRequests: number;
  timedOutRequests: number;
  droppedRequests: number;
  ttftMeanMs: number;
  tpotMeanMs: number;
  outputTokS: number;
  snapshotOutputTokS?: number;
  snapshotTtftMeanMs?: number;
  snapshotTpotMeanMs?: number;
  prefixCacheHitRate: number;
  durationUs: number;
}

export type { SimEvent, HeaderRecord, MetricsSnapshotEvent, RooflinePoint, CandidateScore, PoolConfig };
