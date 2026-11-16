/**
 * What BLIS's catalogue calls the neutral models and GPUs of a scenario.
 *
 * Both entries must describe the same architecture (layers, KV heads, head dimension) and memory as
 * the TypeScript model's (`translate/names.ts`).
 */
export const MODEL_NAMES: Record<string, string> = {
  "llama-3.1-8b": "llama-3.1-8b-instruct",
  "llama-70b": "llama-3.1-70b-instruct"
};

export const GPU_NAMES: Record<string, string> = {
  h100: "h100",
  h200: "h200",
  b200: "b200"
};

/**
 * What BLIS's catalogue says each GPU's memory is, in GiB (`MemoryGiB` of `catalog/hardware/<gpu>.yaml`). A node pool must state it exactly
 * (BLIS refuses another number), and only a run with an autoscaler has a node pool.
 */
export const GPU_MEMORY_GIB: Record<string, number> = { h100: 79.1895752, h200: 139.80072021, b200: 178.35107422 };

export function modelName(neutral: string): string {
  const n = MODEL_NAMES[neutral];
  if (!n) throw new Error(`BLIS has no model "${neutral}"; known: ${Object.keys(MODEL_NAMES).join(", ")}`);
  return n;
}

export function gpuName(neutral: string): string {
  const n = GPU_NAMES[neutral];
  if (!n) throw new Error(`BLIS has no GPU "${neutral}"; known: ${Object.keys(GPU_NAMES).join(", ")}`);
  return n;
}
