/**
 * Concept: autoscaling. How many pods should be running?
 *
 * To add an approach: implement `Autoscaler` in its own file with its citation, add it to
 * `AUTOSCALING.approaches`, and add a unit test. See README.md in this directory.
 */
import type { ApproachMeta, Concept } from "../approach.js";

export interface ScalingSignal {
  /** Requests anywhere in the system that have not finished. */
  inFlight: number;
  /** Requests one pod is meant to carry at once. */
  targetPerPod: number;
  minPods: number;
  maxPods: number;
}

export interface Autoscaler extends ApproachMeta {
  desiredPods(s: ScalingSignal): number;
}

/**
 * Target-concurrency scaling.
 *
 *     desired = clamp(ceil(inFlight / targetPerPod), minPods, maxPods)
 *
 * Source: the concurrency-based rule of Knative's pod autoscaler, and the shape llm-d reaches
 * with KEDA scaling on endpoint-picker metrics (running requests and queue size). The target per
 * pod here is `max_num_seqs`, so a pod is added when every batch slot is taken.
 *
 * Example: 100 requests in flight with 12 slots per pod: ceil(100 / 12) = 9 pods.
 *
 * Simplifications: the rule reacts instantly to the exact count. Real autoscalers average a
 * scraped metric over a window (60 s stable and 6 s panic windows in Knative) and rate-limit
 * changes, so they lag a burst. Scale-down after an idle period is handled by the fleet.
 */
export const targetConcurrency: Autoscaler = {
  id: "target-concurrency",
  name: "Target concurrency",
  summary: "Run enough pods that each carries at most its target number of requests.",
  citations: ["knativeAutoscaling", "llmdAutoscaling"],
  fidelity: "simplified",
  verification: ["autoscale-overload"],
  desiredPods: (s) => Math.max(s.minPods, Math.min(s.maxPods, Math.ceil(s.inFlight / Math.max(1, s.targetPerPod))))
};

export const AUTOSCALING: Concept<Autoscaler> = {
  module: "autoscaling",
  title: "Autoscaling",
  question: "How many pods should be running?",
  approaches: [targetConcurrency]
};

/** The autoscaler in use. With a second approach this becomes a parameter. */
export const AUTOSCALER = targetConcurrency;
