/**
 * Where a GPU's memory goes: weights, activations, captured CUDA graphs, headroom, and what is left for
 * the KV cache.
 */
import { BYTES_PER_PARAM, type ModelSpec, type Precision, type ReplicaSpec } from "../hardware/catalog.js";
import { BLOCK_TOKENS } from "../kvcache/blocks.js";

/** Bytes per stored key or value element: the KV cache is kept in 16-bit floats. */
export const KV_BYTES_PER_ELEMENT = 2;

/**
 * Sizing assumptions for the activation and workspace pool. It is small next to weights and KV,
 * so it is sized once for a full step rather than tracked per step.
 */
export const ACTIVATION_SIZING = {
  /** Tokens in the largest step the pool must hold (the default per-step token budget). */
  stepTokens: 8192,
  /** Sequences whose logits are held at once for sampling. */
  samplingSequences: 256,
  /** Bytes per hidden activation (16-bit). */
  bytesPerActivation: 2,
  /** Bytes per logit (32-bit). */
  bytesPerLogit: 4
} as const;

/**
 * Device memory that the engine's captured CUDA graphs hold, per GPU: 1,159,725,056 bytes (1.08 GiB).
 *
 * vLLM captures CUDA graphs after it has sized the KV pool, so since v0.21 it measures what the capture will
 * take and subtracts it from the KV budget (`determine_available_memory` in vllm/v1/worker/gpu_worker.py:
 * `requested - non_kv_cache_memory - cudagraph_memory_estimate`). The real figure grows with the largest
 * captured batch and the model's width. This is a flat figure, as the BLIS substrate registry carries it:
 * the median of 22 vLLM start-up logs ("Graph capturing finished ... took X GiB") on A100, B200, GB200, H100,
 * H200 and L40S whose graph mode is `FULL_AND_PIECEWISE` (the default), interquartile range 0.69 to 1.83 GiB
 * (blis-substrate, registry/coefficients/cost-model-memory.yaml, `cudagraph_capture_bytes_full_and_piecewise`).
 * It is a median over uncontrolled deployments, not a measurement of any one model; a visitor's model on a
 * real cluster may differ by half a gigabyte either way. It is a parameter of the teaching model, not tuned.
 */
export const CUDA_GRAPH_BYTES = 1_159_725_056;

/** A replica whose KV pool holds fewer blocks than this cannot serve a single short request. */
export const MIN_USABLE_POOL_BLOCKS = 8;

/** Bytes of weights for the whole model. Example: 8.03e9 parameters in BF16 is 16.06 GB. */
export function weightBytes(m: ModelSpec, p: Precision): number {
  return m.N * BYTES_PER_PARAM[p];
}

/**
 * KV cache bytes per token of context.
 *
 *     bytes = 2 · n_layers · n_kv_heads · d_head · bytes_per_element
 *
 * One key and one value vector (the factor 2) per layer and per key/value head. This is the
 * quantity PagedAttention pages (Kwon et al., SOSP 2023, section 3). With grouped-query attention
 * n_kv_heads is smaller than the number of query heads, which is why it appears here.
 *
 * Example: Llama 3.1 8B: 2 · 32 · 8 · 128 · 2 = 131,072 bytes, so 128 KiB per token and about
 * 0.5 GB for a 4,096-token context.
 */
export function kvBytesPerToken(m: ModelSpec): number {
  return 2 * m.nL * m.nKv * m.dH * KV_BYTES_PER_ELEMENT;
}

/**
 * Activations and workspace for one full step on one GPU: residual stream and feed-forward buffers for
 * every token in the step, plus logits for the sequences being sampled.
 *
 * Tensor parallelism keeps the residual stream whole on every GPU but gives each GPU only `d_ff / tp` of the
 * feed-forward width (the up and gate projections are split by column; Shoeybi et al., 2019). The logits
 * are gathered over the whole vocabulary for sampling, so they are not split.
 *
 * Example: Llama 3.1 8B, one GPU: 8192 · (2·4096 + 2·14336) · 2 + 256 · 128256 · 4 = 735.3 MB. Llama 3.1 70B on
 * four GPUs: 8192 · (2·8192 + 2·28672/4) · 2 + 256 · 128256 · 4 = 634.7 MB, where it would be 1.34 GB unsplit.
 *
 * BLIS prices the same pass as 11 (one GPU) or 5 (four GPUs) bf16 hidden-state rows per token of the step,
 * from NVIDIA's memory model: 738.2 MB and 671.1 MB for those two examples.
 */
