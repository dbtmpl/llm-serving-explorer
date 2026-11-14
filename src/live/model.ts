/**
 * Back-of-the-envelope model of one replica: FLOPs, bytes, memory budget, roofline.
 * Every formula is from the reference notes chapter 2 (equation numbers in comments). Decimal GB throughout.
 */

export interface ModelSpec {
  id: string;
  label: string;
  /** parameters */
  N: number;
  nL: number;
  nH: number;
  nKv: number;
  dH: number;
  d: number;
  dFf: number;
  vocab: number;
}

export interface GpuSpec {
  id: string;
  label: string;
  /** dense BF16 peak, FLOP/s */
  peak: number;
  /** HBM capacity, bytes */
  hbm: number;
  /** HBM bandwidth, bytes/s */
  bw: number;
}

export const MODELS: Record<string, ModelSpec> = {
  "llama-3.1-8b": { id: "llama-3.1-8b", label: "Llama 3.1 8B", N: 8.03e9, nL: 32, nH: 32, nKv: 8, dH: 128, d: 4096, dFf: 14336, vocab: 128256 },
  "llama-3-70b": { id: "llama-3-70b", label: "Llama 3 70B", N: 70e9, nL: 80, nH: 64, nKv: 8, dH: 128, d: 8192, dFf: 28672, vocab: 128256 }
};

/** Dense figures (sparse headline halved for Hopper/Blackwell), chapter 2 section 2.3.3. */
export const GPUS: Record<string, GpuSpec> = {
  h100: { id: "h100", label: "H100 SXM", peak: 989.5e12, hbm: 80e9, bw: 3.35e12 },
  h200: { id: "h200", label: "H200 SXM", peak: 989.5e12, hbm: 141e9, bw: 4.8e12 },
  b200: { id: "b200", label: "B200", peak: 2250e12, hbm: 180e9, bw: 7.7e12 },
  mi300x: { id: "mi300x", label: "MI300X", peak: 1307.4e12, hbm: 192e9, bw: 5.3e12 }
};

export type Precision = "bf16" | "fp8";
export const BLOCK_TOKENS = 16;
const KV_BYTES_PER_ELEMENT = 2;

export interface ReplicaSpec {
  model: ModelSpec;
  gpu: GpuSpec;
  precision: Precision;
  /** tensor-parallel degree: GPUs per pod */
  tp: number;
  /** vLLM gpu_memory_utilization; headroom is 1 - this */
  gpuMemUtil: number;
}

export function weightBytes(m: ModelSpec, p: Precision): number {
  return m.N * (p === "bf16" ? 2 : 1);
}

/** (2.1) matmul FLOPs per token. */
export function flopsPerToken(m: ModelSpec): number {
  return 2 * m.N;
}

/** (2.2) attention FLOPs for one token attending over L cached tokens. */
export function attnFlops(m: ModelSpec, L: number): number {
  return 4 * m.nL * m.nH * m.dH * L;
}

/** (2.7) KV cache bytes per token of context. */
export function kvBytesPerToken(m: ModelSpec): number {
  return 2 * m.nL * m.nKv * m.dH * KV_BYTES_PER_ELEMENT;
}

/** (2.8) activations and workspace, sized for an 8,192-token step with 256 sampling sequences. */
export function activationBytes(m: ModelSpec): number {
  return 8192 * (2 * m.d + 2 * m.dFf) * 2 + 256 * m.vocab * 4;
}

export interface MemoryBudget {
  hbm: number;
  weights: number;
  activations: number;
  headroom: number;
  /** KV pool per GPU; negative when the working set does not fit */
  kv: number;
  /** blocks of BLOCK_TOKENS tokens across the whole replica */
  poolBlocks: number;
  blockBytes: number;
  fits: boolean;
}

/** (2.9) the four pools of one accelerator, and the replica's block pool. */
export function memoryBudget(r: ReplicaSpec): MemoryBudget {
  const weights = weightBytes(r.model, r.precision) / r.tp;
  const activations = activationBytes(r.model);
  const headroom = (1 - r.gpuMemUtil) * r.gpu.hbm;
  const kv = r.gpu.hbm - weights - activations - headroom;
  const blockBytes = BLOCK_TOKENS * kvBytesPerToken(r.model);
  const poolBlocks = Math.max(0, Math.floor((r.tp * kv) / blockBytes));
  return { hbm: r.gpu.hbm, weights, activations, headroom, kv, poolBlocks, blockBytes, fits: poolBlocks >= 8 };
}

/** (2.9) largest batch of sequences holding L tokens each. */
export function maxBatch(r: ReplicaSpec, L: number): number {
  const b = memoryBudget(r);
  return Math.max(0, Math.floor((r.tp * b.kv) / (L * kvBytesPerToken(r.model))));
}

/** (2.5) ridge point in FLOP per byte. */
export function ridge(g: GpuSpec): number {
  return g.peak / g.bw;
}

export interface StepLoad {
  /** tokens processed this step (decode tokens + prefill chunk tokens) */
  tokens: number;
  flops: number;
  bytes: number;
}

/** One sequence's contribution: n new tokens starting at context position p. */
export function seqLoad(m: ModelSpec, p: number, n: number): { flops: number; kvBytes: number } {
  const attn = 4 * m.nL * m.nH * m.dH * (n * p + (n * (n + 1)) / 2);
  return { flops: n * flopsPerToken(m) + attn, kvBytes: (p + n) * kvBytesPerToken(m) };
}

export interface StepCost {
  tMem: number;
  tCompute: number;
  tGpu: number;
  /** arithmetic intensity F/M, FLOP per byte */
  intensity: number;
  bound: "memory" | "compute";
}

/** (2.6) step-time floor divided by the achieved efficiencies MBU and MFU. */
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

/** (2.12) saturating decode throughput curve of a replica, tokens/s. */
export function decodeCurve(r: ReplicaSpec, L: number, mbu: number): { xInf: number; bHalf: number; at: (B: number) => number } {
  const lm = L * kvBytesPerToken(r.model);
  const xInf = (r.tp * r.gpu.bw * mbu) / lm;
  const bHalf = weightBytes(r.model, r.precision) / lm;
  return { xInf, bHalf, at: (B) => (xInf * B) / (B + bHalf) };
}

/** (3.3) how much more arithmetic a stateless loop would do without the KV cache. */
export function recomputeRatio(lIn: number, lOut: number): number {
  return (lOut * (lIn + lOut / 2)) / (lIn + lOut);
}

export const fmtGB = (bytes: number, digits = 1) => `${(bytes / 1e9).toFixed(digits)} GB`;
export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtMs = (s: number) => (s >= 1 ? `${s.toFixed(2)} s` : `${(s * 1e3).toFixed(s < 0.01 ? 1 : 0)} ms`);
