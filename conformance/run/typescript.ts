/**
 * Run the TypeScript model on a scenario, headless, and reduce its event log to a `Reduced` record.
 */
import { MIN_OUTPUT_TOKENS, advance, createWorld, loadTrace, type SimEvent, type World } from "../../src/sim/index.js";
import { microseconds, sortRows, type Fate, type Reduced, type RequestRow } from "../record.js";
import type { Scenario } from "../scenario.js";
import { toTypescript } from "../translate/toTypescript.js";

/** Clock step of the headless loop, seconds. The engine ticks finer inside it; this only bounds how late the loop notices it is done. */
const LOOP_STEP_S = 0.05;

/** A run that has not finished after this much simulated time is a bug in the scenario, not a slow run. */
const MAX_SIMULATED_S = 3600;

export function runTypescript(s: Scenario): { world: World; reduced: Reduced } {
  const input = toTypescript(s);
  const w = createWorld(input.params, input.seed);
  loadTrace(w, input.requests, MIN_OUTPUT_TOKENS);
  while (w.trace.length || w.reqs.size) {
    advance(w, LOOP_STEP_S);
    if (w.t > MAX_SIMULATED_S) throw new Error(`${s.id}: the TypeScript run did not finish within ${MAX_SIMULATED_S} simulated seconds`);
  }
  return { world: w, reduced: reduceTypescript(s, w) };
}

export function reduceTypescript(s: Scenario, w: World): Reduced {
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
  for (const e of w.events) {
    const id = e.reqId;
    switch (e.kind) {
      case "req.new": {
        const session = trace.get(e.sid!)!;
        byReq.set(id!, { reqId: id!, session, round: e.turn as number, inputTokens: e.lIn as number, outputTokens: 0, cachedTokens: null, pod: null, arrivalS: microseconds(e.t), firstTokenS: null, lastTokenS: null, fate: "other", preemptions: 0 });
        break;
      }
      case "req.routed":
        byReq.get(id!)!.pod = pods.get(e.podId!)!;
        break;
      case "req.admitted": {
        const row = byReq.get(id!)!;
        if (row.cachedTokens === null) row.cachedTokens = e.cached as number;
        break;
      }
      case "req.firstToken":
        byReq.get(id!)!.firstTokenS = microseconds(e.t);
        break;
      case "req.preempted":
        byReq.get(id!)!.preemptions! += 1;
        break;
      case "req.done": {
        const row = byReq.get(id!)!;
        row.lastTokenS = microseconds(e.t);
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
  const asked = new Map(s.requests.map((r) => [`${r.session}/${r.round}`, r.outputTokens]));
  const requests = sortRows([...byReq.values()].map(({ reqId: _reqId, ...row }) => ({ ...row, outputTokens: row.outputTokens || asked.get(`${row.session}/${row.round}`)! })));
  const requestsPerPod = w.pods.map((p) => w.events.filter((e: SimEvent) => e.kind === "req.routed" && e.podId === p.id).length);
  return {
    simulator: "typescript",
    scenario: s.id,
    kvBlocksPerReplica: w.pods[0]!.budget.poolBlocks,
    requests,
    preemptions: w.m.preemptions,
    requestsPerPod
  };
}
