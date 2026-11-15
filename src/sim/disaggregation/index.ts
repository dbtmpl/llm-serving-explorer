/**
 * Concept: prefill/decode disaggregation. Prefill is compute-bound and decode is memory-bound, so
 * running them on separate pools lets each be sized and tuned for its own latency target. The
 * price is moving the prompt's KV cache between pods.
 *
 * Sources: DistServe (Zhong et al., OSDI 2024) and Splitwise (Patel et al., ISCA 2024) for the
 * idea; llm-d for the routing rule modelled here.
 *
 * To add an approach: implement `DisaggregationDecider` in its own file with its citation, add
 * it to `DISAGGREGATION.approaches`, and add a unit test. See README.md in this directory.
 */
import type { ApproachMeta, Concept } from "../approach.js";

export type PodRole = "both" | "prefill" | "decode";

export interface DisaggregationDecider extends ApproachMeta {
  /** Should this request be prefilled on the prefill pool rather than on its decode pod? */
  usePrefillPool(uncachedPromptTokens: number, thresholdTokens: number): boolean;
}

/**
 * Decode-first decision with a token threshold, after llm-d.
 *
 * Source: llm-d docs, P/D disaggregation. The router first picks the decode pod, asks how many
 * prompt tokens are not cached there, and sends the request through the prefill pool only if that
 * number is large enough to be worth a KV transfer:
 *
 *     usePrefillPool  ⇔  uncachedTokens > threshold
 *
 * A follow-up turn whose history is cached on its decode pod has only its new tokens uncached and
 * is prefilled in place.
 *
 * Example: threshold 512. A first turn with 3,000 uncached tokens goes through the prefill pool;
 * its follow-up with 127 new tokens does not.
 */
export const decodeFirstThreshold: DisaggregationDecider = {
  id: "decode-first-threshold",
  name: "Decode-first with token threshold",
  summary: "Pick the decode pod first; use the prefill pool only when enough of the prompt is uncached there.",
  citations: ["llmdDisaggregation", "zhong2024", "patel2023"],
  fidelity: "structural",
  verification: ["pd-disaggregation", "calib-8b-h100-pd"],
  usePrefillPool: (uncachedPromptTokens, thresholdTokens) => uncachedPromptTokens > thresholdTokens
};

export const DISAGGREGATION: Concept<DisaggregationDecider> = {
  module: "disaggregation",
  title: "Prefill/decode disaggregation",
  question: "Which requests are prefilled on a separate pool, and what does the hand-over cost?",
  approaches: [decodeFirstThreshold]
};

/** The decider in use. With a second approach this becomes a parameter. */
export const DECIDER = decodeFirstThreshold;

/** A split fleet needs at least one pod of each role. */
export const MIN_PODS_WHEN_SPLIT = 2;

/**
 * Role for the next pod so that about `prefillShare` of the fleet prefills.
 *
 * Example: share 0.34. The first pod prefills (there is always at least one), the next three
 * decode, and the fifth prefills because round(5 · 0.34) = 2.
 */
export function nextPodRole(prefillPods: number, livePods: number, prefillShare: number): Exclude<PodRole, "both"> {
  const wanted = Math.max(1, Math.round((livePods + 1) * prefillShare));
  return prefillPods < wanted ? "prefill" : "decode";
}

const BITS_PER_BYTE = 8;
const GIGA = 1e9;

/** Bytes per second of a link quoted in Gbit/s. */
export const linkBytesPerSecond = (gbps: number): number => (gbps / BITS_PER_BYTE) * GIGA;

/**
 * Seconds to move a KV cache between pods: bytes over link bandwidth.
 *
 * Example: 3,000 tokens of Llama 3.1 8B KV (393 MB) over 100 Gbit/s take 31 ms. DistServe
 * reports that with a fast interconnect the transfer is a small part of request time; over a slow
 * link it would dominate.
 */
export function transferSeconds(bytes: number, linkGbps: number): number {
  return bytes / linkBytesPerSecond(linkGbps);
}
