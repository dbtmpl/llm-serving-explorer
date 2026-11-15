/**
 * Neutral scenario to the TypeScript model's input: `Params` and a trace.
 */
import { DEFAULT_PARAMS, type Params, type TraceRequest } from "../../src/sim/index.js";
import type { Scenario } from "../scenario.js";
import { gpuNames, modelNames } from "./names.js";

/** Seed of the world. A trace consumes no random numbers, so any value gives the same run; fixed for the record. */
export const TS_SEED = 7;

/** Seconds the pods take to start. Short, and every scenario's first request is later than this. */
export const TS_COLD_START_S = 0.1;

export interface TypescriptInput {
  params: Params;
  seed: number;
  requests: TraceRequest[];
}

export function toTypescript(s: Scenario): TypescriptInput {
  const params: Params = {
    ...DEFAULT_PARAMS,
    model: modelNames(s.model).typescript,
    gpu: gpuNames(s.gpu).typescript,
    precision: "bf16",
    tp: s.engine.tp,
    gpuMemUtil: s.engine.gpuMemoryUtilisation,
    maxNumSeqs: s.engine.maxNumSeqs,
    tokenBudget: s.engine.maxNumBatchedTokens,
    prefixCaching: s.engine.prefixCaching,
    batching: "continuous",
    admission: "on-demand",
    routing: s.routing,
    // a fixed fleet: BLIS has no autoscaler in a replay
    minPods: s.replicas,
    maxPods: s.replicas,
    coldStartS: TS_COLD_START_S,
    scaleDownIdleS: 1e9,
    shedAfterS: s.queueDeadlineS,
    // BLIS in this configuration has no KV tiers below GPU memory; the TypeScript defaults do
    dramGB: 0,
    ssdGB: 0,
    remoteGB: 0,
    // the trace decides every request; nothing is generated
    arrivalRate: 0,
    returnProb: 0
  };
  const requests: TraceRequest[] = s.requests.map((r) => ({ at: r.at, session: r.session, round: r.round, newTokens: r.newTokens, outputTokens: r.outputTokens }));
  return { params, seed: TS_SEED, requests };
}
