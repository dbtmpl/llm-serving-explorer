/**
 * Where a GPU's memory goes: weights, activations, captured CUDA graphs, headroom, and what is left for
 * the KV cache.
 */
import { BYTES_PER_PARAM, type ModelSpec, type Precision, type ReplicaSpec } from "../hardware/catalog.js";
import { BLOCK_TOKENS } from "../kvcache/blocks.js";

/** Bytes per stored key or value element: the KV cache is kept in 16-bit floats. */
export const KV_BYTES_PER_ELEMENT = 2;

/** Bytes per element of the hidden activations the forward pass keeps (16-bit). */
const BYTES_PER_ACTIVATION = 2;

/**
 * Bytes that one row of vocabulary-wide sampler state takes per vocabulary entry: the 16-bit logits the
 * language-model head returns (2), their 32-bit copy (`logits.to(torch.float32)` in vllm/v1/sample/sampler.py, 4)
 * and the 32-bit probabilities (`logits.softmax(dim=-1, dtype=torch.float32)` in
 * vllm/v1/sample/ops/topk_topp_sampler.py, 4). These three exist on every sampling path; a path that sorts
 * (top-k/top-p in PyTorch) keeps 12 more bytes per entry (values and 64-bit indices), the Triton and FlashInfer
 * paths none, so the figure is the part that does not depend on the backend.
 */
export const SAMPLER_BYTES_PER_LOGIT = 2 + 4 + 4;

/** Bytes one captured CUDA graph costs beyond the pool that all graphs share: vLLM counts at least 1 MiB per graph (`profile_cudagraph_memory`, gpu_model_runner.py: `max(mem_samples[1], 1 << 20)`). */
export const GRAPH_BYTES_FLOOR = 1 << 20;

/**
 * Memory each GPU of a running engine holds outside what the model above derives, bytes: the CUDA context,
 * cuBLAS and NCCL workspaces, allocator slack and the part of the CUDA graphs beyond vLLM's 1 MiB floor.
 * vLLM measures it at start-up as the non-PyTorch increase and the graph capture, and subtracts it before
 * it sizes the KV pool (`determine_available_memory`, gpu_worker.py); no closed form gives it.
 *
 * Empirical, fitted to the two measured vLLM runs (conformance/refs/vllm-measured): with this term at zero
 * the model's pool was larger than the engine's by 0.64 GB of KV on the RTX PRO 6000 and 0.77 GB on the
 * RTX 4090. 0.7 GB, rounded, is their midpoint; it leaves the PRO 6000 within 0.1 percent of the engine's
 * block count and the 4090, whose v0.19 engine accounts for graphs differently, 1.2 percent above it.
 * BLIS charges more (an assumed 1.16 GB median for graphs alone), see conformance/scenarios/kv-budget-*.
 */
export const RUNTIME_OVERHEAD_BYTES = 0.7e9;

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

/** Hidden-state working space of a forward pass over `tokens` tokens, bytes per GPU. */
function forwardBytes(m: ModelSpec, tp: number, tokens: number): number {
  return tokens * (2 * m.d + (2 * m.dFf) / tp) * BYTES_PER_ACTIVATION;
}

/**
 * Peak activation memory of the start-up profiling pass, bytes per GPU.
 *
 * vLLM sizes the KV pool after one dummy step, `profile_run` (vllm/v1/worker/gpu_model_runner.py): a forward
 * pass over `max_num_batched_tokens` tokens (`_dummy_run(self.max_num_tokens, ...)`), whose hidden states stay
 * alive while the sampler runs over `min(max_num_batched_tokens, max_num_seqs)` rows (`num_reqs = min(num_tokens,
 * max_num_reqs)` in `_dummy_run`, then `_dummy_sampler_run`). The peak is the larger of the two moments:
 *
 *     forward = T · (2 d + 2 d_ff / tp) · 2 bytes                       (residual stream and feed-forward buffers)
 *     sampler = T · d · 2  +  min(T, max_num_seqs) · vocab · 10 bytes   (hidden states kept, vocabulary-wide rows)
 *     activations = max(forward, sampler)
 *
 * with T = `max_num_batched_tokens`. Tensor parallelism keeps the residual stream whole on every GPU but gives
 * each GPU `d_ff / tp` of the feed-forward width (Shoeybi et al., 2019); the sampler rows are gathered over the
 * whole vocabulary, so they are not split. Both terms are sums of the buffers a pass must hold at once, not a
 * measurement: the real peak also holds allocator rounding and the scratch space of fused kernels.
 *
 * Example: Llama 3.1 8B, one GPU, T = 2,048 and 256 sequences (the settings of the RTX 4090 run): forward
 * 151.0 MB, sampler 16.8 + 328.4 = 345.2 MB, so 345.2 MB. At T = 8,192 and 256 sequences the forward pass is
 * 604.0 MB and decides.
 */
export function activationBytes(m: ModelSpec, tp = 1, maxNumBatchedTokens = 8192, maxNumSeqs = 256): number {
  const forward = forwardBytes(m, tp, maxNumBatchedTokens);
  const sampler = maxNumBatchedTokens * m.d * BYTES_PER_ACTIVATION + Math.min(maxNumBatchedTokens, maxNumSeqs) * m.vocab * SAMPLER_BYTES_PER_LOGIT;
  return Math.max(forward, sampler);
}

