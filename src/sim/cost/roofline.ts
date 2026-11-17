/**
 * Roofline model of one engine step.
 *
 * Source: Williams, Waterman and Patterson, CACM 2009. A kernel that needs F FLOPs and moves M
 * bytes on a machine with peak compute P (FLOP/s) and memory bandwidth W (bytes/s) cannot finish
 * faster than
 *
 *     t ≥ max(F / P, M / W)
 *
 * Its arithmetic intensity I = F / M decides which term binds. The crossover I* = P / W is the
 * ridge point: below it the step is memory-bound, above it compute-bound.
 *
 * Applied to LLM serving: a decode step reads every weight and every running sequence's KV cache
 * to produce one token per sequence, so it has low intensity and is memory-bound. A prefill chunk
 * does thousands of tokens of arithmetic for the same weight read, so it is compute-bound.
 */
import type { GpuSpec, ReplicaSpec } from "../hardware/catalog.js";
import { graphCaptureSizes } from "./memory.js";

/** Ridge point of a GPU in FLOP per byte. Example: H100, 989.5e12 / 3.35e12 = 295. */
export function ridge(g: GpuSpec): number {
  return g.peak / g.bw;
}

/** Everything one engine step has to do. */
export interface StepLoad {
  /** Tokens processed: decode tokens plus prefill chunk tokens. */
  tokens: number;
  flops: number;
  /** Bytes read from memory: all weights once, plus the KV cache of every sequence in the step. */
  bytes: number;
}

/** The efficiency and overhead parameters of a step's price (`Params` carries them under the same names). */
export interface StepTiming {
  /** Achieved share of peak memory bandwidth, in (0, 1]. */
  mbu: number;
  /** Achieved share of peak FLOP/s, in (0, 1]. */
  mfu: number;
  /** Share of the link bandwidth an all-reduce reaches, in (0, 1]. Used only when `tp > 1`. */
  commEff: number;
  /** Fixed time of one all-reduce, microseconds (launch plus ring latency). Used only when `tp > 1`. */
  commLatencyUs: number;
  /** Launch time per layer of a step replayed from a CUDA graph, microseconds. */
  launchUs: number;
  /** Launch time per layer of a step too large to be captured and run eagerly, microseconds. */
  launchEagerUs: number;
}

export interface StepCost {
  /** Memory-bound time, seconds. */
  tMem: number;
  /** Compute-bound time, seconds. */
  tCompute: number;
  /** Tensor-parallel all-reduce time, seconds; 0 on one GPU. */
  tComm: number;
  /** Kernel launch time of the step, seconds. */
  tLaunch: number;
  /** GPU time of the step: the roofline's larger of memory and compute, plus communication and launch. */
  tGpu: number;
  /** Arithmetic intensity F / M, FLOP per byte. */
  intensity: number;
  bound: "memory" | "compute";
}

/** Bytes per element an all-reduce moves: the hidden state in 16-bit floats. */
const ALLREDUCE_BYTES_PER_ELEMENT = 2;

/**
 * Time of the tensor-parallel all-reduces of a step that processes `tokens` tokens, seconds.
 *
 *     t_comm = 2 · n_layers · ( α + tokens · d · 2 B · 2(tp − 1)/tp / (link · η) )     (tp > 1, else 0)
 *
 * Megatron-style tensor parallelism all-reduces the hidden state twice per layer, after the attention block and after the
 * feed-forward block (Shoeybi et al., 2019, section 3). A ring all-reduce moves 2(n − 1)/n of the message through each
 * GPU's link (the bus-bandwidth definition of NCCL's tests, doc/PERFORMANCE.md); `link` is the one-way NVLink rate
 * of the GPU, `η` the share of it the all-reduce reaches, and `α` the fixed cost of each all-reduce, which is what
 * the small messages of a decode step pay. Pope et al. (2022) count the same communication volume in their
 * analytical latency model. The collectives are not overlapped with the GEMMs, so the term adds to the roofline.
 *
 * Example: Llama 3.1 70B on 4 H200s (link 450 GB/s), 8,192 tokens: 8,192 · 8,192 · 2 B = 134 MB per all-reduce,
 * times 1.5 = 201 MB through the link, which at η = 0.35 takes 1.28 ms; 160 all-reduces take 205 ms.
 */
