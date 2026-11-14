import { pickHighest, type CacheLocation, type RoutingPolicy } from "./index.js";

/**
 * Scorer weights of llm-d's default scheduling profile: `prefix-cache-scorer` 3,
 * `kv-cache-utilization-scorer` 2, `queue-scorer` 2 (llm-d docs, router scheduling).
 */
export const SCORER_WEIGHTS = { prefixCache: 3, kvUtilisation: 2, queue: 2 } as const;

/**
 * How much a cached copy is worth by the tier it sits in, relative to a copy in GPU memory.
 * A copy further down takes longer to load back, so it attracts the request less. llm-d scores a
 * prefix hit without regard to tier; the ordering is ours and the values are illustrative.
 */
export const TIER_AFFINITY: Record<CacheLocation, number> = { hbm: 1, dram: 0.7, ssd: 0.4, remote: 0.25 };

/**
 * Prefix-cache-aware routing, after llm-d's endpoint picker.
 *
 * Source: llm-d router scheduling (built on the Kubernetes Gateway API Inference Extension).
 * Each scorer rates a candidate in [0, 1]; the picker takes the highest weighted sum:
 *
 *     score = 3 · prefix + 2 · (1 − kvUtilisation) + 2 · (1 − load / capacity)
 *
 * where `prefix` is the share of the prompt the pod already holds. Sending a session back to the
 * pod with its cache turns a full prefill into a prefill of the new tokens only; the other two
 * scorers stop that affinity from piling every session onto one pod.
 *
 * Example: pod A holds 90% of the prompt in HBM, its pool is 60% full and it has 8 of 16
 * requests: 3 · 0.9 + 2 · 0.4 + 2 · 0.5 = 4.5. Pod B is empty and cold: 0 + 2 + 2 = 4.0.
 * A wins. At 14 of 16 requests A scores 3.75 and the request goes to B.
 *
 * Differences from llm-d: the prefix term is scaled by `TIER_AFFINITY`; the queue term counts
 * running as well as waiting requests; the router sees exact pod state with no scrape lag.
 */
export const prefixAware: RoutingPolicy = {
  id: "prefix-aware",
  name: "Prefix-cache aware",
  summary: "Weighted score of cached prefix, KV utilisation and queue depth, as in llm-d.",
  citations: ["llmdScheduling", "gatewayInferenceExtension"],
  fidelity: "structural",
  score: (c) => {
    const affinity = c.cacheLocation ? TIER_AFFINITY[c.cacheLocation] : 0;
    return (
      SCORER_WEIGHTS.prefixCache * c.cachedFraction * affinity +
      SCORER_WEIGHTS.kvUtilisation * (1 - c.kvUtilisation) +
      SCORER_WEIGHTS.queue * (1 - c.load / c.capacity)
    );
  },
  pick: pickHighest
};
