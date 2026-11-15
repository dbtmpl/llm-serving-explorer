/**
 * Run the TypeScript model on a scenario, headless, and reduce its event log to a `Reduced` record.
 */
import { MIN_OUTPUT_TOKENS, advance, createWorld, loadTrace, setParam, type SimEvent, type World } from "../../src/sim/index.js";
import { FRONTEND_HOPS } from "../../src/sim/workload/frontend.js";
import { fittedFor, loadFitted, type FittedFile } from "../calibration/fitted.js";
import { NO_AGGREGATES, microseconds, sortRows, type Aggregates, type Fate, type Reduced, type RequestRow } from "../record.js";
import { AUTOSCALE_LOAD_S, MAIN_ARM, usesCalibration, type Scenario } from "../scenario.js";
import { TS_COLD_START_S, toTypescript, type TimingOverride } from "../translate/toTypescript.js";

/** Clock step of the headless loop, seconds. The engine ticks finer inside it; this only bounds how late the loop notices it is done. */
const LOOP_STEP_S = 0.05;

/** A run that has not finished after this much simulated time is a bug in the scenario, not a slow run. */
const MAX_SIMULATED_S = 3600;

/**
 * The timing values to run a scenario with: the fitted ones when the scenario has a calibrated or
 * directional check, otherwise the site's defaults (an empty override).
 */
export function timingFor(s: Scenario, arm: string, fitted?: FittedFile): TimingOverride {
  if (!usesCalibration(s)) return {};
  const d = s.arms[arm]!;
  const f = fittedFor(fitted ?? loadFitted(), d.model, d.gpu, d.engine.tp);
  return {
    ...f.timing,
    ...(d.speculative && f.specCost ? { specCost: f.specCost.value } : {}),
    ...(d.disagg && f.linkGbps ? { linkGbps: f.linkGbps.value } : {})
  };
}

export function runTypescript(s: Scenario, arm: string = MAIN_ARM, timing?: TimingOverride): { world: World; reduced: Reduced } {
  const input = toTypescript(s, arm, timing ?? timingFor(s, arm));
  const w = createWorld(input.params, input.seed);
  loadTrace(w, input.requests, MIN_OUTPUT_TOKENS);
  if (s.arms[arm]!.autoscale) {
    // The replicas the scenario starts with are loaded (BLIS's `warm_start_initial_instances`); only the ones the autoscaler adds pay the load time.
    advance(w, TS_COLD_START_S * 1.2);
    setParam(w, "coldStartS", AUTOSCALE_LOAD_S);
  }
  while (w.trace.length || w.reqs.size) {
    advance(w, LOOP_STEP_S);
    if (w.t > MAX_SIMULATED_S) throw new Error(`${s.id}: the TypeScript run did not finish within ${MAX_SIMULATED_S} simulated seconds`);
  }
  return { world: w, reduced: reduceTypescript(s, w, arm) };
}

/**
 * The TypeScript front end sends a request over three illustrative network hops (client to front
 * end, front end to gateway, router to pod: `FRONTEND_HOPS`), which BLIS's default configuration does
 * not have (gateway latency 0). Timings are compared without them: a request "arrives" when it
 * reaches the front end, and its first and last token are moved earlier by the two hops after that.
 * Tokenisation stays: BLIS has an admission delay (a fixed 40 ms plus a per-token term) that stands for it.
 */
const BEFORE_FRONT_END_S = FRONTEND_HOPS.send;
const AFTER_FRONT_END_S = FRONTEND_HOPS.toGateway + FRONTEND_HOPS.toPod;

