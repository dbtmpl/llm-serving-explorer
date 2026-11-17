/**
 * Concept: the cost model. How long does an engine step take, and how much memory is there?
 *
 * These are closed-form quantities rather than interchangeable policies, but they follow the same
 * rule as everything else: each is tied to a source and checked by a unit test.
 */
import type { ApproachMeta, Concept } from "../approach.js";
import { MEASURED, TIMING, TIMING_70B_H200, TIMING_8B_H100 } from "../verification.js";

export * from "./flops.js";
export * from "./host.js";
export * from "./memory.js";
export * from "./roofline.js";
export * from "./throughput.js";

export const rooflineStepTime: ApproachMeta = {
  id: "roofline",
  name: "Roofline step time",
  summary: "A step takes the longer of FLOPs over achieved compute and bytes over achieved memory bandwidth (MBU 0.85, MFU 0.7 by default), plus communication and launch time.",
  citations: ["williams2009", "nvidiaBlackwellProWhitepaper", "llmservingsimBench"],
  fidelity: "exact",
  verification: [...TIMING]
};

export const flopCount: ApproachMeta = {
  id: "flops-per-token",
  name: "FLOPs per token",
  summary: "2N per token through the weights, plus an attention term linear in context length.",
  citations: ["kaplan2020", "vaswani2017"],
  fidelity: "exact",
  verification: [...TIMING]
};

export const kvFootprint: ApproachMeta = {
  id: "kv-bytes-per-token",
  name: "KV bytes per token and memory budget",
  summary: "Two vectors per layer and KV head per token; the KV pool is what weights, the start-up profiling pass (sized by max_num_batched_tokens and max_num_seqs), CUDA graphs and headroom leave of the memory the driver reports.",
  citations: ["kwon2023", "vllmEngineArgs", "vllmMemoryProfiling", "vllmMemoryProfilingV019", "vllmProfileRun", "vllmCudagraphSizes", "blisSubstrateMemory"],
  fidelity: "exact",
  verification: ["kv-budget-8b-h100", "kv-budget-70b-h200-tp4", "lss-kv-budget-8b-rtx-pro-6000", ...MEASURED]
};

export const tensorParallelism: ApproachMeta = {
  id: "tensor-parallelism",
  name: "Tensor parallelism",
  summary: "Weights and KV are split evenly over the GPUs of a pod; compute and bandwidth add up, and two all-reduces per layer add communication time.",
  citations: ["shoeybi2019", "pope2022", "ncclTestsPerformance"],
  fidelity: "simplified",
  verification: ["kv-budget-70b-h200-tp4", ...TIMING_70B_H200]
};

export const launchOverhead: ApproachMeta = {
  id: "kernel-launch",
  name: "Kernel launch time per layer",
  summary: "A fixed time per layer to launch a step's kernels, higher for a step too large for a captured CUDA graph.",
  citations: ["vllmCudaGraphs", "vllmCudagraphSizes", "blisSubstrateHost"],
  fidelity: "simplified",
  verification: [...TIMING_70B_H200, ...TIMING_8B_H100]
};

export const hostOverhead: ApproachMeta = {
  id: "host-overhead",
  name: "Host time per step",
  summary: "A fixed plus per-sequence CPU cost that adds to, or overlaps with, GPU time.",
  citations: ["vllmOptimization"],
  fidelity: "simplified",
  verification: [...TIMING]
};

export const chunkedPrefill: ApproachMeta = {
  id: "chunked-prefill",
  name: "Chunked prefill under a token budget",
  summary: "A long prompt is prefilled in chunks sharing each step with decodes, bounded by a per-step token budget.",
  citations: ["agrawal2024", "agrawal2023", "vllmScheduler", "vllmSchedulerConfig"],
  fidelity: "structural",
  verification: ["timing-8b-h100-burst", "timing-8b-h100-heavy", "preemption-overflow", "lss-preemption-overflow", ...MEASURED]
};

export const COST_MODEL: Concept = {
  module: "cost",
  title: "Cost model",
  question: "How long does an engine step take, and how much memory is there for KV?",
  approaches: [rooflineStepTime, flopCount, kvFootprint, tensorParallelism, launchOverhead, hostOverhead]
};

export const STEP_SCHEDULING: Concept = {
  module: "engine",
  title: "Step scheduling",
  question: "What goes into one forward pass?",
  approaches: [chunkedPrefill]
};
