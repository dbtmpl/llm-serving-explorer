import { pickHighest, type CandidateFacts, type RoutingPolicy } from "./index.js";
import { prefixAware } from "./prefixAware.js";

/**
 * Floor on mean observed load so an idle cluster sets cap (1 + ε) · 1 rather than 0,
 * allowing the first request onto a warm pod without immediate penalty. Illustrative guard.
 */
export const MIN_LOAD_FLOOR = 1;

/**
 * Penalty subtracted from candidates exceeding the bounded-load cap. Exceeds the maximum
 * possible weighted score (3 + 2 + 2 = 7 from `SCORER_WEIGHTS`) so overloaded warm pods
 * yield to any under-cap pod while still ranking among themselves if all exceed the cap.
 * Illustrative separation constant.
 */
export const OVERLOAD_PENALTY = 10;

/** Default overload slack ε when `CandidateFacts.boundedLoadEpsilon` is omitted. */
export const DEFAULT_BOUNDED_LOAD_EPSILON = 0.5;

/**
 * Maximum requests a pod may carry before bounded-load affinity sheds overflow:
 *
 *     capLoad = (1 + ε) · max(meanObservedLoad, 1)
 */
export function boundedLoadCap(meanObservedLoad: number, eps: number): number {
  return (1 + eps) * Math.max(meanObservedLoad, MIN_LOAD_FLOOR);
}

/**
 * Bounded-load prefix-cache-aware routing, combining consistent hashing with bounded loads
 * (Mirrokni, Thorup & Zadimoghaddam, SODA 2018) and llm-d's weighted prefix-cache scorer.
 *
 * Source: Mirrokni et al. (SODA 2018) cap each bin at `c = ceil((1 + ε) · m / n)` so no hot
 * key can overload a server even under skewed popularity; llm-d-router Issue #3440 motivates
 * bounding warm-pod herding across active-active router replicas.
 *
 * Rule: compute the llm-d `prefixAware` score `s(p)`, and compute the per-replica load cap:
 *
 *     cap = (1 + ε) · max(meanObservedLoad, 1)
 *     score(p) = s(p) - OVERLOAD_PENALTY    if load(p) > cap
 *                s(p)                       otherwise
 *
 * Example: 4 pods with capacity 16, ε = 0.5. Pod A holds 75% of the prompt in HBM with
 * kvUtilisation = 0.2 and load = 4; pods B–D are cold and empty (load = 0, kvUtilisation = 0).
 * Then meanObservedLoad = (4 + 0 + 0 + 0) / 4 = 1.0 and cap = 1.5 · 1.0 = 1.5. Pod A's base
 * score is 3·0.75 + 2·0.8 + 2·(1 - 4/16) = 5.35, but 4 > 1.5 so it scores 5.35 - 10 = -4.65;
 * cold Pod B scores 0 + 2 + 2 = 4.0 and absorbs the spillover. At load = 1 <= 1.5, Pod A keeps
 * its unpenalised score 5.725 > 4.0.
 *
 * Simplifications: uses a soft penalty larger than the score range instead of consistent-hash
 * ring probing, and compares each replica's observed load (`ownLoad + peerLoad`) rather than
 * global instantaneous load.
 */
export const boundedLoadAffinity: RoutingPolicy = {
  id: "bounded-load-affinity",
  name: "Bounded-load affinity",
  summary: "Prefix-aware score with a (1+ε) overload cap (Mirrokni et al., SODA 2018) to stop hot-pod herding.",
  citations: ["mirrokni2018", "llmdScheduling", "llmdIssue3440"],
  fidelity: "structural",
  verification: {
    notVerifiable: "BLIS and LLMServingSim do not implement Mirrokni bounded-load caps on top of llm-d's prefix-aware scorer; checked against the SODA 2018 cap formula by unit and engine tests."
  },
  score: (c: CandidateFacts) => {
    const base = prefixAware.score(c);
    const eps = c.boundedLoadEpsilon ?? DEFAULT_BOUNDED_LOAD_EPSILON;
    const cap = boundedLoadCap(c.meanObservedLoad ?? c.load, eps);
    return c.load > cap ? base - OVERLOAD_PENALTY : base;
  },
  pick: pickHighest
};
