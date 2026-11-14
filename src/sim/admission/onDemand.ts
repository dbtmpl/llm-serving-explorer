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
 * Example: a 20,000-token prompt with nothing cached and an 8,192-token budget secures 8,192
 * tokens (512 blocks) to join, and the rest chunk by chunk.
 */
export const onDemand: AdmissionRule = {
  id: "on-demand",
  name: "On-demand (paged)",
  summary: "Allocate blocks for the tokens scheduled this step; grow as the sequence grows.",
  citations: ["kwon2023", "vllmScheduler"],
  fidelity: "structural",
  outputReservation: (r) => r.outputTokens,
  tokensToSecure: (r) => {
    const target = r.promptTokens + r.generatedTokens;
    return r.cachedTokens + Math.min(r.tokenBudget, target - r.cachedTokens);
  },
  allocatesPrefillPerChunk: true
};
