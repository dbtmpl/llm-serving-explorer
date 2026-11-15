/**
 * Evicting one idle session now, on demand.
 *
 * Only the step-through walkthrough calls this: in a live run an eviction happens when a new
 * block is needed and the pool has none free (`makeRoom` in pool.ts). The walkthrough cannot wait
 * for that, so it asks for the same move for the followed session. The move itself is `demote`,
 * the function `makeRoom` calls, so the same events are emitted (`kv.move` to the first tier with
 * room, or `kv.drop` when none has) and the same counters change. What differs is only who picks
 * the victim: here the caller, there the eviction policy.
 */
import type { World } from "../core/types.js";
import { demote } from "./tiers.js";

/**
 * Move the idle KV of session `sid` out of GPU memory. `podId` names the pod that holds it (the
 * pod that finished the request); without it the first pod holding an idle copy is used.
 * Returns false, and changes nothing, if no pod holds an idle copy in GPU memory.
 */
export function evictIdleNow(w: World, sid: number, podId?: number): boolean {
  for (const pod of w.pods) {
    if (podId !== undefined && pod.id !== podId) continue;
    const e = pod.entries.get(sid);
    if (!e || e.tier !== "hbm" || e.active || pod.state === "terminated") continue;
    demote(w, pod, e);
    return true;
  }
  return false;
}
