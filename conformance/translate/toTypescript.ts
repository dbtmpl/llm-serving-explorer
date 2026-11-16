/**
 * Neutral scenario to the TypeScript model's input: `Params` and a trace.
 */
import { DEFAULT_PARAMS, type Params, type TraceRequest } from "../../src/sim/index.js";
import { MAIN_ARM, type Deployment, type Scenario } from "../scenario.js";
import { typescriptGpu, typescriptModel } from "./names.js";

/** Seed of the world. A trace consumes no random numbers, so any value gives the same run; fixed for the record. */
export const TS_SEED = 7;

/** Seconds the pods take to start. Short, and every scenario's first request is later than this. */
export const TS_COLD_START_S = 0.1;

/** The parameters a calibration sets; everything else keeps the site's value. */
export type TimingOverride = Partial<Pick<Params, "mbu" | "mfu" | "hostMsBase" | "hostMsPerSeq" | "specCost" | "linkGbps">>;

export interface TypescriptInput {
  params: Params;
  seed: number;
  requests: TraceRequest[];
}

/**
 * The per-token acceptance probability beta that gives `length` tokens per step in the TypeScript
 * model's rule, `(1 - beta^(k+1)) / (1 - beta)` (Leviathan et al., equation 1). BLIS takes the mean
 * length as its input, so the translator converts. The expression is increasing in beta, so bisection
 * finds the one root.
 */
export function acceptanceForLength(length: number, k: number): number {
  if (length <= 1) return 0;
  if (length >= k + 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const e = (1 - mid ** (k + 1)) / (1 - mid);
    if (e < length) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function toTypescript(s: Scenario, arm: string = MAIN_ARM, timing: TimingOverride = {}): TypescriptInput {
  const d: Deployment = s.arms[arm] ?? (() => { throw new Error(`${s.id}: no arm "${arm}"`); })();
  const total = d.replicas;
  const autoscale = d.autoscale;
  const params: Params = {
    ...DEFAULT_PARAMS,
    model: typescriptModel(d.model),
    gpu: typescriptGpu(d.gpu),
    precision: "bf16",
    tp: d.engine.tp,
    gpuMemUtil: d.engine.gpuMemoryUtilisation,
    maxNumSeqs: d.engine.maxNumSeqs,
    tokenBudget: d.engine.maxNumBatchedTokens,
    prefixCaching: d.engine.prefixCaching,
    batching: "continuous",
    admission: "on-demand",
    routing: d.routing,
    // a fixed fleet unless the scenario scales: BLIS's replay has no autoscaler
    minPods: autoscale ? autoscale.minReplicas : total,
    maxPods: autoscale ? autoscale.maxReplicas : total,
    coldStartS: TS_COLD_START_S,
    scaleDownIdleS: 1e9,
    shedAfterS: d.queueDeadlineS,
    // BLIS has no KV tiers below GPU memory unless the scenario offloads to host memory; the TypeScript defaults have three
    dramGB: d.offload ? d.offload.cpuGB : 0,
    ssdGB: 0,
    remoteGB: 0,
    // the trace decides every request; nothing is generated
    arrivalRate: 0,
    returnProb: 0,
    ...timing
  };
  if (d.speculative) {
    params.specDecode = true;
    params.specK = d.speculative.k;
    params.specAccept = acceptanceForLength(d.speculative.acceptanceLength, d.speculative.k);
    // BLIS's drafter (n-gram) is not priced; a fitted `specCost` replaces this when the scenario is calibrated
    params.specCost = timing.specCost ?? 0;
  }
  if (d.disagg) {
    params.disagg = true;
    params.prefillShare = d.disagg.prefillReplicas / total;
    params.pdThreshold = d.disagg.thresholdTokens;
  }
  const requests: TraceRequest[] = d.requests.map((r) => ({ at: r.at, session: r.session, round: r.round, newTokens: r.newTokens, outputTokens: r.outputTokens }));
  return { params, seed: TS_SEED, requests };
}
