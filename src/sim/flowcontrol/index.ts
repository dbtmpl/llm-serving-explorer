/**
 * Concept: flow control. What happens to requests the fleet cannot serve in time?
 *
 * To add an approach: implement `SheddingPolicy` in its own file with its citation, add it to
 * `FLOW_CONTROL.approaches`, and add a unit test. See README.md in this directory.
 */
import type { ApproachMeta, Concept } from "../approach.js";

export interface SheddingPolicy extends ApproachMeta {
  /** Should a request that has waited `waitedSeconds` at the router be rejected? */
  shouldShed(waitedSeconds: number, deadlineSeconds: number): boolean;
}

/**
 * Deadline shedding: reject a request that has queued longer than a time-to-live.
 *
 * Source: llm-d docs, flow control. Requests wait in the router's queues subject to a
 * configurable TTL and are evicted when it expires. A fast rejection (HTTP 429) is more useful to
 * a client than an answer that arrives after it has given up, and it keeps the queue from filling
 * with work nobody is waiting for.
 *
 *     shed  ⇔  deadline > 0  and  waited > deadline
 *
 * Example: deadline 3 s. A request queued for 3.2 s is rejected; a deadline of 0 disables shedding.
 *
 * Not modelled: priority bands, per-tenant fairness and queue capacity limits.
 */
export const deadlineShedding: SheddingPolicy = {
  id: "deadline",
  name: "Deadline shedding",
  summary: "Reject requests that have waited at the router longer than a time-to-live.",
  citations: ["llmdFlowControl"],
  fidelity: "simplified",
  verification: ["queue-deadline-shedding"],
  shouldShed: (waitedSeconds, deadlineSeconds) => deadlineSeconds > 0 && waitedSeconds > deadlineSeconds
};

export const FLOW_CONTROL: Concept<SheddingPolicy> = {
  module: "flowcontrol",
  title: "Flow control",
  question: "What happens to requests the fleet cannot serve in time?",
  approaches: [deadlineShedding]
};

/** The policy in use. With a second approach this becomes a parameter. */
export const SHEDDING = deadlineShedding;
