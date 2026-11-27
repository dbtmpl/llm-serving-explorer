/**
 * The router: sends each queued request to a pod, and in a split fleet moves finished prefills to
 * a decode pod.
 */
import type { Pod, Req, World } from "../core/types.js";
import { emit, podLoad } from "../core/world.js";
import { kvBytesPerToken } from "../cost/memory.js";
import { DECIDER, transferSeconds } from "../disaggregation/index.js";
import { activeBlocks } from "../kvcache/hbm.js";
import { sharedPrefixTokensFor } from "../kvcache/prefix.js";
import { POD_QUEUE_SLACK, routingPolicy, type CacheLocation } from "../routing/index.js";
import { FRONTEND_HOPS } from "../workload/frontend.js";
import { ROUTE_LOG_SIZE, TIME_EPSILON_S } from "./constants.js";

interface Candidate {
  podId: number;
  load: number;
  cache: number;
  tier: CacheLocation | null;
  kvUtilisation: number;
  score: number;
  ownLoad?: number;
  peerLoad?: number;
  trueLoad?: number;
}

/** Increment exact per-replica in-flight tracking when a request is dispatched to `podId`. */
export function trackRouterInFlight(w: World, r: Req, podId: number, replica: number): void {
  r.routerReplica = replica;
  const map = (w.ownInFlight[replica] ??= new Map());
  map.set(podId, (map.get(podId) ?? 0) + 1);
}

/** Decrement exact per-replica in-flight tracking when a request leaves its pod (finished, failed, requeued, or handed off). */
export function releaseRouterInFlight(w: World, r: Req): void {
  const rep = r.routerReplica;
  if (rep === undefined) return;
  r.routerReplica = undefined;
  if (r.podId < 0) return;
  const map = w.ownInFlight[rep];
  if (!map) return;
  const cur = map.get(r.podId) ?? 0;
  if (cur <= 1) map.delete(r.podId);
  else map.set(r.podId, cur - 1);
}

/** Refresh cross-replica peer load and KV-utilisation snapshots on each `syncIntervalS` tick. */
export function syncRouters(w: World): void {
  const p = w.params;
  if (p.syncIntervalS <= 0) return;
  const rs = w.routerSync;
  if (w.t + TIME_EPSILON_S < rs.nextSyncT) return;
  const replicas = Math.max(1, p.routerReplicas);
  rs.peerInFlight = Array.from({ length: replicas }, (_, j) => new Map(w.ownInFlight[j] ?? []));
  rs.podKvUtil.clear();
  for (const pod of w.pods) {
    if (pod.state === "ready") {
      rs.podKvUtil.set(pod.id, pod.budget.poolBlocks ? activeBlocks(pod) / pod.budget.poolBlocks : 1);
    }
  }
  rs.lastSyncT = w.t;
  while (rs.nextSyncT <= w.t + TIME_EPSILON_S) rs.nextSyncT += p.syncIntervalS;
  emit(w, "router.sync", { t: w.t, replicas, syncIntervalS: p.syncIntervalS });
}

/** Rebuild per-replica in-flight tables and snapshots after `routerReplicas` or `syncIntervalS` changes live. */
export function syncRouterTopology(w: World): void {
  const p = w.params;
  const replicas = Math.max(1, p.routerReplicas);
  w.ownInFlight = Array.from({ length: replicas }, () => new Map());
  for (const r of w.reqs.values()) {
    if (r.podId >= 0 && (r.stage === "toPod" || r.stage === "waiting" || r.stage === "reload" || r.stage === "prefill" || r.stage === "decode")) {
      const rep = (r.routerReplica ?? 0) % replicas;
      r.routerReplica = rep;
      const map = w.ownInFlight[rep]!;
      map.set(r.podId, (map.get(r.podId) ?? 0) + 1);
    } else {
      r.routerReplica = undefined;
    }
  }
  w.routerCursor = w.routerCursor % replicas;
  w.routerSync = {
    lastSyncT: w.t,
    nextSyncT: p.syncIntervalS > 0 ? w.t + p.syncIntervalS : 0,
    peerInFlight: Array.from({ length: replicas }, (_, j) => new Map(w.ownInFlight[j]!)),
    podKvUtil: new Map(
      w.pods
        .filter((pod) => pod.state === "ready")
        .map((pod) => [pod.id, pod.budget.poolBlocks ? activeBlocks(pod) / pod.budget.poolBlocks : 1])
    )
  };
}

