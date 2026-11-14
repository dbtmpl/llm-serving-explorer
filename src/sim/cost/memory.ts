/**
 * Where a GPU's memory goes: weights, activations, headroom, and what is left for the KV cache.
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
 * Activations and workspace for one full step: residual stream and feed-forward buffers for every
 * token in the step, plus logits for the sequences being sampled.
 */
export function activationBytes(m: ModelSpec): number {
  const a = ACTIVATION_SIZING;
  return a.stepTokens * (2 * m.d + 2 * m.dFf) * a.bytesPerActivation + a.samplingSequences * m.vocab * a.bytesPerLogit;
}

export interface MemoryBudget {
  /** HBM capacity of one GPU, bytes. */
  hbm: number;
  /** Weight bytes on one GPU (the model is split across `tp` GPUs). */
  weights: number;
  activations: number;
  /** Memory the engine is told not to use: (1 - gpu_memory_utilization) · HBM. */
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
 * Split one GPU's memory into its four pools.
 *
 *     kv = HBM − weights / tp − activations − (1 − gpu_memory_utilization) · HBM
 *
 * vLLM sizes its KV block pool this way at start-up: it takes `gpu_memory_utilization` of the
 * device, loads the weights, and gives the remainder to the cache (vLLM docs, engine arguments).
 * Tensor parallelism splits the weights and each KV block evenly over the `tp` GPUs
 * (Shoeybi et al., 2019), so the replica's pool is `tp` times one GPU's.
 *
 * Example: Llama 3.1 8B on one 80 GB H100 at 0.9 utilisation:
 * 80 − 16.06 − 0.74 − 8 = 55.2 GB of KV, or about 26,300 blocks of 16 tokens.
 */
export function memoryBudget(r: ReplicaSpec): MemoryBudget {
  const weights = weightBytes(r.model, r.precision) / r.tp;
  const activations = activationBytes(r.model);
  const headroom = (1 - r.gpuMemUtil) * r.gpu.hbm;
  const kv = r.gpu.hbm - weights - activations - headroom;
  const blockBytes = BLOCK_TOKENS * kvBytesPerToken(r.model);
  const poolBlocks = Math.max(0, Math.floor((r.tp * kv) / blockBytes));
  return { hbm: r.gpu.hbm, weights, activations, headroom, kv, poolBlocks, blockBytes, fits: poolBlocks >= MIN_USABLE_POOL_BLOCKS };
}

/**
 * Largest batch of sequences that each hold `L` tokens of context.
 *
 * Example: the 55.2 GB pool above holds floor(55.2e9 / (4096 · 131072)) = 102 sequences of
 * 4,096 tokens.
 */
export function maxBatch(r: ReplicaSpec, L: number): number {
  const b = memoryBudget(r);
  return Math.max(0, Math.floor((r.tp * b.kv) / (L * kvBytesPerToken(r.model))));
}
