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
  /** High-bandwidth memory capacity as the vendor names it ("80 GB"), bytes. Used for labels. */
  hbm: number;
  /**
   * Memory the CUDA or ROCm driver reports for the device, bytes. This, not the datasheet figure, is
   * what vLLM multiplies by `gpu_memory_utilization` (`request_memory` in vllm/v1/worker/utils.py:
   * `ceil(total_memory * gpu_memory_utilization)`), so it sizes the KV pool. It is lower than the
   * name suggests in GiB and higher in GB: an H100 sold as "80 GB" reports 79.19 GiB = 85.03 GB.
   */
  memory: number;
  /** Where `memory` comes from: a measurement of the real device, or the datasheet when none is known. */
  memorySource: CitationKey;
  /** Memory bandwidth, bytes/s. */
  bw: number;
  source: CitationKey;
}

/**
 * Architecture values are read from each model's published `config.json`. `N` is the parameter count
 * those values imply (embedding and untied output head, then per layer the attention projections and the
 * three feed-forward matrices): Llama 3.1 8B 8.03e9, Llama 3.1 70B 70.55e9. The 70B model is often called
 * "70B"; the weights a GPU holds are the 70.55e9.
 */
export const MODELS: Record<string, ModelSpec> = {
  "llama-3.1-8b": { id: "llama-3.1-8b", label: "Llama 3.1 8B", N: 8.03e9, nL: 32, nH: 32, nKv: 8, dH: 128, d: 4096, dFf: 14336, vocab: 128256, source: "llama31Card" },
  "llama-3.1-70b": { id: "llama-3.1-70b", label: "Llama 3.1 70B", N: 70.55e9, nL: 80, nH: 64, nKv: 8, dH: 128, d: 8192, dFf: 28672, vocab: 128256, source: "llama3170Card" }
};

/**
 * `memory` is what the driver reports, measured on real devices: the H100 and H200 figures are the
 * `torch total_memory` that vLLM's own reports print (the cited issues), the B200's is the device total in the
 * BLIS substrate catalogue (from a vLLM start-up log). No measured figure for the MI300X is cited here, so it
 * keeps the datasheet's 192 GB; on a real MI300X the pool would be somewhat different.
 *
 * The RTX PRO 6000 and RTX 4090 `memory` values are `device_total_memory_bytes` of the `meta.json` of real vLLM runs on those
 * devices (101.98 GB = 94.97 GiB; 25.25 GB = 23.52 GiB). The RTX 4090's peak is the whitepaper's BF16 tensor figure with FP32
 * accumulate, dense (165.2; 330.4 with sparsity). NVIDIA's page for the RTX PRO 6000 Server Edition gives one figure,
 * "FP16 | BF16 Tensor Core 1 PFLOP", without saying whether it assumes sparsity; as for the other Blackwell parts it is read as the sparse
 * headline and halved, to 500e12. That is probably generous for BF16 with FP32 accumulate (third-party sheets list about half
 * of it), and a fitted MFU absorbs the difference; it is stated here because the number is not confirmed by a first-party table.
 *
 * Peak compute is the dense figure. Vendors of Hopper and Blackwell parts headline a number that
 * assumes structured sparsity; it is halved here, because LLM weights are dense.
 */
export const GPUS: Record<string, GpuSpec> = {
  h100: { id: "h100", label: "H100 SXM", peak: 989.5e12, hbm: 80e9, memory: 85_029_158_912, memorySource: "vllmUsageStats", bw: 3.35e12, source: "nvidiaH100" },
  h200: { id: "h200", label: "H200 SXM", peak: 989.5e12, hbm: 141e9, memory: 150_109_880_320, memorySource: "blisSubstrateCatalog", bw: 4.8e12, source: "nvidiaH200" },
  b200: { id: "b200", label: "B200", peak: 2250e12, hbm: 180e9, memory: 191_503_007_744, memorySource: "blisSubstrateCatalog", bw: 7.7e12, source: "nvidiaB200" },
  "rtx-pro-6000": { id: "rtx-pro-6000", label: "RTX PRO 6000", peak: 500e12, hbm: 96e9, memory: 101_976_440_832, memorySource: "llmservingsimBench", bw: 1.597e12, source: "nvidiaRtxPro6000" },
  "rtx-4090": { id: "rtx-4090", label: "RTX 4090", peak: 165.2e12, hbm: 24e9, memory: 25_250_627_584, memorySource: "llmservingsimBench", bw: 1.008e12, source: "nvidiaAda" },
  mi300x: { id: "mi300x", label: "MI300X", peak: 1307.4e12, hbm: 192e9, memory: 192e9, memorySource: "amdMi300x", bw: 5.3e12, source: "amdMi300x" }
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
