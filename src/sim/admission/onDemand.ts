import type { AdmissionRule } from "./index.js";

/**
 * On-demand allocation: secure only the blocks the next step will write.
 *
 * Source: PagedAttention (Kwon et al., SOSP 2023, section 4.3). Blocks are allocated as tokens are
 * generated instead of being reserved for the maximum length, which is what lets several times
 * more sequences share a pool. With chunked prefill, vLLM's scheduler allocates for the tokens
 * scheduled in the current step (vLLM source, scheduler.py).
 *
 *     secure = cached + min(tokenBudget, promptTokens + generatedTokens − cached)
 *
 * The cost: memory is over-committed, so the pool can run out while sequences are mid-flight.
 *
 * The admission gate. Allocation is per chunk, but vLLM lets a waiting request in only if its WHOLE input
 * sequence fits (`scheduler_reserve_full_isl`, default True, vllm/config/scheduler.py: "checks whether the
 * full input sequence length fits in the KV cache before admitting a new request, rather than only
 * checking the first chunk"). In `allocate_slots` (vllm/v1/core/kv_cache_manager.py,
 * `full_sequence_must_fit`) the blocks for `request.num_tokens` tokens, less those a prefix hit already
 * supplies, must not exceed the pool's free blocks (cached blocks nobody uses count as free); if they do,
 * nothing is allocated and the scheduler stops admitting for this step. The scheduler passes the flag for
 * every request taken from the waiting queue, new or preempted (scheduler.py, waiting loop); running
 * sequences growing by a token are not gated. For a preempted request `num_tokens` is its prompt plus the
 * tokens it had generated, so it waits until its whole context fits instead of being admitted on its first
 * chunk and preempted again. BLIS implements the same gate as `FullSequenceMustFit` (core/kv/manager.go).
 *
 *     fit = promptTokens + generatedTokens        (blocks held by other running sequences excluded)
 *
 * This is a property of on-demand allocation as vLLM ships it, not a separate approach: it changes only
 * when a waiting request may start, never how blocks are allocated, and the other two rules already
 * secure the whole prompt (or more) at admission, which is the same gate.
 *
 * Example: a pool of 3,601 blocks, one running sequence holding 2,000 blocks, and a preempted request of
 * 36,000 tokens of context (2,250 blocks). Securing its first chunk (512 blocks) would succeed; the gate
 * asks for 2,250 against 1,601 free and keeps it waiting until the running sequence finishes.
 *
 * Simplified: no watermark (vLLM's default 0 disables it) and no `max_model_len` cap on the sequence.
 */
export const onDemand: AdmissionRule = {
  id: "on-demand",
  name: "On-demand (paged)",
  summary: "Allocate blocks for the tokens scheduled this step; grow as the sequence grows.",
  citations: ["kwon2023", "vllmScheduler"],
  fidelity: "structural",
  verification: ["preemption-overflow", "queue-deadline-shedding"],
  outputReservation: (r) => r.outputTokens,
  tokensToSecure: (r) => {
    const target = r.promptTokens + r.generatedTokens;
    return r.cachedTokens + Math.min(r.tokenBudget, target - r.cachedTokens);
  },
  tokensToFit: (r) => r.promptTokens + r.generatedTokens,
  allocatesPrefillPerChunk: true
};
