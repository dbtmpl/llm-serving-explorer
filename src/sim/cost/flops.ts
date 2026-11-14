/**
 * Arithmetic cost of running a transformer: FLOPs per token.
 *
 * Convention: one multiply-add is two FLOPs.
 */
import type { ModelSpec } from "../hardware/catalog.js";
import { kvBytesPerToken } from "./memory.js";

/**
 * FLOPs to push one token through every weight matrix once.
 *
 *     F_token = 2 N
 *
 * Each of the N parameters takes part in one multiply-add per token. Kaplan et al. (2020),
 * section 2.1 and table 1, give the same context-independent cost of a forward pass.
 *
 * Example: Llama 3.1 8B, N = 8.03e9, so one token costs 1.6e10 FLOPs.
 */
export function flopsPerToken(m: ModelSpec): number {
  return 2 * m.N;
}

/**
 * Extra FLOPs for one token to attend over `L` cached tokens.
 *
 *     F_attn(L) = 4 · n_layers · n_heads · d_head · L
 *
 * Derivation from scaled dot-product attention (Vaswani et al., 2017, section 3.2.1): per layer
 * and head, scoring the query against L keys is L · d_head multiply-adds, and mixing L values by
 * those scores is another L · d_head. Two multiply-add passes at two FLOPs each give the factor 4.
 * Sources differ on this constant; what matters for the roofline is that the term is linear in L
 * and small next to 2N until contexts are very long.
 *
 * Example: Llama 3.1 8B (32 layers, 32 heads, d_head 128): 4 · 32 · 32 · 128 = 524,288 FLOPs per
 * cached token, so a 4,096-token context adds 2.1e9 FLOPs, about 13% of 2N.
 */
export function attnFlops(m: ModelSpec, L: number): number {
  return 4 * m.nL * m.nH * m.dH * L;
}

/** Arithmetic and memory traffic one sequence contributes to an engine step. */
export interface SequenceLoad {
  flops: number;
  /** Bytes of this sequence's KV cache that the step reads. */
  kvBytes: number;
}

/**
 * Cost of processing `n` new tokens of one sequence whose context already holds `p` tokens.
 *
 *     flops   = n · 2N + 4 · n_layers · n_heads · d_head · Σ_{i=1..n} (p + i)
 *     kvBytes = (p + n) · kvBytesPerToken
 *
 * The sum is the attention cost of each new token over everything before it:
 * Σ (p + i) = n·p + n(n+1)/2. A decode step is the case n = 1; a prefill chunk is n > 1 and is
 * what makes prefill compute-bound.
 */
export function seqLoad(m: ModelSpec, p: number, n: number): SequenceLoad {
  const attended = n * p + (n * (n + 1)) / 2;
  return { flops: n * flopsPerToken(m) + attnFlops(m, attended), kvBytes: (p + n) * kvBytesPerToken(m) };
}

/**
 * How much more arithmetic a decode loop would do without a KV cache.
 *
 * Without a cache every output token re-runs the whole context: Σ_{i=1..L_out} (L_in + i) token
 * passes. With one, each token is processed once: L_in + L_out passes. To leading order
 *
 *     ratio ≈ L_out · (L_in + L_out / 2) / (L_in + L_out)
 *
 * Example: L_in = 2,000 and L_out = 500 gives 500 · 2,250 / 2,500 = 450 times more work.
 */
export function recomputeRatio(lIn: number, lOut: number): number {
  return (lOut * (lIn + lOut / 2)) / (lIn + lOut);
}
