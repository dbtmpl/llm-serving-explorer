/** What LLMServingSim's catalogue calls the neutral models and GPUs of a scenario (`profiler/perf/<hardware>/<model>/`). */
export const MODEL_NAMES: Record<string, string> = {
  "llama-3.1-8b": "meta-llama/Llama-3.1-8B"
};

/** Only the GPUs it ships a profile bundle for that the TypeScript catalogue also has. */
export const GPU_NAMES: Record<string, string> = {
  "rtx-pro-6000": "RTXPRO6000",
  "rtx-4090": "RTX4090"
};

export function modelName(neutral: string): string {
  const n = MODEL_NAMES[neutral];
  if (!n) throw new Error(`LLMServingSim has no model "${neutral}"; known: ${Object.keys(MODEL_NAMES).join(", ")}`);
  return n;
}

export function gpuName(neutral: string): string {
  const n = GPU_NAMES[neutral];
  if (!n) throw new Error(`LLMServingSim has no GPU "${neutral}"; known: ${Object.keys(GPU_NAMES).join(", ")}`);
  return n;
}
