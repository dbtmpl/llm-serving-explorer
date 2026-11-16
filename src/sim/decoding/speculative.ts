import type { DecodeSettings, DecodeStrategy } from "./index.js";

/**
 * Speculative decoding.
 *
 * Source: Leviathan et al., ICML 2023. A small draft model proposes γ tokens autoregressively.
 * The target model scores all of them in one parallel pass and keeps the longest prefix it agrees
 * with, plus one token of its own. Output is distributed exactly as the target model's.
 *
 * With per-token acceptance probability α (assumed i.i.d., as in the paper's analysis):
 *
 *     E[tokens per target run] = (1 − α^(γ+1)) / (1 − α)              (equation 1)
 *     speed-up                 = (1 − α^(γ+1)) / ((1 − α)(γ c + 1))   (theorem 3.8)
 *
 * where c is the time of one draft run over one target run.
 *
 * Example: α = 0.7, γ = 4, c = 0.04 gives (1 − 0.7^5) / 0.3 = 2.77 tokens per step and a
 * speed-up of 2.77 / 1.16 = 2.39.
 *
 * Simplification: the target's verification pass is priced as γ + 1 positions on the roofline.
 * Decode is memory-bound, so those extra positions cost little here; the paper measures batch
 * size 1 only and says nothing about larger batches.
 */
export const speculative: DecodeStrategy = {
  id: "speculative",
  name: "Speculative decoding",
  summary: "A draft model proposes several tokens; the target verifies them in one pass.",
  citations: ["leviathan2023"],
  fidelity: "exact",
  verification: ["spec-decoding", "calib-8b-h100-spec", "lss-spec-decoding", "calib-lss-8b-rtx-pro-6000-spec"],
  tokensThisStep: (draw, s) => {
    let n = 1;
    while (n <= s.draftTokens && draw() < s.acceptance) n++;
    return n;
  },
  positionsEvaluated: (s) => s.draftTokens + 1,
  overheadFactor: (s) => s.draftTokens * s.draftCost
};

/** Equation 1 of Leviathan et al.: expected tokens generated per run of the target model. */
export function expectedTokensPerStep(s: Pick<DecodeSettings, "acceptance" | "draftTokens">): number {
  return (1 - s.acceptance ** (s.draftTokens + 1)) / (1 - s.acceptance);
}

/** Theorem 3.8 of Leviathan et al.: expected wall-time improvement factor. */
export function expectedSpeedup(s: DecodeSettings): number {
  return expectedTokensPerStep(s) / (s.draftTokens * s.draftCost + 1);
}
