import { pickHighest, type RoutingPolicy } from "./index.js";

/**
 * Least loaded: send the request to the pod with the fewest requests in flight.
 *
 * "Least request" in general-purpose load balancers (Envoy docs). It balances queues but, like
 * round robin, knows nothing about where a session's KV cache lives.
 *
 * Simplification: the full candidate set is scanned. Envoy samples two candidates at random
 * ("power of two choices") when weights are equal.
 */
export const leastLoaded: RoutingPolicy = {
  id: "least-loaded",
  name: "Least loaded",
  summary: "Send to the pod with the fewest requests in flight.",
  citations: ["envoyLoadBalancing"],
  fidelity: "simplified",
  score: (c) => -c.load,
  pick: pickHighest
};