export function reduceTypescript(s: Scenario, w: World, arm: string = MAIN_ARM): Reduced {
  const d = s.arms[arm]!;
  const trace = new Map<number, number>();
  for (const sess of w.sessions.values()) if (sess.traceId !== undefined) trace.set(sess.id, sess.traceId);
  interface Acc extends RequestRow {
    reqId: number;
  }
  const byReq = new Map<number, Acc>();
  const overlap = w.events.filter((e) => e.kind === "trace.overlap");
  if (overlap.length) throw new Error(`${s.id}: ${overlap.length} follow-up(s) were sent before the previous answer finished; space the rounds further apart`);
  const pods = new Map<number, number>();
  w.pods.forEach((p, i) => pods.set(p.id, i));
  const reloaded = new Map<number, number>();
  let viaPrefill = 0;
  const transfers: number[] = [];
  let participations = 0;
  let firstTokens = 0;
  for (const e of w.events) {
    const id = e.reqId;
    switch (e.kind) {
      case "req.new": {
        const session = trace.get(e.sid!)!;
        byReq.set(id!, { reqId: id!, session, round: e.turn as number, inputTokens: e.lIn as number, outputTokens: 0, cachedTokens: null, pod: null, arrivalS: microseconds(e.t + BEFORE_FRONT_END_S), firstTokenS: null, lastTokenS: null, fate: "other", preemptions: 0 });
        break;
      }
      case "req.routed":
        byReq.get(id!)!.pod = pods.get(e.podId!)!;
        if (e.via === "prefill") viaPrefill++;
        break;
      case "req.admitted": {
        const row = byReq.get(id!)!;
        if (row.cachedTokens === null) row.cachedTokens = e.cached as number;
        break;
      }
      case "kv.reload":
        if (e.from === "dram" || e.from === "ssd") reloaded.set(id!, (reloaded.get(id!) ?? 0) + (e.tokens as number));
        break;
      case "kv.transfer":
        transfers.push(e.dur as number);
        break;
      case "req.firstToken":
        byReq.get(id!)!.firstTokenS = microseconds(e.t - AFTER_FRONT_END_S);
        firstTokens++;
        break;
      case "step.tokens":
        participations += (e.sids as number[]).length;
        break;
      case "req.preempted":
        byReq.get(id!)!.preemptions! += 1;
        break;
      case "req.done": {
        const row = byReq.get(id!)!;
        row.lastTokenS = microseconds(e.t - AFTER_FRONT_END_S);
        row.outputTokens = e.out as number;
        row.fate = "completed";
        break;
      }
      case "req.failed": {
        const row = byReq.get(id!)!;
        const why = String(e.why);
        row.fate = (why.startsWith("shed") ? "shed" : why.includes("exceeds the KV pool") ? "unservable" : "other") satisfies Fate;
        break;
      }
    }
  }
  const asked = new Map(d.requests.map((r) => [`${r.session}/${r.round}`, r.outputTokens]));
  const requests = sortRows([...byReq.values()].map(({ reqId: _reqId, ...row }) => ({ ...row, outputTokens: row.outputTokens || asked.get(`${row.session}/${row.round}`)! })));
  const requestsPerPod = w.pods.map((p) => w.events.filter((e: SimEvent) => e.kind === "req.routed" && e.podId === p.id).length);

  // Aggregates. Hit rates are shares of all prompt tokens; host-memory hits are the tokens a returning
  // session had reloaded from DRAM or SSD, GPU hits the rest of what was cached.
  const total = requests.reduce((a, r) => a + r.inputTokens, 0);
  const cached = requests.reduce((a, r) => a + (r.cachedTokens ?? 0), 0);
  let cpu = 0;
  for (const [id, tokens] of reloaded) cpu += Math.min(tokens, byReq.get(id)!.cachedTokens ?? 0);
  const completed = requests.filter((r) => r.fate === "completed");
  // tokens one sequence gains per decode step: every token after the first, over the sequence-steps that made them
  const decodeSteps = participations - firstTokens;
  const aggregates: Aggregates = {
    ...NO_AGGREGATES,
    prefixHitRate: total ? (cached - cpu) / total : null,
    cpuTierHitRate: total ? cpu / total : null,
    kvTransferMeanS: transfers.length ? transfers.reduce((a, b) => a + b, 0) / transfers.length : null,
    specTokensPerStep: d.speculative && decodeSteps > 0 ? completed.reduce((a, r) => a + r.outputTokens - 1, 0) / decodeSteps : null,
    prefillPoolRequests: d.disagg ? viaPrefill : null,
    // replicas that served at least one request: the count both simulators can state the same way
    peakReplicas: requestsPerPod.filter((n) => n > 0).length
  };
  return {
    simulator: "typescript",
    scenario: s.id,
    kvBlocksPerReplica: w.pods[0]!.budget.poolBlocks,
    requests,
    preemptions: w.m.preemptions,
    requestsPerPod,
    aggregates
  };
}

/** Run every arm of a scenario; a scenario with a timing check uses the fitted values. */
export function runTypescriptArms(s: Scenario, fitted?: FittedFile): Record<string, Reduced> {
  const out: Record<string, Reduced> = {};
  for (const arm of Object.keys(s.arms)) out[arm] = runTypescript(s, arm, timingFor(s, arm, fitted)).reduced;
  return out;
}
