/**
 * Eviction order: when a tier is full, whose cached KV leaves first?
 */
import type { ApproachMeta } from "../approach.js";

export interface EvictionPolicy extends ApproachMeta {
  /** The entry to evict from `candidates`, or null if there is none. Candidates are idle entries only. */
  pickVictim<T extends { lastUsed: number }>(candidates: Iterable<T>): T | null;
}

/**
 * Least recently used, whole session at a time.
 *
 * Source: CachedAttention (Gao et al., USENIX ATC 2024) manages KV per conversation
 * session and evicts by recency of use. vLLM likewise frees cached blocks in least-recently-used
 * order (vLLM design docs, "Automatic Prefix Caching").
 *
 * Simplification: a whole session is evicted at once. CachedAttention additionally looks ahead in
 * the job queue to protect sessions about to be needed, and Pensieve (Yu et al., 2023) evicts
 * individual chunks from the tail of a conversation. Neither is modelled.
 *
 * Example: sessions last used at t = 4 s, 9 s and 2 s: the one from t = 2 s goes first.
 */
export const leastRecentlyUsed: EvictionPolicy = {
  id: "lru-session",
  name: "LRU, whole session",
  summary: "Evict the idle session that was used longest ago.",
  citations: ["gao2024", "vllmPrefixCaching"],
  fidelity: "simplified",
  pickVictim: <T extends { lastUsed: number }>(candidates: Iterable<T>): T | null => {
    let victim: T | null = null;
    for (const c of candidates) if (!victim || c.lastUsed < victim.lastUsed) victim = c;
    return victim;
  }
};
