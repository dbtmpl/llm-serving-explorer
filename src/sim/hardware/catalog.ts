/**
 * Declared facts about models and accelerators. Nothing here is computed.
 *
 * Units: parameters and tokens are counts; memory is in bytes with decimal prefixes
 * (1 GB = 1e9 bytes), as on vendor datasheets; compute is FLOP/s; bandwidth is bytes/s.
 */
import type { CitationKey } from "../citations.js";

export interface ModelSpec {
  id: string;
  label: string;
  /** Number of parameters. */
  N: number;
  /** Transformer layers. */
  nL: number;
  /** Attention heads per layer. */
  nH: number;
  /** Key/value heads per layer. Fewer than `nH` under grouped-query attention. */
  nKv: number;
  /** Dimension of one attention head. */
  dH: number;
  /** Hidden size. */
  d: number;
  /** Feed-forward inner size. */
  dFf: number;
  /** Vocabulary size. */
  vocab: number;
  source: CitationKey;
}

export interface GpuSpec {
  id: string;
  label: string;
  /** Peak dense 16-bit floating-point throughput, FLOP/s. */
  peak: number;
  /** High-bandwidth memory capacity, bytes. */
  hbm: number;
  /** Memory bandwidth, bytes/s. */
  bw: number;
  source: CitationKey;
}

/** Architecture values are read from each model's published `config.json`. */
export const MODELS: Record<string, ModelSpec> = {
  "llama-3.1-8b": { id: "llama-3.1-8b", label: "Llama 3.1 8B", N: 8.03e9, nL: 32, nH: 32, nKv: 8, dH: 128, d: 4096, dFf: 14336, vocab: 128256, source: "llama31Card" },
  "llama-3-70b": { id: "llama-3-70b", label: "Llama 3 70B", N: 70e9, nL: 80, nH: 64, nKv: 8, dH: 128, d: 8192, dFf: 28672, vocab: 128256, source: "llama370Card" }
};

/**
 * Peak compute is the dense figure. Vendors of Hopper and Blackwell parts headline a number that
 * assumes structured sparsity; it is halved here, because LLM weights are dense.
 */
export const GPUS: Record<string, GpuSpec> = {
  h100: { id: "h100", label: "H100 SXM", peak: 989.5e12, hbm: 80e9, bw: 3.35e12, source: "nvidiaH100" },
  h200: { id: "h200", label: "H200 SXM", peak: 989.5e12, hbm: 141e9, bw: 4.8e12, source: "nvidiaH200" },
  b200: { id: "b200", label: "B200", peak: 2250e12, hbm: 180e9, bw: 7.7e12, source: "nvidiaB200" },
  mi300x: { id: "mi300x", label: "MI300X", peak: 1307.4e12, hbm: 192e9, bw: 5.3e12, source: "amdMi300x" }
};

/** Weight storage formats and their size per parameter. */
export type Precision = "bf16" | "fp8";
export const BYTES_PER_PARAM: Record<Precision, number> = { bf16: 2, fp8: 1 };

/** One serving replica (pod): a model on `tp` identical GPUs. */
export interface ReplicaSpec {
  model: ModelSpec;
  gpu: GpuSpec;
  precision: Precision;
  /** Tensor-parallel degree: GPUs per pod. */
  tp: number;
  /** vLLM's `gpu_memory_utilization`: the share of HBM the engine may use. */
  gpuMemUtil: number;
}
