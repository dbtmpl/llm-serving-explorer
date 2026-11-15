/**
 * The simulation clock: one tick moves every part of the system forward by a small time step.
 */
import { RESTART_KEYS, type Params } from "../core/params.js";
import type { World } from "../core/types.js";
import { emit, livePods } from "../core/world.js";
import { SHEDDING } from "../flowcontrol/index.js";
import { FRONTEND_HOPS, tokenizeSeconds } from "../workload/frontend.js";
import { injectTrace, newRequest, newSession } from "../workload/index.js";
import { failReq } from "./admit.js";
import { CHURN_INTERVAL_S, CHURN_MIN_SESSIONS, HISTORY_SAMPLES, SAMPLE_INTERVAL_S, TERMINATED_LINGER_S, THROUGHPUT_WINDOW_S, TICK_S, TIME_EPSILON_S } from "./constants.js";
import { autoscale, requeue, restartFleet, tickPod } from "./fleet.js";
import { handoffs, route } from "./router.js";
import { kvFill, tokensPerSecond } from "./selectors.js";

/** New sessions: a steady arrival rate, scheduled bursts, and users returning for another turn. */
function arrivals(w: World, h: number): void {
  const p = w.params;
  if (p.arrivalRate > 0) {
    w.arrivalAcc += p.arrivalRate * h;
    while (w.arrivalAcc >= 1) {
      w.arrivalAcc -= 1;
      newSession(w);
    }
  }
  if (w.trace.length) injectTrace(w);
  while (w.pending.length && w.pending[0]! <= w.t) {
    w.pending.shift();
    newSession(w);
  }
  for (const s of w.sessions.values()) {
    if (s.state === "thinking" && w.t >= s.nextTurnAt) newRequest(w, s);
  }
}

/** Move requests along the hops before and after the router. */
function frontend(w: World): void {
  for (const r of w.reqs.values()) {
    if (w.t < r.stageEnd) continue;
    if (r.stage === "send") {
      r.stage = "tokenize";
      r.stageStart = w.t;
      r.stageEnd = w.t + tokenizeSeconds(r.lIn);
      w.seen.tokenizer = true;
      if (r.lIn > r.newTokens) emit(w, "store.read", { sid: r.sid, reqId: r.id, history: r.lIn - r.newTokens });
    } else if (r.stage === "tokenize") {
      r.stage = "toGateway";
      r.stageStart = w.t;
      r.stageEnd = w.t + FRONTEND_HOPS.toGateway;
      emit(w, "req.tokenized", { sid: r.sid, reqId: r.id, lIn: r.lIn, newTokens: r.newTokens });
    } else if (r.stage === "toGateway") {
      r.stage = "queued";
      r.stageStart = w.t;
      w.seen.gateway = true;
      w.gatewayQueue.push(r.id);
      emit(w, "req.queued", { sid: r.sid, reqId: r.id });
    } else if (r.stage === "toPod" || r.stage === "transfer") {
      const pod = w.pods.find((x) => x.id === r.podId);
      if (!pod || pod.state !== "ready") {
        requeue(w, r);
        continue;
      }
      pod.inbound--;
      pod.waiting.push(r.id);
      r.stage = "waiting";
      r.stageStart = w.t;
    }
  }
}

/** Drain the router's queue in arrival order: shed what has waited too long, route what fits. */
function dispatch(w: World): void {
  const p = w.params;
  while (w.gatewayQueue.length) {
    const r = w.reqs.get(w.gatewayQueue[0]!);
    if (r && SHEDDING.shouldShed(w.t - r.stageStart, p.shedAfterS)) {
      w.gatewayQueue.shift();
      failReq(w, null, r, `shed after waiting ${p.shedAfterS} s at the router (HTTP 429)`);
      continue;
    }
    if (r && !route(w, r)) break;
    w.gatewayQueue.shift();
  }
}

function telemetry(w: World): void {
  const p = w.params;
  if (w.t - w.lastChurn >= CHURN_INTERVAL_S && w.sessions.size >= CHURN_MIN_SESSIONS) {
    w.lastChurn = w.t;
    let typing = 0;
    let idle = 0;
    let first = 0;
    for (const s of w.sessions.values()) {
      if (!first) first = s.id;
      if (s.state === "thinking") typing++;
      else if (s.state === "idle") idle++;
    }
    emit(w, "churn", { sid: first, rate: p.arrivalRate, active: w.reqs.size, typing, idle, total: w.sessions.size });
  }
  if (w.startedAt !== null && w.t - w.lastSample >= SAMPLE_INTERVAL_S) {
    w.lastSample = w.t;
    while (w.tokWindow.length && w.tokWindow[0]!.t < w.t - THROUGHPUT_WINDOW_S) w.tokWindow.shift();
    w.history.push({ t: w.t, tokS: tokensPerSecond(w), inflight: w.reqs.size, pods: livePods(w).length, kvFill: kvFill(w) });
    if (w.history.length > HISTORY_SAMPLES) w.history.shift();
  }
}

function tick(w: World, h: number): void {
  arrivals(w, h);
  frontend(w);
  autoscale(w);
  dispatch(w);
  if (w.handoff.length) handoffs(w);
  for (const pod of w.pods) tickPod(w, pod);
  for (let i = w.pods.length - 1; i >= 0; i--) {
    const pod = w.pods[i]!;
    if (pod.state === "terminated" && w.t - pod.stateSince > TERMINATED_LINGER_S) w.pods.splice(i, 1);
  }
  if (w.startedAt !== null) w.m.gpuSeconds += livePods(w).length * w.params.tp * h;
  telemetry(w);
}

/** Advance the world by `dt` simulated seconds. */
export function advance(w: World, dt: number): void {
  let remaining = dt;
  while (remaining > TIME_EPSILON_S) {
    const h = Math.min(remaining, TICK_S);
    w.t += h;
    tick(w, h);
    remaining -= h;
  }
}

/** Apply a parameter change while the simulation runs. */
export function setParam<K extends keyof Params>(w: World, key: K, value: Params[K]): void {
  if (w.params[key] === value) return;
  w.params[key] = value;
  if (RESTART_KEYS.includes(key)) restartFleet(w);
}
