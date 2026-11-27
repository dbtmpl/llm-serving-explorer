/**
 * Concept: routing. Which pod gets the next request?
 *
 * To add an approach: implement `RoutingPolicy` in its own file with its citation, add it to
 * `ROUTING.approaches`, and add a unit test. See README.md in this directory.
 */
import { selectApproach, type ApproachMeta, type Concept } from "../approach.js";
import { ageDiscounted } from "./ageDiscounted.js";
import { boundedLoadAffinity } from "./boundedLoadAffinity.js";
import { leastLoaded } from "./leastLoaded.js";
import { prefixAware } from "./prefixAware.js";
import { roundRobin } from "./roundRobin.js";

/** Where a pod holds a copy of the session's KV cache, if anywhere. */
export type CacheLocation = "hbm" | "dram" | "ssd" | "remote";

/** What the router knows about one candidate pod for one request. */
export interface CandidateFacts {
  /** Share of the prompt whose KV the pod can reach, in [0, 1]. */
  cachedFraction: number;
  /** Tier holding that copy, or null when there is none. */
  cacheLocation: CacheLocation | null;
  /** Share of the pod's KV pool held by running sequences, in [0, 1]. */
  kvUtilisation: number;
  /** Requests running, waiting or on their way to the pod (observed by this router replica). */
  load: number;
  /** Load at which the pod is considered full. */
  capacity: number;
  /** Exact in-flight count dispatched by this router replica (active-active mode). */
  ownLoad?: number;
  /** Sum of peer replicas' in-flight counts from the last sync snapshot. */
  peerLoad?: number;
  /** Seconds elapsed since the last cross-replica peer sync snapshot. */
  peerStateAgeS?: number;
  /** Mean observed load across ready candidates for this decision. */
  meanObservedLoad?: number;
  /** Mirrokni et al. overload cap slack `1 + epsilon`. */
  boundedLoadEpsilon?: number;
  /** Dahlin exponential peer-load decay time constant in seconds. */
  ageDecayS?: number;
}

export interface RoutingPolicy extends ApproachMeta {
  /** Higher is better. Only compared between candidates of one decision. */
  score(c: CandidateFacts): number;
  /**
   * Choose a candidate given every candidate's score. `cursor` is the policy's own state carried
   * between decisions (a rotation position, for example); return its next value.
   */
  pick(scores: readonly number[], cursor: number): { index: number; cursor: number };
}

/** Pick the highest score; the first candidate wins a tie. */
export function pickHighest(scores: readonly number[], cursor: number): { index: number; cursor: number } {
  let index = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[index]!) index = i;
  return { index, cursor };
}

export const ROUTING: Concept<RoutingPolicy> = {
  module: "routing",
  title: "Routing",
  question: "Which pod gets the next request?",
  approaches: [roundRobin, leastLoaded, prefixAware, boundedLoadAffinity, ageDiscounted]
};

export type RoutingId = "round-robin" | "least-loaded" | "prefix-aware" | "bounded-load-affinity" | "age-discounted";
export const routingPolicy = (id: RoutingId): RoutingPolicy => selectApproach(ROUTING, id);

/**
 * Requests a pod may hold beyond its batch slots before the router stops sending to it.
 * A short queue keeps slots filled between steps; a long one hides load from the autoscaler.
 * Illustrative value.
 */
export const POD_QUEUE_SLACK = 4;