export function activationBytes(m: ModelSpec, tp = 1): number {
  const a = ACTIVATION_SIZING;
  return a.stepTokens * (2 * m.d + (2 * m.dFf) / tp) * a.bytesPerActivation + a.samplingSequences * m.vocab * a.bytesPerLogit;
}

export interface MemoryBudget {
  /** HBM capacity of one GPU as the vendor names it, bytes. For labels; it sizes nothing. */
  hbm: number;
  /** Memory the driver reports for one GPU, bytes: the figure `gpu_memory_utilization` applies to. */
  device: number;
  /** Weight bytes on one GPU (the model is split across `tp` GPUs). */
  weights: number;
  activations: number;
  /** Captured CUDA graphs, per GPU. */
  graphs: number;
  /** Memory the engine is told not to use: what is left of the device after its requested share. */
  headroom: number;
  /** KV pool per GPU, bytes. Negative when the model does not fit. */
  kv: number;
  /** KV blocks across the whole replica. */
  poolBlocks: number;
  /** Bytes of one KV block. */
  blockBytes: number;
  /** Whether the replica can serve at all. */
  fits: boolean;
}

/**
 * Split one GPU's memory into its five pools.
 *
 *     requested = ceil(device · gpu_memory_utilization)
 *     kv        = requested − weights / tp − activations − CUDA graphs
 *
 * vLLM sizes its KV block pool this way at start-up (`request_memory` and `determine_available_memory`,
 * vllm/v1/worker/utils.py and gpu_worker.py): it requests `gpu_memory_utilization` of the memory the driver
 * reports for the device, measures what the weights, one profiling pass and the CUDA-graph capture take,
 * and gives the remainder to the cache. Tensor parallelism splits the weights and each KV block evenly
 * over the `tp` GPUs (Shoeybi et al., 2019), so the replica's pool is `tp` times one GPU's.
 *
 * Example: Llama 3.1 8B on one H100 (85.03 GB reported, sold as 80 GB) at 0.9 utilisation:
 * 76.53 − 16.06 − 0.74 − 1.16 = 58.57 GB of KV, or 27,926 blocks of 16 tokens. The same replica on
 * a 80 GB datasheet figure would have 26,323 blocks, 6% fewer than vLLM's logs give.
 */
export function memoryBudget(r: ReplicaSpec): MemoryBudget {
  const weights = weightBytes(r.model, r.precision) / r.tp;
  const activations = activationBytes(r.model, r.tp);
  const graphs = CUDA_GRAPH_BYTES;
  const requested = Math.ceil(r.gpu.memory * r.gpuMemUtil);
  const kv = requested - weights - activations - graphs;
  const blockBytes = BLOCK_TOKENS * kvBytesPerToken(r.model);
  const poolBlocks = Math.max(0, Math.floor((r.tp * kv) / blockBytes));
  return { hbm: r.gpu.hbm, device: r.gpu.memory, weights, activations, graphs, headroom: r.gpu.memory - requested, kv, poolBlocks, blockBytes, fits: poolBlocks >= MIN_USABLE_POOL_BLOCKS };
}

/**
 * Largest batch of sequences that each hold `L` tokens of context.
 *
 * Example: the 58.57 GB pool above holds floor(58.57e9 / (4096 · 131072)) = 109 sequences of
 * 4,096 tokens.
 */
export function maxBatch(r: ReplicaSpec, L: number): number {
  const b = memoryBudget(r);
  return Math.max(0, Math.floor((r.tp * b.kv) / (L * kvBytesPerToken(r.model))));
}
