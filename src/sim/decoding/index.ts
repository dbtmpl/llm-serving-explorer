/**
 * Concept: decoding. How many tokens does a sequence gain per engine step, and at what cost?
 *
 * To add an approach: implement `DecodeStrategy` in its own file with its citation, add it to
 * `DECODING.approaches`, and add a unit test. See README.md in this directory.
 */
import { selectApproach, type ApproachMeta, type Concept } from "../approach.js";
import { autoregressive } from "./autoregressive.js";
import { speculative } from "./speculative.js";

export interface DecodeSettings {
  /** Draft tokens proposed per step (γ in Leviathan et al.). */
  draftTokens: number;
  /** Probability that one draft token is accepted (α). */
  acceptance: number;
  /** Time of one draft-model run relative to one target-model run (c). */
  draftCost: number;
}

export interface DecodeStrategy extends ApproachMeta {
  /**
   * Tokens one sequence gains in a step. `draw` returns a uniform random number in [0, 1) and
   * must be called only when the strategy is stochastic, so that deterministic strategies do not
   * consume random numbers.
   */
  tokensThisStep(draw: () => number, s: DecodeSettings): number;
  /** Positions the target model evaluates per sequence in one step. */
  positionsEvaluated(s: DecodeSettings): number;
  /** Extra step time as a multiple of the target model's GPU time for the step. */
  overheadFactor(s: DecodeSettings): number;
}

export const DECODING: Concept<DecodeStrategy> = {
  module: "decoding",
  title: "Decoding",
  question: "How many tokens does a sequence gain per engine step, and at what cost?",
  approaches: [autoregressive, speculative]
};

export type DecodingId = "autoregressive" | "speculative";
export const decodeStrategy = (id: DecodingId): DecodeStrategy => selectApproach(DECODING, id);