/** Try to route one request. Returns false when no pod can take it yet. */
export function route(w: World, r: Req): boolean {
  const p = w.params;
  const policy = routingPolicy(p.routing);
  const capacity = p.maxNumSeqs + POD_QUEUE_SLACK;
  // while pods are still starting, hold the overflow at the gateway instead of queueing it behind a full pod
  const starting = w.pods.some((x) => x.state === "creating" || x.state === "loading");
  const room = starting ? p.maxNumSeqs : capacity;
  const multi = p.routerReplicas > 1 || p.syncIntervalS > 0;
  const replicas = Math.max(1, p.routerReplicas);
  const replica = multi ? w.routerCursor % replicas : 0;
  const ageS = multi && p.syncIntervalS > 0 ? Math.max(0, w.t - w.routerSync.lastSyncT) : 0;

  const viewOf = (pod: Pod) => {
    if (!multi) {
      const load = podLoad(pod);
      return { ownLoad: load, peerLoad: 0, observedLoad: load, trueLoad: load };
    }
    const ownLoad = w.ownInFlight[replica]?.get(pod.id) ?? 0;
    let peerLoad = 0;
    if (p.syncIntervalS > 0) {
      for (let j = 0; j < replicas; j++) if (j !== replica) peerLoad += w.routerSync.peerInFlight[j]?.get(pod.id) ?? 0;
    } else {
      for (let j = 0; j < replicas; j++) if (j !== replica) peerLoad += w.ownInFlight[j]?.get(pod.id) ?? 0;
    }
    return { ownLoad, peerLoad, observedLoad: ownLoad + peerLoad, trueLoad: podLoad(pod) };
  };

  const ready = w.pods.filter((x) => x.state === "ready" && (p.syncIntervalS > 0 ? viewOf(x).observedLoad < room : podLoad(x) < room));

  const score = (pods: Pod[]): Candidate[] => {
    const raw = pods.map((pod) => {
      const local = pod.entries.get(r.sid);
      const far = local ? undefined : w.remote.get(r.sid);
      const sharedTok = !local && !far ? sharedPrefixTokensFor(w, r) : 0;
      const group = sharedTok > 0 ? w.sessions.get(r.sid)?.prefixGroup : undefined;
      const shared = group !== undefined ? pod.sharedPrefixes?.get(group) : undefined;
      const tier: CacheLocation | null = local ? local.tier : far ? "remote" : shared ? "hbm" : null;
      const cachedTok = local ? local.tokens : far ? far.tokens : shared ? Math.min(shared.tokens, sharedTok) : 0;
      const cache = tier && r.lIn > 0 ? Math.min(1, cachedTok / r.lIn) : 0;
      const v = viewOf(pod);
      const liveKvUtil = pod.budget.poolBlocks ? activeBlocks(pod) / pod.budget.poolBlocks : 1;
      const kvUtilisation = multi && p.syncIntervalS > 0 ? (w.routerSync.podKvUtil.get(pod.id) ?? liveKvUtil) : liveKvUtil;
      return { podId: pod.id, cache, tier, kvUtilisation, ...v };
    });
    const meanObservedLoad = raw.length ? raw.reduce((s, x) => s + x.observedLoad, 0) / raw.length : 0;
    return raw.map((x) => {
      const s = policy.score({
        cachedFraction: x.cache,
        cacheLocation: x.tier,
        kvUtilisation: x.kvUtilisation,
        load: x.observedLoad,
        capacity,
        meanObservedLoad,
        boundedLoadEpsilon: p.boundedLoadEpsilon,
        ageDecayS: p.ageDecayS,
        ...(multi ? { ownLoad: x.ownLoad, peerLoad: x.peerLoad, peerStateAgeS: ageS } : {})
      });
      return {
        podId: x.podId,
        load: x.observedLoad,
        cache: x.cache,
        tier: x.tier,
        kvUtilisation: x.kvUtilisation,
        score: s,
        ...(multi ? { ownLoad: x.ownLoad, peerLoad: x.peerLoad, trueLoad: x.trueLoad } : {})
      };
    });
  };
  let cursor = w.rr;
  const pick = (candidates: Candidate[]): Candidate => {
    cursor = w.rr;
    const choice = policy.pick(candidates.map((c) => c.score), w.rr);
    w.rr = choice.cursor;
    return candidates[choice.index]!;
  };

  let candidates = score(p.disagg ? ready.filter((x) => x.role !== "prefill") : ready);
  if (!candidates.length) return false;
  let chosen = pick(candidates);
  let via = "direct";
  if (p.disagg) {
    // the decode pod is chosen first; only what it does not hold in GPU memory counts as uncached
    const uncached = r.lIn - (chosen.tier === "hbm" ? chosen.cache * r.lIn : 0);
    if (DECIDER.usePrefillPool(uncached, p.pdThreshold)) {
      const prefillCandidates = score(ready.filter((x) => x.role === "prefill"));
      if (!prefillCandidates.length) return false;
      candidates = prefillCandidates;
      chosen = pick(prefillCandidates);
      via = "prefill";
    } else via = "decode-only";
  }
  const pod = w.pods.find((x) => x.id === chosen.podId)!;
  pod.inbound++;
  if (multi) {
    trackRouterInFlight(w, r, pod.id, replica);
    w.routerCursor++;
  }
  r.podId = pod.id;
  r.stage = "toPod";
  r.stageStart = w.t;
  r.stageEnd = w.t + FRONTEND_HOPS.toPod;
  w.lastRoute = {
    t: w.t,
    sid: r.sid,
    reqId: r.id,
    chosen: pod.id,
    policy: p.routing,
    capacity,
    cursor,
    ...(multi ? { routerReplica: replica, peerStateAgeS: ageS, syncIntervalS: p.syncIntervalS } : {}),
    candidates
  };
  w.routeLog.push(w.lastRoute);
  if (w.routeLog.length > ROUTE_LOG_SIZE) w.routeLog.shift();
  emit(w, "req.routed", { podId: pod.id, sid: r.sid, reqId: r.id, cache: chosen.cache, tier: chosen.tier, load: chosen.load, n: candidates.length, via, role: pod.role });
  return true;
}

