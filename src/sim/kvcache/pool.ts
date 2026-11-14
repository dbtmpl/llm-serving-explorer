/**
 * Getting blocks for a sequence: grow its allocation, evicting idle sessions and, if allowed,
 * preempting a running one to make room.
 */
import type { KvEntry, Pod, Req, World } from "../core/types.js";
import { emit } from "../core/world.js";
import { blocksFor } from "./blocks.js";
import { releaseHbm, syncCells } from "./hbm.js";
import { preemptNewest } from "./preemption.js";
import { demote, evictionVictim } from "./tiers.js";

/** The preemption policy in use. With a second approach this becomes a parameter. */
export const PREEMPTION = preemptNewest;

/** Take a running sequence's memory away and put it back at the head of the pod's queue. */
export function preempt(w: World, pod: Pod, r: Req, why: string): void {
  const e = pod.entries.get(r.sid);
  let cells: number[] = [];
  if (e) {
    cells = releaseHbm(pod, e);
    pod.entries.delete(r.sid);
  }
  pod.running.splice(pod.running.indexOf(r.id), 1);
  pod.waiting.unshift(r.id);
  r.stage = "waiting";
  r.prefillDone = 0;
  r.cached = 0;
  r.preemptions++;
  w.m.preemptions++;
  emit(w, "req.preempted", { podId: pod.id, sid: r.sid, reqId: r.id, cells, why, lost: r.lIn + r.out });
}

/**
 * Free `need` blocks in a pod's pool for `requester`. Idle cached sessions go first, since
 * evicting them costs nobody a recompute; only then, and only if `allowPreempt`, a running
 * sequence chosen by the preemption policy.
 */
export function makeRoom(w: World, pod: Pod, need: number, requester: Req, allowPreempt: boolean): boolean {
  while (pod.budget.poolBlocks - pod.usedBlocks < need) {
    const idle = evictionVictim(pod, "hbm", pod.entries.get(requester.sid));
    if (idle) {
      demote(w, pod, idle);
      continue;
    }
    if (!allowPreempt) return false;
    const preemptible: Req[] = [];
    for (const id of pod.running) {
      const r = w.reqs.get(id)!;
      // a sequence whose KV is still being copied in has nothing to recompute from yet
      if (r.stage !== "reload") preemptible.push(r);
    }
    const victim = PREEMPTION.pickVictim(preemptible, requester);
    if (!victim) return false;
    preempt(w, pod, victim, "KV memory short");
  }
  return true;
}

/** Make an entry hold blocks for `tokens` tokens. Returns false if the pool cannot provide them. */
export function growTo(w: World, pod: Pod, e: KvEntry, tokens: number, r: Req, allowPreempt: boolean): boolean {
  const need = blocksFor(tokens) - e.blocks;
  if (need > 0) {
    if (!makeRoom(w, pod, need, r, allowPreempt)) return false;
    e.blocks += need;
    pod.usedBlocks += need;
  }
  e.tokens = tokens;
  syncCells(pod, e);
  return true;
}
