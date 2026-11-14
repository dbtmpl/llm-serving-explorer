/**
 * Every concept the simulation models and every approach it supports, in one list.
 * The tables in the READMEs are generated from this (`pnpm docs:sync`).
 */
import { ADMISSION } from "./admission/index.js";
import type { Concept } from "./approach.js";
import { AUTOSCALING } from "./autoscaling/index.js";
import { BATCHING } from "./batching/index.js";
import { COST_MODEL, STEP_SCHEDULING } from "./cost/index.js";
import { DECODING } from "./decoding/index.js";
import { DISAGGREGATION } from "./disaggregation/index.js";
import { FLOW_CONTROL } from "./flowcontrol/index.js";
import { KVCACHE_CONCEPTS } from "./kvcache/index.js";
import { ROUTING } from "./routing/index.js";
import { WORKLOAD } from "./workload/index.js";

export const CONCEPTS: readonly Concept[] = [
  COST_MODEL,
  STEP_SCHEDULING,
  BATCHING,
  ADMISSION,
  ...KVCACHE_CONCEPTS,
  DECODING,
  ROUTING,
  DISAGGREGATION,
  AUTOSCALING,
  FLOW_CONTROL,
  WORKLOAD
];
