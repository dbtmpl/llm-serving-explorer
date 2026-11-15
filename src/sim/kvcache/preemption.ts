/**
 * Preemption: the pool is empty and a running sequence needs a block. Who gives memory back?
 */
import type { ApproachMeta } from "../approach.js";

export interface PreemptionPolicy extends ApproachMeta {
  /** The running sequence to preempt, or null. `protect` is the sequence asking for memory. */
  pickVictim<T extends { admitT: number }>(running: Iterable<T>, protect: T): T | null;
}

/**
 * Preempt the newest sequence and recompute it later.
 *
 * Source: vLLM. Under first-come-first-served priority the most recently admitted request is the
 * victim; all its blocks are freed and it returns to the front of the waiting queue to be
 * prefilled again from its prompt ("recompute"). The scheduler admits no new request in a step in
 * which it preempted (vLLM source, scheduler.py; vLLM docs, optimization). PagedAttention
 * (Kwon et al., SOSP 2023, section 4.5) describes the all-or-nothing eviction of a sequence and
 * the two recovery modes, swapping and recomputation; vLLM V1 keeps only recomputation.
 *
 * If the newest sequence is the one asking, nothing is preempted and it has to wait or yield.
 *
 * Example: sequences admitted at t = 1.0 s, 1.4 s and 2.2 s; the first needs a block. The one
 * from t = 2.2 s loses its KV and re-enters the queue.
 *
 * Not modelled: swapping to host memory, and live migration to another pod as in Llumnix
 * (Sun et al., OSDI 2024).
 */
export const preemptNewest: PreemptionPolicy = {
  id: "recompute-newest",
  name: "Preempt newest, recompute",
  summary: "Free the most recently admitted sequence and prefill it again later.",
  citations: ["vllmScheduler", "vllmOptimization", "kwon2023"],
  fidelity: "exact",
  verification: ["preemption-overflow"],
  pickVictim: <T extends { admitT: number }>(running: Iterable<T>, protect: T): T | null => {
    let victim: T | null = null;
    for (const r of running) if (!victim || r.admitT > victim.admitT) victim = r;
    return victim === protect ? null : victim;
  }
};
