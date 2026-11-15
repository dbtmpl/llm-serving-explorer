import type { AdmissionRule } from "./index.js";

/**
 * Whole-prompt allocation: secure blocks for the entire prompt before starting; outputs still
 * grow on demand.
 *
 * This is paged allocation as first published, before chunked prefill: the prompt is processed in
 * one prefill step, so all its blocks are needed at once (Kwon et al., SOSP 2023, section 4.3).
 *
 *     secure = promptTokens + generatedTokens
 *
 * Example: the 20,000-token prompt secures 1,250 blocks before it joins.
 */
export const wholePrompt: AdmissionRule = {
  id: "prompt",
  name: "Whole prompt",
  summary: "Allocate blocks for the full prompt at admission; outputs grow on demand.",
  citations: ["kwon2023"],
  fidelity: "structural",
  verification: { notVerifiable: "vLLM allocates KV memory as tokens are written and BLIS translates vLLM, so neither has a policy that reserves a whole prompt before admitting it; there is no counterpart to compare." },
  outputReservation: (r) => r.outputTokens,
  tokensToSecure: (r) => r.promptTokens + r.generatedTokens,
  tokensToFit: (r) => r.promptTokens + r.generatedTokens,
  allocatesPrefillPerChunk: false
};
