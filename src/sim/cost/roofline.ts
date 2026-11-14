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

export interface StepCost {
  /** Memory-bound time, seconds. */
  tMem: number;
  /** Compute-bound time, seconds. */
  tCompute: number;
  /** GPU time of the step: the larger of the two. */
  tGpu: number;
  /** Arithmetic intensity F / M, FLOP per byte. */
  intensity: number;
  bound: "memory" | "compute";
}

/**
 * Step time under the roofline, with achieved rather than peak rates.
 *
 *     t_mem     = M / (tp · W · MBU)
 *     t_compute = F / (tp · P · MFU)
 *     t_gpu     = max(t_mem, t_compute)
 *
 * MBU and MFU (memory-bandwidth and FLOP utilisation, both in (0, 1]) are the fraction of the
 * datasheet rate real kernels reach. They are parameters, not constants of the model.
 * Tensor parallelism multiplies both rates by `tp`.
 *
 * Example: Llama 3.1 8B on an H100, 64 sequences at 2,048 tokens, MBU = MFU = 1:
 * M = 16.06 GB + 64 · 2048 · 131072 B = 33.24 GB, so t_mem = 33.24e9 / 3.35e12 = 9.92 ms.
 * F = 64 · 2 · 8.03e9 = 1.03e12, so t_compute = 1.04 ms. The step is memory-bound at
 * I = 30.9 FLOP/byte, far left of the ridge at 295.
 */
export function stepCost(r: ReplicaSpec, load: StepLoad, mbu: number, mfu: number): StepCost {
  const tMem = load.bytes / (r.tp * r.gpu.bw * mbu);
  const tCompute = load.flops / (r.tp * r.gpu.peak * mfu);
  return {
    tMem,
    tCompute,
    tGpu: Math.max(tMem, tCompute),
    intensity: load.bytes > 0 ? load.flops / load.bytes : 0,
    bound: tMem >= tCompute ? "memory" : "compute"
  };
}

/** Compute-bound time to process `flops` on a replica, seconds. Used to price a recompute. */
export function computeSeconds(r: ReplicaSpec, flops: number, mfu: number): number {
  return flops / (r.tp * r.gpu.peak * mfu);
}
