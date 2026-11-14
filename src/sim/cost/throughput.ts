/**
 * Closed-form decode throughput of one replica as a function of batch size.
 */
import type { Precision, ReplicaSpec } from "../hardware/catalog.js";
import { kvBytesPerToken, weightBytes } from "./memory.js";

export interface DecodeCurve {
  /** Throughput as the batch grows without bound, tokens/s. */
  xInf: number;
  /** Batch size at which throughput is half of `xInf`. */
  bHalf: number;
  /** Throughput at batch size B, tokens/s. */
  at: (B: number) => number;
}

/**
 * Saturating throughput curve of memory-bound decoding.
 *
 * A decode step of B sequences at context L reads M = weights + B · L · kv bytes and emits B
 * tokens. With the roofline's memory term, t = M / (tp · W · MBU), so
 *
 *     X(B) = B / t = X_inf · B / (B + B_half)
 *     X_inf  = tp · W · MBU / (L · kv)       (every byte read is KV)
 *     B_half = weights / (L · kv)            (KV traffic equals weight traffic)
 *
 * Small batches are dominated by the fixed weight read, so adding a sequence is nearly free;
 * large batches are dominated by KV traffic and throughput stops growing.
 *
 * Example: Llama 3.1 8B on an H100 at L = 2,048, MBU = 1: X_inf = 3.35e12 / (2048 · 131072)
 * = 12,480 tokens/s and B_half = 16.06e9 / 268.4e6 = 59.8 sequences.
 */
export function decodeCurve(r: ReplicaSpec, L: number, mbu: number): DecodeCurve {
  const kvPerSequence = L * kvBytesPerToken(r.model);
  const xInf = (r.tp * r.gpu.bw * mbu) / kvPerSequence;
  const bHalf = weightBytes(r.model, r.precision as Precision) / kvPerSequence;
  return { xInf, bHalf, at: (B) => (xInf * B) / (B + bHalf) };
}
