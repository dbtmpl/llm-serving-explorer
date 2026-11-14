import type { AdmissionRule } from "./index.js";

/**
 * Reserve to completion: secure memory for the prompt and the longest output the request could
 * produce, so an admitted request can never run out of memory.
 *
 * This is how engines behaved before paging: Orca reserves for `max_tokens`, the baseline that
 * PagedAttention is measured against (Kwon et al., SOSP 2023, sections 3.1 and 6.1). It survives
 * as a deliberate policy in TensorRT-LLM's `GuaranteedNoEvict` scheduler, which trades batch size
 * for never preempting.
 *
 *     secure = promptTokens + max(outputTokens, maxTokensCap)
 *
 * Example: a 3,000-token prompt with `max_tokens` 4,096 reserves 7,096 tokens even if the answer
 * turns out to be 150 tokens long. Most of the reservation stays empty.
 */
export const reserveToCompletion: AdmissionRule = {
  id: "reserve",
  name: "Reserve to completion",
  summary: "Reserve prompt plus max_tokens up front; admitted requests are never preempted.",
  citations: ["kwon2023", "tensorrtLlm", "yu2022"],
  fidelity: "structural",
  outputReservation: (r) => Math.max(r.outputTokens, r.maxTokensCap),
  tokensToSecure: (r) => r.promptTokens + Math.max(r.outputTokens, r.maxTokensCap),
  allocatesPrefillPerChunk: false
};
