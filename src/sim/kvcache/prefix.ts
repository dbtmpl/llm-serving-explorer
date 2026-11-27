/**
 * Prefix reuse: how much of a new request's context can be served from KV that is already cached.
 */
import type { ApproachMeta } from "../approach.js";
import type { Pod, Req, World } from "../core/types.js";
import { BLOCK_TOKENS, blocksFor } from "./blocks.js";

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
  verification: ["prefix-cache", "routing-prefix-aware", "eviction-pressure", "routing-prefix-vs-round-robin", "lss-prefix-cache"],
  reusableTokens: (cachedTokens, contextTokens) => Math.floor(Math.min(cachedTokens, contextTokens - 1) / BLOCK_TOKENS) * BLOCK_TOKENS
};

/** Tokens of a request's prompt that belong to a shared system-prompt group, capped below the last block. */
export function sharedPrefixTokensFor(w: Pick<World, "params" | "sessions">, r: Pick<Req, "sid" | "lIn">): number {
  if (!w.params.prefixCaching || w.params.sharedPrefixTokens <= 0) return 0;
  const s = w.sessions.get(r.sid);
  if (!s || s.prefixGroup === undefined) return 0;
  return Math.min(w.params.sharedPrefixTokens, Math.max(0, r.lIn - BLOCK_TOKENS));
}

/** Record that `pod` now holds the shared system-prompt prefix for `r`'s group in HBM. */
export function recordSharedPrefix(w: Pick<World, "t" | "params" | "sessions">, pod: Pod, r: Pick<Req, "sid" | "lIn">, filledTokens: number): void {
  const shared = sharedPrefixTokensFor(w, r);
  if (shared < BLOCK_TOKENS || filledTokens < shared) return;
  const g = w.sessions.get(r.sid)?.prefixGroup;
  if (g === undefined) return;
  const usable = Math.floor(shared / BLOCK_TOKENS) * BLOCK_TOKENS;
  if (usable < BLOCK_TOKENS) return;
  const map = (pod.sharedPrefixes ??= new Map());
  const prev = map.get(g);
  if (!prev || usable > prev.tokens) {
    map.set(g, { tokens: usable, blocks: blocksFor(usable), lastUsed: w.t });
  } else {
    prev.lastUsed = w.t;
  }
}

/** Drop shared-prefix index entries on `pod` whose blocks are no longer backed by any HBM entry. */
export function pruneSharedPrefixes(w: Pick<World, "sessions">, pod: Pod): void {
  if (!pod.sharedPrefixes?.size) return;
  for (const [g, sp] of pod.sharedPrefixes) {
    let kept = false;
    for (const e of pod.entries.values()) {
      if (e.tier === "hbm" && e.tokens >= sp.tokens && w.sessions.get(e.sid)?.prefixGroup === g) {
        kept = true;
        break;
      }
    }
    if (!kept) pod.sharedPrefixes.delete(g);
  }
}
