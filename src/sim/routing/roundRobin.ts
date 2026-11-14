import type { RoutingPolicy } from "./index.js";

/**
 * Round robin: each request goes to the next pod in turn, whatever its state.
 *
 * The default of general-purpose load balancers (Envoy docs, "Weighted round robin"). It ignores
 * both load and cache placement, so a follow-up turn usually lands on a pod that has to prefill
 * the whole conversation again.
 */
export const roundRobin: RoutingPolicy = {
  id: "round-robin",
  name: "Round robin",
  summary: "Rotate through pods regardless of load or cache.",
  citations: ["envoyLoadBalancing"],
  fidelity: "exact",
  score: (c) => -c.load,
  pick: (scores, cursor) => ({ index: cursor % scores.length, cursor: cursor + 1 })
};