export function commSeconds(r: ReplicaSpec, tokens: number, t: Pick<StepTiming, "commEff" | "commLatencyUs">): number {
  if (r.tp <= 1) return 0;
  const bytes = tokens * r.model.d * ALLREDUCE_BYTES_PER_ELEMENT * ((2 * (r.tp - 1)) / r.tp);
  return 2 * r.model.nL * (t.commLatencyUs * 1e-6 + bytes / (r.gpu.link * t.commEff));
}

/**
 * Kernel launch time of a step, seconds: a fixed time per layer, much larger for a step that runs eagerly.
 *
 * vLLM replays a captured CUDA graph for steps up to its largest capture size and launches the kernels one by one for
 * larger ones (vLLM design document "CUDA Graphs"; the capture list is `graphCaptureSizes`). The per-layer figures are
 * a parameter: the defaults are BLIS's kernel-model values for decode (32 µs per layer replayed, 102 µs eager). They are BLIS's own and, by its registry's account, assumed from conventional launch costs and one eager anchor, not measured on vLLM: no public measurement of vLLM's per-layer launch time was found.
 */
export function launchSeconds(r: ReplicaSpec, tokens: number, t: Pick<StepTiming, "launchUs" | "launchEagerUs">): number {
  const captured = tokens <= largestCapture(r);
  return r.model.nL * (captured ? t.launchUs : t.launchEagerUs) * 1e-6;
}

/** Tokens in the largest step vLLM captures a CUDA graph for. */
export function largestCapture(r: ReplicaSpec): number {
  const sizes = graphCaptureSizes(r.maxNumSeqs, r.maxNumBatchedTokens);
  return sizes[sizes.length - 1] ?? 0;
}

/**
 * Step time under the roofline, with achieved rather than peak rates, plus what the roofline leaves out.
 *
 *     t_mem     = M / (tp · W · MBU)
 *     t_compute = F / (tp · P · MFU)
 *     t_gpu     = max(t_mem, t_compute) + t_comm + t_launch
 *
 * MBU and MFU (memory-bandwidth and FLOP utilisation, both in (0, 1]) are the fraction of the datasheet rate real
 * kernels reach. They are parameters, not constants of the model. Tensor parallelism multiplies both rates by `tp`
 * and adds the all-reduces (`commSeconds`); launching the layers' kernels adds a per-layer time (`launchSeconds`).
 * Memory and compute overlap inside a GPU, so they take a maximum; communication and launch gaps do not overlap
 * with them, so they add.
 *
 * Example: Llama 3.1 8B on an H100, 64 sequences at 2,048 tokens, MBU = MFU = 1:
 * M = 16.06 GB + 64 · 2048 · 131072 B = 33.24 GB, so t_mem = 33.24e9 / 3.35e12 = 9.92 ms.
 * F = 64 · 2 · 8.03e9 = 1.03e12, so t_compute = 1.04 ms. The step is memory-bound at
 * I = 30.9 FLOP/byte, far left of the ridge at 295.
 */
export function stepCost(r: ReplicaSpec, load: StepLoad, t: StepTiming): StepCost {
  const tMem = load.bytes / (r.tp * r.gpu.bw * t.mbu);
  const tCompute = load.flops / (r.tp * r.gpu.peak * t.mfu);
  const tComm = commSeconds(r, load.tokens, t);
  const tLaunch = launchSeconds(r, load.tokens, t);
  return {
    tMem,
    tCompute,
    tComm,
    tLaunch,
    tGpu: Math.max(tMem, tCompute) + tComm + tLaunch,
    intensity: load.bytes > 0 ? load.flops / load.bytes : 0,
    bound: tMem >= tCompute ? "memory" : "compute"
  };
}

/**
 * Time to run `flops` of prefill arithmetic over `tokens` tokens on a replica, seconds: compute at the achieved rate
 * plus, on several GPUs, the all-reduces those tokens need. Used to price a recompute against a reload, which has
 * to count the same communication a real prefill pays.
 */
export function computeSeconds(r: ReplicaSpec, flops: number, t: Pick<StepTiming, "mfu" | "commEff" | "commLatencyUs">, tokens = 0): number {
  return flops / (r.tp * r.gpu.peak * t.mfu) + (tokens > 0 ? commSeconds(r, tokens, t) : 0);
}