/** A decode pod that already holds the session in GPU memory beats any other; otherwise the least loaded. */
const handoffRank = (pod: Pod, r: Req): number => (pod.entries.get(r.sid)?.tier === "hbm" ? -1 : podLoad(pod));

/** Disaggregated serving: move each finished prefill's KV to a decode pod over the network. */
export function handoffs(w: World): void {
  const p = w.params;
  const capacity = p.maxNumSeqs + POD_QUEUE_SLACK;
  while (w.handoff.length) {
    const r = w.reqs.get(w.handoff[0]!);
    if (!r || r.stage !== "handoff") {
      w.handoff.shift();
      continue;
    }
    let best: Pod | null = null;
    for (const pod of w.pods) {
      if (pod.state !== "ready" || pod.role === "prefill" || podLoad(pod) >= capacity) continue;
      if (!best || handoffRank(pod, r) < handoffRank(best, r)) best = pod;
    }
    if (!best) return;
    w.handoff.shift();
    const held = best.entries.get(r.sid);
    const tokens = r.lIn + r.out;
    // only what the decode pod does not already hold has to cross the network
    const bytes = Math.max(0, tokens - (held?.tier === "hbm" ? held.tokens : 0)) * kvBytesPerToken(best.spec.model);
    const dur = transferSeconds(bytes, p.linkGbps);
    best.inbound++;
    r.podId = best.id;
    r.stage = "transfer";
    r.stageStart = w.t;
    r.stageEnd = w.t + dur;
    r.kvReady = tokens;
    emit(w, "kv.transfer", { podId: best.id, from: r.fromPod, sid: r.sid, reqId: r.id, bytes, dur, tokens });
  }
}
