/**
 * The fleet: creating pods, walking them through their lifecycle, and scaling up and down.
 */
import { AUTOSCALER } from "../autoscaling/index.js";
import type { Pod, PodState, Req, Role, World } from "../core/types.js";
import { emit, livePods, podLoad, replicaSpec } from "../core/world.js";
import { memoryBudget } from "../cost/memory.js";
import { MIN_PODS_WHEN_SPLIT, nextPodRole } from "../disaggregation/index.js";
import { DISPLAY_CELLS } from "../kvcache/hbm.js";
import { COLD_START_SHARES, DRAIN_S, MAX_STEPS_PER_TICK } from "./constants.js";
import { applyPlan, planStep } from "./step.js";

function createPod(w: World): Pod {
  const spec = replicaSpec(w.params);
  const taken = new Set(w.pods.map((p) => p.slot));
  let slot = 0;
  while (taken.has(slot)) slot++;
  const live = livePods(w);
  const prefillPods = live.filter((x) => x.role === "prefill").length;
  const role: Role = w.params.disagg ? nextPodRole(prefillPods, live.length, w.params.prefillShare) : "both";
  const pod: Pod = {
    id: w.nextPod++,
    slot,
    role,
    state: "creating",
    born: w.t,
    stateSince: w.t,
    loadProgress: 0,
    spec,
    budget: memoryBudget(spec),
    waiting: [],
    running: [],
    inbound: 0,
    stepStart: 0,
    stepEnd: 0,
    plan: null,
    last: null,
    steps: 0,
    entries: new Map(),
    cells: new Int32Array(DISPLAY_CELLS),
    freeCells: DISPLAY_CELLS,
    usedBlocks: 0,
    dramBlocks: 0,
    ssdBlocks: 0,
    idleSince: w.t,
    tokensOut: 0,
    decodeDur: 0
  };
  w.pods.push(pod);
  emit(w, "pod.created", { podId: pod.id });
  return pod;
}

function setPodState(w: World, pod: Pod, state: PodState): void {
  pod.state = state;
  pod.stateSince = w.t;
  emit(w, `pod.${state}`, { podId: pod.id });
}

/** Send a request back to the router's queue; any progress on a pod is lost. */
export function requeue(w: World, r: Req): void {
  r.stage = "queued";
  r.stageStart = w.t;
  r.podId = -1;
  r.prefillDone = 0;
  r.cached = 0;
  r.kvReady = 0;
  w.gatewayQueue.push(r.id);
}

/** Tear down every pod (model, GPU or memory settings changed). In-flight requests go back to the gateway. */
export function restartFleet(w: World): void {
  for (const pod of w.pods) {
    for (const id of [...pod.running, ...pod.waiting]) requeue(w, w.reqs.get(id)!);
    pod.running = [];
    pod.waiting = [];
    pod.plan = null;
    if (pod.state !== "terminated") setPodState(w, pod, "terminated");
  }
  for (const r of w.reqs.values()) {
    if (r.stage === "toPod" || r.stage === "transfer" || r.stage === "handoff") requeue(w, r);
  }
  w.handoff = [];
  emit(w, "fleet.restart");
}

/** Scale up to the autoscaler's target at once; scale down pods that have been idle long enough. */
export function autoscale(w: World): void {
  const p = w.params;
  const live = livePods(w);
  const failed = w.pods.some((x) => x.state === "failed");
  const inFlight = w.reqs.size;
  let desired = AUTOSCALER.desiredPods({ inFlight, targetPerPod: p.maxNumSeqs, minPods: p.minPods, maxPods: p.maxPods });
  if (p.disagg && inFlight > 0) desired = Math.max(MIN_PODS_WHEN_SPLIT, desired);
  if (live.length < desired && !failed) {
    const from = live.length;
    for (let i = live.length; i < desired; i++) createPod(w);
    emit(w, "scale.up", { from, to: desired, demand: inFlight, perPod: p.maxNumSeqs });
  }
  let remaining = live.length;
  for (const pod of live) {
    if (remaining <= Math.max(desired, p.minPods)) break;
    if (pod.state === "ready" && podLoad(pod) === 0 && w.t - pod.idleSince > p.scaleDownIdleS) {
      setPodState(w, pod, "draining");
      emit(w, "scale.down", { podId: pod.id, idle: w.t - pod.idleSince });
      remaining--;
    }
  }
}

/** Advance one pod: its lifecycle if it is not ready, its engine steps if it is. */
export function tickPod(w: World, pod: Pod): void {
  const p = w.params;
  const age = w.t - pod.stateSince;
  switch (pod.state) {
    case "creating":
      if (age > COLD_START_SHARES.creating * p.coldStartS) setPodState(w, pod, pod.budget.fits ? "loading" : "failed");
      return;
    case "loading":
      pod.loadProgress = Math.min(1, age / (COLD_START_SHARES.loading * p.coldStartS));
      if (pod.loadProgress >= 1) {
        pod.idleSince = w.t;
        setPodState(w, pod, "ready");
      }
      return;
    case "draining":
      if (age > DRAIN_S) setPodState(w, pod, "terminated");
      return;
    case "ready":
      break;
    default:
      return;
  }
  if (w.t < pod.stepEnd) return;
  // Steps end between clock ticks. Finish each at its exact end time and start the next from
  // there, so step time is not rounded up to the tick.
  const now = w.t;
  for (let i = 0; i < MAX_STEPS_PER_TICK; i++) {
    if (pod.plan) {
      w.t = pod.stepEnd;
      applyPlan(w, pod);
    }
    if (!pod.running.length && !pod.waiting.length) break;
    pod.idleSince = w.t;
    planStep(w, pod);
    if (!pod.plan || pod.stepEnd > now) break;
  }
  w.t = now;
}
