import type { BatchingMode } from "./index.js";

/**
 * Static (request-level) batching.
 *
 * A batch is formed from waiting requests, runs until its longest answer has finished, and only
 * then is the next batch formed. This is how general-purpose model servers batch: Clipper
 * (Crankshaw et al., NSDI 2017) and Triton's dynamic batcher group whole requests.
 * For autoregressive generation it has two costs, both named by Orca (Yu et al., OSDI 2022): a finished sequence's slot idles until the batch ends, and a request that arrives
 * just after a batch started waits for all of it.
 *
 * Example: four requests start together and the longest needs 400 steps. A fifth request arriving
 * at step 10 waits 390 steps before its first token.
 */
export const staticBatching: BatchingMode = {
  id: "static",
  name: "Static batching",
  summary: "A batch runs to completion before the next one is formed.",
  citations: ["crankshaw2017", "tritonBatcher", "yu2022"],
  fidelity: "structural",
  admitsInto: (running) => running === 0,
  admissionHonoursTokenBudget: false
};
