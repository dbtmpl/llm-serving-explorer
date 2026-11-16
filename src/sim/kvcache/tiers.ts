/**
 * KV tiers below GPU memory: host DRAM, local SSD, and a pool shared by all pods.
 *
 * Sources: CachedAttention (Gao et al., USENIX ATC 2024) keeps the KV of idle conversation
 * sessions in a hierarchy of host memory and disks so that a returning session is loaded instead
 * of recomputed. Mooncake (Qin et al., FAST 2025) adds a KV pool shared across nodes. The same
 * layering ships in LMCache, NVIDIA Dynamo's KV block manager and llm-d's KV offloader.
 *
 * Mechanism modelled: when GPU memory is needed, the least recently used idle session moves down
 * one tier; if that tier is full, its own least recently used session moves down first. The
 * remote pool is the only tier that survives its pod and the only one another pod can load from.
 *
 *     HBM  →  DRAM  →  SSD  →  remote pool  →  dropped (rebuilt from text on return)
 *
 * Simplifications: whole sessions move, not blocks; a copy is moved rather than written through
 * at the end of a turn; capacities and copy rates are parameters, not measurements of a device.
 */
import type { ApproachMeta } from "../approach.js";
import type { Params } from "../core/params.js";
import type { KvEntry, Pod, Tier, World } from "../core/types.js";
import { emit } from "../core/world.js";
import { linkBytesPerSecond } from "../disaggregation/index.js";
import { leastRecentlyUsed } from "./eviction.js";
import { releaseHbm } from "./hbm.js";

export const tieredCache: ApproachMeta = {
  id: "hbm-dram-ssd-remote",
  name: "HBM → DRAM → SSD → shared pool",
  summary: "Idle sessions move down a memory hierarchy instead of being dropped, and are loaded back on return.",
  citations: ["gao2024", "qin2024", "lmcache2025", "llmdKvOffloader", "dynamoKvbm"],
  fidelity: "structural",
  verification: ["tiers-offload", "lss-tiers-offload"]
};

/** The eviction order used in every tier. */
export const EVICTION = leastRecentlyUsed;

const GIGABYTE = 1e9;

/** Bytes per second for bringing KV back to GPU memory from each lower tier. */
export const tierBw = (p: Params) => ({ dram: p.dramGBs * GIGABYTE, ssd: p.ssdGBs * GIGABYTE, remote: linkBytesPerSecond(p.remoteGbps) });

/** Blocks of this pod's KV that fit in `gigabytes` of a lower tier. */
export const tierCapBlocks = (pod: Pod, gigabytes: number): number => Math.floor((gigabytes * GIGABYTE) / pod.budget.blockBytes);

const entryBytes = (pod: Pod, e: KvEntry): number => e.blocks * pod.budget.blockBytes;

function idleIn(pod: Pod, tier: Tier, skip?: KvEntry): KvEntry | null {
  const candidates: KvEntry[] = [];
  for (const e of pod.entries.values()) if (e.tier === tier && !e.active && e !== skip) candidates.push(e);
  return EVICTION.pickVictim(candidates);
}

/** The least recently used idle session in a tier of a pod, if any. */
export const evictionVictim = idleIn;

function leaveNodeTier(pod: Pod, e: KvEntry, from: Tier): void {
  if (from === "dram") pod.dramBlocks -= e.blocks;
  if (from === "ssd") pod.ssdBlocks -= e.blocks;
}

/** The KV is gone. The session can still be rebuilt from its text. */
export function dropEntry(w: World, pod: Pod, e: KvEntry, from: Tier, cells: number[] = []): void {
  leaveNodeTier(pod, e, from);
  pod.entries.delete(e.sid);
  w.m.drops++;
  emit(w, "kv.drop", { podId: pod.id, sid: e.sid, from, cells, bytes: entryBytes(pod, e), tokens: e.tokens });
}

/** Leave the node: into the shared pool if it has room after evicting its oldest, otherwise dropped. */
function toRemote(w: World, pod: Pod, e: KvEntry, from: Tier, cells: number[] = []): void {
  const bytes = entryBytes(pod, e);
  const capacity = w.params.remoteGB * GIGABYTE;
  if (bytes > capacity) return dropEntry(w, pod, e, from, cells);
  while (w.remoteBytes + bytes > capacity) {
    const old = EVICTION.pickVictim(w.remote.values());
    if (!old) break;
    w.remote.delete(old.sid);
    w.remoteBytes -= old.bytes;
    w.m.drops++;
    emit(w, "kv.drop", { sid: old.sid, from: "remote", cells: [], bytes: old.bytes, tokens: old.tokens });
  }
  leaveNodeTier(pod, e, from);
  pod.entries.delete(e.sid);
  const previous = w.remote.get(e.sid);
  if (previous) w.remoteBytes -= previous.bytes;
  w.remote.set(e.sid, { sid: e.sid, tokens: e.tokens, bytes, lastUsed: e.lastUsed });
  w.remoteBytes += bytes;
  emit(w, "kv.move", { podId: pod.id, sid: e.sid, from, to: "remote", cells, bytes, tokens: e.tokens, idleFor: w.t - e.lastUsed });
}

function toSsd(w: World, pod: Pod, e: KvEntry, from: Tier, cells: number[]): void {
  const capacity = tierCapBlocks(pod, w.params.ssdGB);
  if (e.blocks > capacity) return toRemote(w, pod, e, from, cells);
  while (pod.ssdBlocks + e.blocks > capacity) {
    const victim = idleIn(pod, "ssd", e);
    if (!victim) return toRemote(w, pod, e, from, cells);
    toRemote(w, pod, victim, "ssd");
  }
  if (from === "dram") pod.dramBlocks -= e.blocks;
  e.tier = "ssd";
  pod.ssdBlocks += e.blocks;
  emit(w, "kv.move", { podId: pod.id, sid: e.sid, from, to: "ssd", cells, bytes: entryBytes(pod, e), tokens: e.tokens, idleFor: w.t - e.lastUsed });
}

/** Evict one idle session from GPU memory to the next tier down that can take it. */
export function demote(w: World, pod: Pod, e: KvEntry): void {
  const cells = releaseHbm(pod, e);
  w.m.evictions++;
  const capacity = tierCapBlocks(pod, w.params.dramGB);
  if (e.blocks > capacity) return toSsd(w, pod, e, "hbm", cells);
  while (pod.dramBlocks + e.blocks > capacity) {
    const victim = idleIn(pod, "dram", e);
    if (!victim) return toSsd(w, pod, e, "hbm", cells);
    toSsd(w, pod, victim, "dram", []);
  }
  e.tier = "dram";
  pod.dramBlocks += e.blocks;
  emit(w, "kv.move", { podId: pod.id, sid: e.sid, from: "hbm", to: "dram", cells, bytes: entryBytes(pod, e), tokens: e.tokens, idleFor: w.t - e.lastUsed });
}
