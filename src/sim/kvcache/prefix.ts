/**
 * Prefix reuse: how much of a new request's context can be served from KV that is already cached.
 */
import type { ApproachMeta } from "../approach.js";
import { BLOCK_TOKENS } from "./blocks.js";

export interface PrefixMatcher extends ApproachMeta {
  /**
   * Tokens of a `contextTokens`-long context that need no prefill, given that the cache holds the
   * first `cachedTokens` of it.
   */
  reusableTokens(cachedTokens: number, contextTokens: number): number;
}

/**
 * Block-hash prefix matching, as in vLLM's automatic prefix caching.
 *
 * Source: vLLM design docs, "Automatic Prefix Caching". Each full KV block is identified by a hash
 * of its own tokens and of every token before it, so a block can be reused only if the whole
 * prefix up to its end matches. Two consequences:
 *
 * - reuse is in whole blocks: a partly filled last block has no hash and is recomputed;
 * - at least one token is always computed, because the model needs logits at the last position.
 *
 *     reusable = floor(min(cached, context − 1) / B) · B
 *
 * Example: 2,659 tokens of history are cached and the follow-up context is 2,786 tokens:
 * floor(2659 / 16) · 16 = 2,656 tokens are reused and 130 are prefilled.
 *
 * Alternative for a future approach: SGLang's RadixAttention matches at token granularity with a
 * radix tree (Zheng et al., 2023).
 */
export const blockHashPrefix: PrefixMatcher = {
  id: "block-hash",
  name: "Block-hash prefix cache",
  summary: "Reuse whole KV blocks whose entire token prefix matches; always compute the last token.",
  citations: ["vllmPrefixCaching", "kwon2023"],
  fidelity: "exact",
  verification: ["prefix-cache", "routing-prefix-aware", "eviction-pressure", "routing-prefix-vs-round-robin"],
  reusableTokens: (cachedTokens, contextTokens) => Math.floor(Math.min(cachedTokens, contextTokens - 1) / BLOCK_TOKENS) * BLOCK_TOKENS
};
