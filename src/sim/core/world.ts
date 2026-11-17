/**
 * Creating a world and the few helpers every module needs: the random source, the event log and
 * basic pod queries.
 */
import { GPUS, MODELS, type ReplicaSpec } from "../hardware/catalog.js";
import { DEFAULT_PARAMS, type Params } from "./params.js";
import type { Pod, SimEvent, World } from "./types.js";

export const DEFAULT_SEED = 7;

export function createWorld(params: Params = { ...DEFAULT_PARAMS }, seed: number = DEFAULT_SEED): World {
  return {
    t: 0,
    params,
    sessions: new Map(),
    reqs: new Map(),
    pods: [],
    gatewayQueue: [],
    pending: [],
    trace: [],
    events: [],
    lastRoute: null,
    routeLog: [],
    m: { completed: 0, failed: 0, tokensOut: 0, promptTokens: 0, cachedTokens: 0, evictions: 0, drops: 0, preemptions: 0, reloads: 0, ttft: [], tpot: [], gpuSeconds: 0 },
    history: [],
    rr: 0,
    nextId: 1,
    nextPod: 1,
    seed,
    arrivalAcc: 0,
    tokWindow: [],
    lastSample: 0,
    startedAt: null,
    seen: { tokenizer: false, gateway: false },
    store: { turns: 0, tokens: 0 },
    remote: new Map(),
    remoteBytes: 0,
    lastChurn: 0,
    handoff: []
  };
}

/**
 * Uniform random number in [0, 1) from the world's seed (the mulberry32 generator). All
 * randomness goes through here, so a world with a given seed and inputs replays identically.
 */
export function rand(w: World): number {
  let z = (w.seed += 0x6d2b79f5);
  z = Math.imul(z ^ (z >>> 15), z | 1);
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
  return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
}

/** Append to the event log. The interface turns events into callouts and animations. */
export function emit(w: World, kind: string, data: Omit<SimEvent, "t" | "kind"> = {}): void {
  w.events.push({ t: w.t, kind, ...data });
}

export function replicaSpec(p: Params): ReplicaSpec {
  return { model: MODELS[p.model]!, gpu: GPUS[p.gpu]!, precision: p.precision, tp: p.tp, gpuMemUtil: p.gpuMemUtil, maxNumBatchedTokens: p.tokenBudget, maxNumSeqs: p.maxNumSeqs };
}

/** Requests a pod is running, holding in its queue, or about to receive. */
export const podLoad = (pod: Pod): number => pod.running.length + pod.waiting.length + pod.inbound;

/** Pods that exist or are coming up; excludes draining, terminated and failed ones. */
export const livePods = (w: Pick<World, "pods">): Pod[] => w.pods.filter((p) => p.state === "creating" || p.state === "loading" || p.state === "ready");
