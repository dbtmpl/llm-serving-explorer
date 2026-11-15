import type { BatchingMode } from "./index.js";
import { TIMING } from "../verification.js";

/**
 * Continuous batching (iteration-level scheduling).
 *
 * The batch is re-decided at every engine step: a finished sequence leaves at once and a waiting
 * request takes its place in the next step. Introduced by Orca (Yu et al., OSDI 2022), which calls it iteration-level scheduling,
 * and now the default in vLLM, TGI, TensorRT-LLM and SGLang.
 *
 * Example: in the static-batching example, the fifth request joins at step 11.
 */
export const continuousBatching: BatchingMode = {
  id: "continuous",
  name: "Continuous batching",
  summary: "Requests join and leave the batch at every engine step.",
  citations: ["yu2022", "vllmScheduler"],
  fidelity: "structural",
  verification: [...TIMING, "preemption-overflow", "queue-deadline-shedding"],
  admitsInto: () => true,
  admissionHonoursTokenBudget: true
};
