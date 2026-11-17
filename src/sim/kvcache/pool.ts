/**
 * Getting blocks for a sequence: grow its allocation, evicting idle sessions and, if allowed,
 * preempting a running one to make room.
 */
import type { KvEntry, Pod, Req, World } from "../core/types.js";
import { emit } from "../core/world.js";
import { BLOCK_TOKENS, blocksFor } from "./blocks.js";
import { releaseHbm, syncCells } from "./hbm.js";
import { preemptNewest } from "./preemption.js";
import { demote, evictionVictim } from "./tiers.js";

/** The preemption policy in use. With a second approach this becomes a parameter. */
export const PREEMPTION = preemptNewest;

/**
 * Take a running sequence's memory away and put it back at the head of the pod's queue.
 *
 * With prefix caching on, the KV it has written stays findable, as in vLLM: preemption frees the
 * request's blocks into the free queue (`_preempt_request` and `free`, vllm/v1/core/sched/scheduler.py
 * and kv_cache_manager.py), freed in reverse order so the tail goes first, and a full block keeps its
 * hash until the block is handed out again. When the request is admitted again, the prefix cache serves
 * whatever is still there and only the rest is recomputed. The model keeps the full blocks as an idle
 * entry that `makeRoom` trims from the tail before it evicts anything whole. Without prefix caching the
 * KV is gone and the request is recomputed from its first token.
 */
export function preempt(w: World, pod: Pod, r: Req, why: string): void {
  const e = pod.entries.get(r.sid);
  let cells: number[] = [];
  let kept = 0;
  if (e) {
    if (w.params.prefixCaching && e.tier === "hbm") {
      // only full blocks carry a hash; the partly written last block and unwritten reservations are freed
      kept = Math.floor(e.tokens / BLOCK_TOKENS) * BLOCK_TOKENS;
      const before = e.cells.slice();
      e.active = false;
      e.lastUsed = w.t;
      e.preempted = true;
      e.tokens = kept;
      trimBlocks(pod, e, e.blocks - blocksFor(Math.max(1, kept)) + (kept === 0 ? 1 : 0));
      cells = before.filter((c) => !e.cells.includes(c));
      if (e.blocks === 0) pod.entries.delete(r.sid);
    } else {
      cells = releaseHbm(pod, e);
      pod.entries.delete(r.sid);
    }
  }
  pod.running.splice(pod.running.indexOf(r.id), 1);
  pod.waiting.unshift(r.id);
  r.stage = "waiting";
  r.prefillDone = 0;
  r.cached = 0;
  r.preemptions++;
  w.m.preemptions++;
  emit(w, "req.preempted", { podId: pod.id, sid: r.sid, reqId: r.id, cells, why, lost: r.lIn + r.out - kept, kept });
}

/** Give up the last `n` blocks of an entry (at most all of them). */
function trimBlocks(pod: Pod, e: KvEntry, n: number): void {
  const k = Math.max(0, Math.min(n, e.blocks));
  e.blocks -= k;
  pod.usedBlocks -= k;
  e.tokens = Math.min(e.tokens, e.blocks * BLOCK_TOKENS);
  syncCells(pod, e);
}

/**
 * Free `need` blocks in a pod's pool for `requester`. Idle cached sessions go first, since
 * evicting them costs nobody a recompute; only then, and only if `allowPreempt`, a running
 * sequence chosen by the preemption policy. A preempted request's leftover blocks are given up
 * from the tail, only as many as are needed, as vLLM's free queue hands them out.
 */
export function makeRoom(w: World, pod: Pod, need: number, requester: Req, allowPreempt: boolean): boolean {
  while (pod.budget.poolBlocks - pod.usedBlocks < need) {
    const idle = evictionVictim(pod, "hbm", pod.entries.get(requester.sid));
    if (idle?.preempted) {
      trimBlocks(pod, idle, need - (pod.budget.poolBlocks - pod.usedBlocks));
      if (idle.blocks === 0) pod.entries.delete(idle.sid);
      continue;
    }
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
