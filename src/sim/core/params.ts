/**
 * Every setting of the simulation. Each can be changed while requests are in flight.
 *
 * Defaults are chosen so that the mechanisms are visible at a glance, not to match a production
 * deployment. Where a default differs from the real system's, the comment says so.
 */
import type { AdmissionId } from "../admission/index.js";
import type { BatchingId } from "../batching/index.js";
import type { Precision } from "../hardware/catalog.js";
import type { RoutingId } from "../routing/index.js";

export type Routing = RoutingId;

export interface Params {
  /* ---- hardware (see hardware/) ---- */
  /** Key into the model catalog. */
  model: string;
  /** Key into the GPU catalog. */
  gpu: string;
  precision: Precision;
  /** Tensor-parallel degree: GPUs per pod. */
  tp: number;
  /** vLLM `gpu_memory_utilization`. */
  gpuMemUtil: number;

  /* ---- engine (see batching/, admission/, cost/) ---- */
  /** vLLM `max_num_seqs`: batch slots per pod. vLLM's default is 128; 12 keeps a batch readable. */
  maxNumSeqs: number;
  /** vLLM `max_num_batched_tokens`: tokens one step may process. */
  tokenBudget: number;
  batching: BatchingId;
  admission: AdmissionId;
  /** The `max_tokens` clients send. Only reserve-to-completion admission looks at it. */
  maxTokensCap: number;
  prefixCaching: boolean;
  /** Host work overlaps the GPU step instead of adding to it. */
  overlap: boolean;
  /** Achieved share of peak memory bandwidth, in (0, 1]. */
  mbu: number;
  /** Achieved share of peak FLOP/s, in (0, 1]. */
  mfu: number;
  /** Host milliseconds per step, fixed part. */
  hostMsBase: number;
  /** Host milliseconds per step, per sequence in the batch. */
  hostMsPerSeq: number;

  /* ---- decoding (see decoding/) ---- */
  specDecode: boolean;
  /** Draft tokens per step, γ. */
  specK: number;
  /** Per-token acceptance probability, α. */
  specAccept: number;
  /** One draft run over one target run, c. */
  specCost: number;

  /* ---- routing, fleet and flow control (see routing/, autoscaling/, flowcontrol/) ---- */
  routing: RoutingId;
  minPods: number;
  maxPods: number;
  /** Seconds from pod creation to ready. Real cold starts take minutes; shortened to be watchable. */
  coldStartS: number;
  /** A ready pod with no work for this long is scaled down. */
  scaleDownIdleS: number;
  /** Reject a request that has waited this long at the router (0 = never). */
  shedAfterS: number;

  /* ---- KV tiers below GPU memory (see kvcache/) ---- */
  /** Host DRAM per pod for KV, GB. */
  dramGB: number;
  /** Local SSD per pod for KV, GB. */
  ssdGB: number;
  /** KV pool shared by all pods over the network, GB (0 = none). */
  remoteGB: number;
  /** Achieved copy rate from DRAM back to GPU memory, GB/s. */
  dramGBs: number;
  /** Achieved copy rate from SSD back to GPU memory, GB/s. */
  ssdGBs: number;
  /** Link rate to the remote pool, Gbit/s. */
  remoteGbps: number;

  /* ---- prefill/decode disaggregation (see disaggregation/) ---- */
  disagg: boolean;
  /** Share of pods that prefill. */
  prefillShare: number;
  /** Prompts with fewer uncached tokens than this are prefilled on their decode pod. */
  pdThreshold: number;
  /** Link rate between pods for KV hand-over, Gbit/s. */
  linkGbps: number;

  /* ---- workload (see workload/) ---- */
  /** Mean tokens of a first-turn prompt. */
  promptTokens: number;
  /** Mean new tokens a follow-up turn adds to the history. */
  followTokens: number;
  /** Mean output tokens per turn. */
  outputTokens: number;
  /** Probability that a session sends another turn. */
  returnProb: number;
  /** Mean seconds a user takes before the next turn. */
  thinkTimeS: number;
  maxTurns: number;
  /** New sessions per second, on top of bursts. */
  arrivalRate: number;

  /* ---- price ---- */
  pricePerGpuHour: number;
}

export const DEFAULT_PARAMS: Params = {
  model: "llama-3.1-8b",
  gpu: "h100",
  precision: "bf16",
  tp: 1,
  gpuMemUtil: 0.9,
  maxNumSeqs: 12,
  tokenBudget: 8192,
  prefixCaching: true,
  overlap: false,
  mbu: 0.6,
  mfu: 0.5,
  hostMsBase: 1.5,
  hostMsPerSeq: 0.05,
  routing: "prefix-aware",
  minPods: 0,
  maxPods: 16,
  coldStartS: 2,
  scaleDownIdleS: 12,
  dramGB: 32,
  ssdGB: 128,
  remoteGB: 256,
  promptTokens: 3000,
  followTokens: 120,
  outputTokens: 150,
  returnProb: 0.7,
  thinkTimeS: 4,
  maxTurns: 6,
  arrivalRate: 0,
  pricePerGpuHour: 2.5,
  batching: "continuous",
  admission: "on-demand",
  maxTokensCap: 4096,
  disagg: false,
  prefillShare: 0.34,
  pdThreshold: 512,
  linkGbps: 100,
  specDecode: false,
  specK: 4,
  specAccept: 0.7,
  specCost: 0.04,
  dramGBs: 20,
  ssdGBs: 4,
  remoteGbps: 64,
  shedAfterS: 0
};

/** Changing any of these rebuilds every pod: weights and the KV pool are sized at start-up. */
export const RESTART_KEYS: (keyof Params)[] = ["model", "gpu", "precision", "tp", "gpuMemUtil", "disagg"];
