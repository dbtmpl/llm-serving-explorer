import type { DecodeStrategy } from "./index.js";

/**
 * Autoregressive decoding: one forward pass of the model yields one token per sequence
 * (Vaswani et al., 2017, section 3). The baseline every other strategy is compared with.
 */
export const autoregressive: DecodeStrategy = {
  id: "autoregressive",
  name: "Autoregressive",
  summary: "One token per sequence per step.",
  citations: ["vaswani2017"],
  fidelity: "exact",
  tokensThisStep: () => 1,
  positionsEvaluated: () => 1,
  overheadFactor: () => 0
};