/**
 * Batch sizes vLLM captures CUDA graphs for, from `max_num_seqs` (`_set_cudagraph_sizes`, vllm/config/vllm.py):
 * 1, 2, 4, multiples of 8 below 256, then multiples of 16, up to `min(2 · max_num_seqs, 512)` and never more
 * than `max_num_batched_tokens`. Example: 256 sequences give 51 sizes (the 4090 run's list), 128 give 35.
 */
export function graphCaptureSizes(maxNumSeqs: number, maxNumBatchedTokens: number): number[] {
  const top = Math.min(2 * maxNumSeqs, 512, maxNumBatchedTokens);
  const all = [1, 2, 4];
  for (let s = 8; s < 256; s += 8) all.push(s);
  for (let s = 256; s <= 512; s += 16) all.push(s);
  return all.filter((s) => s <= top);
}

/**
 * Memory the captured CUDA graphs take, bytes per GPU.
 *
 * Since v0.21 vLLM measures this before it sizes the KV pool and subtracts it (`profile_cudagraph_memory` and
 * `determine_available_memory`, gpu_worker.py). Its own estimate is: the graphs of one mode share a pool, and the two
 * modes (piecewise for every size, full for the decode sizes) overlay each other, so the shared part is that of the
 * largest capture; every further graph adds at least 1 MiB. The model takes exactly that, with the shared pool sized
 * as the forward pass over the largest captured batch:
 *
 *     graphs = forward(largest size) + (piecewise sizes + full sizes − 2) · 1 MiB
 *
 * It is a lower bound: the 1 MiB is vLLM's own floor, and a real graph of a deep model is larger. Releases before
 * v0.21 (the RTX 4090 run's v0.19.0) did not subtract it at all. The earlier flat figure of 1.08 GiB was the median
 * of start-up logs across models and GPUs and did not depend on any setting.
 *
 * Example: Llama 3.1 8B, 128 sequences: 35 piecewise and 19 full sizes, forward(256 tokens) 18.9 MB + 52 MiB = 73.4 MB.
 */
export function graphBytes(m: ModelSpec, tp = 1, maxNumSeqs = 256, maxNumBatchedTokens = 8192): number {
  const sizes = graphCaptureSizes(maxNumSeqs, maxNumBatchedTokens);
  const full = sizes.filter((s) => s <= maxNumSeqs).length;
  const largest = sizes[sizes.length - 1] ?? 0;
  return forwardBytes(m, tp, largest) + Math.max(0, sizes.length + full - 2) * GRAPH_BYTES_FLOOR;
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
  /** CUDA context, library workspaces and other memory outside the derived terms, per GPU (`RUNTIME_OVERHEAD_BYTES`). */
  runtime: number;
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
 *     kv        = requested − weights / tp − activations − CUDA graphs − runtime overhead
 *
 * vLLM sizes its KV block pool this way at start-up (`request_memory` and `determine_available_memory`,
 * vllm/v1/worker/utils.py and gpu_worker.py): it requests `gpu_memory_utilization` of the memory the driver
 * reports for the device, measures what the weights, one profiling pass, the CUDA-graph capture and
 * everything outside PyTorch take, and gives the remainder to the cache. The last is the empirical
 * `RUNTIME_OVERHEAD_BYTES`. Tensor parallelism splits the weights and each KV block evenly
 * over the `tp` GPUs (Shoeybi et al., 2019), so the replica's pool is `tp` times one GPU's.
 *
 * Example: Llama 3.1 8B on one H100 (85.03 GB reported, sold as 80 GB) at 0.9 utilisation, 12 sequences
 * and an 8,192-token budget: 76.53 − 16.06 − 0.60 − 0.01 − 0.70 = 59.15 GB of KV, or 28,205 blocks of 16
 * tokens (BLIS, which charges 1.16 GB for graphs, gives 27,926). Counting on the 80 GB datasheet figure
 * instead would give about 6% fewer.
 */
export function memoryBudget(r: ReplicaSpec): MemoryBudget {
  const weights = weightBytes(r.model, r.precision) / r.tp;
  const activations = activationBytes(r.model, r.tp, r.maxNumBatchedTokens, r.maxNumSeqs);
  const graphs = graphBytes(r.model, r.tp, r.maxNumSeqs, r.maxNumBatchedTokens);
  const requested = Math.ceil(r.gpu.memory * r.gpuMemUtil);
  const runtime = RUNTIME_OVERHEAD_BYTES;
  const kv = requested - weights - activations - graphs - runtime;
  const blockBytes = BLOCK_TOKENS * kvBytesPerToken(r.model);
  const poolBlocks = Math.max(0, Math.floor((r.tp * kv) / blockBytes));
  return { hbm: r.gpu.hbm, device: r.gpu.memory, weights, activations, graphs, runtime, headroom: r.gpu.memory - requested, kv, poolBlocks, blockBytes, fits: poolBlocks >= MIN_USABLE_POOL_BLOCKS };
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
