import { pickHighest, type CandidateFacts, type RoutingPolicy } from "./index.js";
import { prefixAware } from "./prefixAware.js";

/** Default exponential peer-load staleness decay time constant τ (seconds). Illustrative parameter default. */
export const DEFAULT_AGE_DECAY_S = 0.2;

/**
 * Dahlin age-discounted effective load: exact local in-flight count plus peer load decayed
 * exponentially by the age of the peer snapshot:
 *
 *     effectiveLoad = ownLoad + peerLoad · exp(-peerStateAgeS / ageDecayS)
 */
export function ageDiscountedLoad(ownLoad: number, peerLoad: number, ageS: number, decayS: number): number {
  const safeAge = Math.max(0, ageS);
  const safeDecay = Math.max(1e-9, decayS);
  return ownLoad + peerLoad * Math.exp(-safeAge / safeDecay);
}

/**
 * Age-discounted prefix-cache-aware routing, combining Dahlin's staleness interpretation
 * (IEEE TPDS 2000) with llm-d's weighted prefix-cache scorer.
 *
 * Source: Dahlin (IEEE TPDS 2000, "Interpreting Stale Load Information") shows that load
 * reports lose predictive value as their age grows relative to the update interval, so
 * schedulers should discount stale load information rather than treat aged snapshots as exact.
 * Applied to active-active llm-d routers (llm-d-router Issue #3440), each replica knows its own
 * exact in-flight requests (`ownLoad`, 0 ms lag) and discounts stale peer snapshots (`peerLoad`)
 * exponentially with `peerStateAgeS`:
 *
 *     L_eff(p) = L_own(p) + L_peer(p) · exp(-Δt / τ)
 *     score(p) = 3 · prefix + 2 · (1 - kvUtilisation) + 2 · (1 - L_eff(p) / capacity)
 *
 * Example: capacity = 16, τ = 0.2 s, ownLoad = 1, peerLoad = 6, prefix = 0.75 (HBM),
 * kvUtilisation = 0.2. At Δt = 0 s (fresh sync): L_eff = 1 + 6·1 = 7, score = 2.25 + 1.6 +
 * 2·(1 - 7/16) = 4.975. At Δt = 0.4 s (stale snapshot): L_eff = 1 + 6·e^{-2} ≈ 1.812,
 * score ≈ 5.623. As peer reports age out, stale load stops blocking warm-pod affinity on
 * sequential turns.
 *
 * Simplifications: Dahlin estimates arrival rate and variance from update age `T_update`; this
 * policy models staleness as exponential decay of `peerLoad` with parameter `ageDecayS` while
 * keeping `ownLoad` exact.
 */
export const ageDiscounted: RoutingPolicy = {
  id: "age-discounted",
  name: "Age-discounted",
  summary: "Discounts stale peer-load snapshots exponentially with snapshot age (Dahlin, IEEE TPDS 2000).",
  citations: ["dahlin2000", "llmdScheduling", "llmdIssue3440"],
  fidelity: "structural",
  verification: {
    notVerifiable: "BLIS and LLMServingSim do not implement Dahlin exponential staleness decay on peer router snapshots; checked against Dahlin's age-discounting rule by unit and engine tests."
  },
  score: (c: CandidateFacts) => {
    const effectiveLoad =
      c.ownLoad !== undefined && c.peerLoad !== undefined
        ? ageDiscountedLoad(c.ownLoad, c.peerLoad, c.peerStateAgeS ?? 0, c.ageDecayS ?? DEFAULT_AGE_DECAY_S)
        : c.load;
    return prefixAware.score({ ...c, load: effectiveLoad });
  },
  pick: pickHighest
};
