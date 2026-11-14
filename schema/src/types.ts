/* eslint-disable */
/**
 * AUTO-GENERATED from schema/events.schema.json. Do not edit by hand.
 */

/**
 * Versioned NDJSON record schema for LLM inference visualization driven by BLIS.
 */
export type BLISEventStreamRecordV1 =
  | HeaderRecord
  | RequestArrivedEvent
  | RequestAdmittedEvent
  | RequestRejectedEvent
  | RequestRoutedEvent
  | RequestQueuedEvent
  | RequestScheduledEvent
  | RequestPrefillEvent
  | RequestDecodeStepEvent
  | RequestPreemptedEvent
  | RequestFinishedEvent
  | RequestTimedOutEvent
  | BatchStepEvent
  | KVBlockAllocatedEvent
  | KVBlockCachedEvent
  | KVBlockEvictedEvent
  | KVBlockMovedEvent
  | KVTransferEvent
  | PodCreatedEvent
  | PodLoadingEvent
  | PodReadyEvent
  | PodDrainingEvent
  | PodTerminatedEvent
  | MetricsSnapshotEvent;

export interface HeaderRecord {
  type: "header";
  schema_version: "1.0";
  blis: {
    commit: string;
    vllm_version: string;
    llmd_version: string;
    stack_versions: {
      [k: string]: string | undefined;
    };
  };
  scenario: {
    name: string;
    model: string;
    hardware: string;
    flags: {};
    seed: number;
    horizon_us: number;
    routing_policy?: string;
  };
  topology: {
    gateway_latency_us: number;
    /**
     * @minItems 1
     */
    pools: [PoolConfig, ...PoolConfig[]];
    tiers: {
      gpu_hbm_blocks: number;
      cpu_ram_blocks: number;
      cpu_ram_bytes: number;
      local_ssd_modelled: boolean;
      remote_store_modelled: boolean;
      unmodelled_notes: {
        [k: string]: string | undefined;
      };
    };
    initial_pods: InitialPod[];
  };
}
export interface PoolConfig {
  role: "colocated" | "prefill" | "decode" | "encode";
  replicas: number;
  tp: number;
  pp: number;
  dp: number;
  gpus_per_pod: number;
  gpu_type: string;
  gpu_specs: GPUSpecs;
  memory_breakdown_bytes: MemoryBreakdownBytes;
  kv_blocks_per_gpu: number;
  kv_block_size_tokens: number;
  max_num_seqs: number;
  max_num_batched_tokens: number;
  max_model_len: number;
}
export interface GPUSpecs {
  memory_gib: number;
  tflops_peak: number;
  tflops_fp8: number;
  bw_peak_tbs: number;
  sm_count: number;
}
export interface MemoryBreakdownBytes {
  weights: number;
  activation_peak: number;
  cuda_graph: number;
  comm_buffers: number;
}
export interface InitialPod {
  pod_id: string;
  pool_role: "colocated" | "prefill" | "decode" | "encode";
  /**
   * @minItems 1
   */
  gpu_ids: [string, ...string[]];
  tp_degree: number;
  state: "loading" | "ready" | "draining" | "terminated";
}
export interface RequestArrivedEvent {
  seq: number;
  t_us: number;
  type: "request.arrived";
  req_id: string;
  prompt_tokens: number;
  max_output_tokens: number;
  prefix_group?: string;
  prefix_tokens?: number;
  block_hashes?: string[];
  slo_class?: string;
  session_id?: string;
}
export interface RequestAdmittedEvent {
  seq: number;
  t_us: number;
  type: "request.admitted";
  req_id: string;
  reason?: string;
}
export interface RequestRejectedEvent {
  seq: number;
  t_us: number;
  type: "request.rejected";
  req_id: string;
  reason: string;
  stage: "admission" | "flow_control" | "routing" | "unservable" | "decode_kv";
}
export interface RequestRoutedEvent {
  seq: number;
  t_us: number;
  type: "request.routed";
  req_id: string;
  chosen_pod: string;
  prefill_pod?: string;
  decode_pod?: string;
  disaggregate: boolean;
  reason?: string;
  scores?: {
    [k: string]: number | undefined;
  };
  candidates?: CandidateScore[];
  regret?: number;
}
export interface CandidateScore {
  pod_id: string;
  score: number;
  scorer_breakdown?: {
    [k: string]: number | undefined;
  };
  queue_depth: number;
  batch_size: number;
  in_flight_requests?: number;
  kv_utilization: number;
  free_kv_blocks: number;
}
export interface RequestQueuedEvent {
  seq: number;
  t_us: number;
  type: "request.queued";
  req_id: string;
  pod_id: string;
  queue_depth: number;
}
export interface RequestScheduledEvent {
  seq: number;
  t_us: number;
  type: "request.scheduled";
  req_id: string;
  pod_id: string;
  cached_tokens: number;
  cpu_hit_tokens?: number;
  prefix_lookup: boolean;
}
export interface RequestPrefillEvent {
  seq: number;
  t_us: number;
  type: "request.prefill";
  req_id: string;
  pod_id: string;
  batch_id: number;
  tokens_processed: number;
  computed_after: number;
  prompt_tokens: number;
  duration_us: number;
}
export interface RequestDecodeStepEvent {
  seq: number;
  t_us: number;
  type: "request.decode_step";
  req_id: string;
  pod_id: string;
  batch_id: number;
  tokens_emitted: number;
  total_emitted: number;
  is_first_token: boolean;
  duration_us: number;
}
export interface RequestPreemptedEvent {
  seq: number;
  t_us: number;
  type: "request.preempted";
  req_id: string;
  pod_id: string;
  reason: string;
  computed_tokens_lost?: number;
  freed_blocks: number[];
}
export interface RequestFinishedEvent {
  seq: number;
  t_us: number;
  type: "request.finished";
  req_id: string;
  pod_id: string;
  reason: "stop" | "length" | "abort" | "error";
  output_tokens: number;
  ttft_us: number;
  e2e_us: number;
  tpot_us: number;
}
export interface RequestTimedOutEvent {
  seq: number;
  t_us: number;
  type: "request.timed_out";
  req_id: string;
  pod_id?: string;
  stage: "gateway" | "engine";
  elapsed_us: number;
}
export interface BatchStepEvent {
  seq: number;
  t_us: number;
  type: "batch.step";
  pod_id: string;
  batch_id: number;
  phase: "prefill" | "decode" | "mixed";
  members: BatchMember[];
  prefill_tokens: number;
  decode_tokens: number;
  total_tokens: number;
  duration_us: number;
  roofline: RooflinePoint;
}
export interface BatchMember {
  req_id: string;
  role: "prefill" | "decode";
  tokens: number;
  computed_before: number;
}
export interface RooflinePoint {
  flops: number;
  bytes_moved: number;
  arithmetic_intensity: number;
  achieved_tflops: number;
  achieved_bw_tbs: number;
  bottleneck: string;
  per_resource_us?: {
    [k: string]: number | undefined;
  };
  derived: boolean;
}
export interface KVBlockAllocatedEvent {
  seq: number;
  t_us: number;
  type: "kv.block.allocated";
  pod_id: string;
  /**
   * @minItems 1
   */
  gpu_indices: [number, ...number[]];
  /**
   * @minItems 1
   */
  block_ids: [number, ...number[]];
  req_id: string;
  block_hashes?: string[];
  tier: "gpu" | "cpu_dram";
  shared_with_reqs?: string[];
}
export interface KVBlockCachedEvent {
  seq: number;
  t_us: number;
  type: "kv.block.cached";
  pod_id: string;
  /**
   * @minItems 1
   */
  gpu_indices: [number, ...number[]];
  /**
   * @minItems 1
   */
  block_ids: [number, ...number[]];
  block_hashes: string[];
  prev_owner_req_id?: string;
  tier: "gpu" | "cpu_dram";
}
export interface KVBlockEvictedEvent {
  seq: number;
  t_us: number;
  type: "kv.block.evicted";
  pod_id: string;
  /**
   * @minItems 1
   */
  gpu_indices: [number, ...number[]];
  /**
   * @minItems 1
   */
  block_ids: [number, ...number[]];
  block_hashes?: string[];
  tier: "gpu" | "cpu_dram";
  destination: "dropped" | "cpu_dram";
  reason: string;
  triggered_by_req_id?: string;
}
export interface KVBlockMovedEvent {
  seq: number;
  t_us: number;
  type: "kv.block.moved";
  pod_id: string;
  transfer_id: number;
  req_id: string;
  from_tier: "gpu" | "cpu_dram";
  to_tier: "gpu" | "cpu_dram";
  direction: "offload" | "load";
  block_ids: number[];
  num_blocks: number;
  tokens: number;
  duration_us: number;
  status: "started" | "completed";
}
export interface KVTransferEvent {
  seq: number;
  t_us: number;
  type: "kv.transfer";
  transfer_id?: number;
  req_id: string;
  from_pod: string;
  to_pod: string;
  num_kv_blocks: number;
  pulled_kv_blocks: number;
  duration_us: number;
  status: "started" | "completed";
}
export interface PodCreatedEvent {
  seq: number;
  t_us: number;
  type: "pod.created";
  pod_id: string;
  pool_role: "colocated" | "prefill" | "decode" | "encode";
  /**
   * @minItems 1
   */
  gpu_ids: [string, ...string[]];
  tp_degree: number;
  node_id?: string;
}
export interface PodLoadingEvent {
  seq: number;
  t_us: number;
  type: "pod.loading";
  pod_id: string;
  pool_role: "colocated" | "prefill" | "decode" | "encode";
}
export interface PodReadyEvent {
  seq: number;
  t_us: number;
  type: "pod.ready";
  pod_id: string;
  pool_role: "colocated" | "prefill" | "decode" | "encode";
}
export interface PodDrainingEvent {
  seq: number;
  t_us: number;
  type: "pod.draining";
  pod_id: string;
  pool_role: "colocated" | "prefill" | "decode" | "encode";
  reason?: string;
}
export interface PodTerminatedEvent {
  seq: number;
  t_us: number;
  type: "pod.terminated";
  pod_id: string;
  pool_role: "colocated" | "prefill" | "decode" | "encode";
}
export interface MetricsSnapshotEvent {
  seq: number;
  t_us: number;
  type: "metrics.snapshot";
  is_final: boolean;
  gateway_queue_depth: number;
  completed_requests: number;
  preemptions: number;
  rejected_requests: number;
  timed_out_requests: number;
  dropped_requests: number;
  ttft_mean_ms: number;
  tpot_mean_ms: number;
  output_tok_s: number;
  prefix_cache_hit_rate: number;
  instances: InstanceMetricsSnapshot[];
}
export interface InstanceMetricsSnapshot {
  pod_id: string;
  state: "loading" | "warming_up" | "ready" | "active" | "draining" | "terminated";
  queue_depth: number;
  batch_size: number;
  kv_used_blocks: number;
  kv_cached_blocks: number;
  kv_free_blocks: number;
  kv_total_blocks: number;
  cpu_used_blocks?: number;
  cpu_total_blocks?: number;
  preemptions: number;
  completed_requests: number;
}

export type SimEvent = Exclude<BLISEventStreamRecordV1, HeaderRecord>;
export type SimEventType = SimEvent["type"];

export interface UnknownEvent {
  seq: number;
  t_us: number;
  type: string;
  [key: string]: unknown;
}
