/**
 * The router: sends each queued request to a pod, and in a split fleet moves finished prefills to
 * a decode pod.
 */
import type { Pod, Req, World } from "../core/types.js";
import { emit, podLoad } from "../core/world.js";
import { kvBytesPerToken } from "../cost/memory.js";
import { DECIDER, transferSeconds } from "../disaggregation/index.js";
import { activeBlocks } from "../kvcache/hbm.js";
import { POD_QUEUE_SLACK, routingPolicy, type CacheLocation } from "../routing/index.js";
import { FRONTEND_HOPS } from "../workload/frontend.js";
import { ROUTE_LOG_SIZE } from "./constants.js";

interface Candidate {
  podId: number;
  load: number;
  cache: number;
  tier: CacheLocation | null;
  kvUtilisation: number;
  score: number;
}

/** Try to route one request. Returns false when no pod can take it yet. */
export function route(w: World, r: Req): boolean {
  const p = w.params;
  const policy = routingPolicy(p.routing);
  const capacity = p.maxNumSeqs + POD_QUEUE_SLACK;
  // while pods are still starting, hold the overflow at the gateway instead of queueing it behind a full pod
  const starting = w.pods.some((x) => x.state === "creating" || x.state === "loading");
  const room = starting ? p.maxNumSeqs : capacity;
  const ready = w.pods.filter((x) => x.state === "ready" && podLoad(x) < room);

  const score = (pods: Pod[]): Candidate[] =>
    pods.map((pod) => {
      const local = pod.entries.get(r.sid);
      const far = local ? undefined : w.remote.get(r.sid);
      const tier: CacheLocation | null = local ? local.tier : far ? "remote" : null;
      const cache = tier && r.lIn > 0 ? Math.min(1, (local ? local.tokens : far!.tokens) / r.lIn) : 0;
      const load = podLoad(pod);
      const kvUtilisation = pod.budget.poolBlocks ? activeBlocks(pod) / pod.budget.poolBlocks : 1;
      return { podId: pod.id, load, cache, tier, kvUtilisation, score: policy.score({ cachedFraction: cache, cacheLocation: tier, kvUtilisation, load, capacity }) };
    });
  const pick = (candidates: Candidate[]): Candidate => {
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
  r.podId = pod.id;
  r.stage = "toPod";
  r.stageStart = w.t;
  r.stageEnd = w.t + FRONTEND_HOPS.toPod;
  w.lastRoute = { t: w.t, sid: r.sid, reqId: r.id, chosen: pod.id, policy: p.routing, capacity, candidates };
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
