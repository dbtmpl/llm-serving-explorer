/**
 * Concept: KV admission. How much KV memory must be secured before a request may start?
 *
 * To add an approach: implement `AdmissionRule` in its own file with its citation, add it to
 * `ADMISSION.approaches`, and add a unit test. See README.md in this directory.
 */
import { selectApproach, type ApproachMeta, type Concept } from "../approach.js";
import { onDemand } from "./onDemand.js";
import { reserveToCompletion } from "./reserveToCompletion.js";
import { wholePrompt } from "./wholePrompt.js";

/** What an admission rule may look at. All quantities are tokens. */
export interface AdmissionRequest {
  /** Prompt tokens, including conversation history. */
  promptTokens: number;
  /** Output tokens already produced (non-zero only after a preemption-free resume). */
  generatedTokens: number;
  /** Output tokens the request will produce. Known to the simulation, not to a real engine. */
  outputTokens: number;
  /** The `max_tokens` cap clients send; the only bound a real engine has on output length. */
  maxTokensCap: number;
  /** Tokens of the context already present in the pod's KV cache. */
  cachedTokens: number;
  /** Per-step token budget of the engine. */
  tokenBudget: number;
}

export interface AdmissionRule extends ApproachMeta {
  /** Output tokens to budget for when checking that the request can ever fit in the pool. */
  outputReservation(r: Pick<AdmissionRequest, "outputTokens" | "maxTokensCap">): number;
  /** Tokens of KV that must be allocated before the request joins the batch. */
  tokensToSecure(r: AdmissionRequest): number;
  /**
   * Whether a prompt's blocks are allocated chunk by chunk while it is prefilled. If so a running
   * prefill can find the pool empty and must be able to yield.
   */
  allocatesPrefillPerChunk: boolean;
}

export const ADMISSION: Concept<AdmissionRule> = {
  module: "admission",
  title: "KV admission",
  question: "How much KV memory must be secured before a request may start?",
  approaches: [onDemand, wholePrompt, reserveToCompletion]
};

export type AdmissionId = "on-demand" | "prompt" | "reserve";
export const admissionRule = (id: AdmissionId): AdmissionRule => selectApproach(ADMISSION, id);
