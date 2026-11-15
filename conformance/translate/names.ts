/**
 * The same model or GPU goes by different names in the two simulators' catalogues. A scenario uses
 * the neutral name; this table says what each simulator calls it.
 *
 * Both entries must describe the same hardware and architecture. Timing is not compared in phase 1,
 * so only memory, caching, routing and fate have to match, and those depend on the architecture
 * (layers, KV heads, head dimension) and on the GPU's memory.
 */
export interface NameMap {
  typescript: string;
  blis: string;
}

export const MODEL_NAMES: Record<string, NameMap> = {
  /** Llama 3.1 8B: 32 layers, 8 KV heads, head dimension 128 in both catalogues. */
  "llama-3.1-8b": { typescript: "llama-3.1-8b", blis: "llama-3.1-8b-instruct" },
  /** Llama 3.1 70B in both catalogues: 80 layers, 8 KV heads, head dimension 128. */
  "llama-70b": { typescript: "llama-3.1-70b", blis: "llama-3.1-70b-instruct" }
};

export const GPU_NAMES: Record<string, NameMap> = {
  h100: { typescript: "h100", blis: "h100" },
  h200: { typescript: "h200", blis: "h200" },
  b200: { typescript: "b200", blis: "b200" }
};

/**
 * What BLIS's catalogue says each GPU's memory is, in GiB (`MemoryGiB` of `catalog/hardware/<gpu>.yaml`). A node pool must state it exactly
 * (BLIS refuses another number), and only a run with an autoscaler has a node pool.
 */
export const GPU_MEMORY_GIB: Record<string, number> = { h100: 79.1895752, h200: 139.80072021, b200: 178.35107422 };

export function modelNames(neutral: string): NameMap {
  const n = MODEL_NAMES[neutral];
  if (!n) throw new Error(`unknown model "${neutral}"; known: ${Object.keys(MODEL_NAMES).join(", ")}`);
  return n;
}

export function gpuNames(neutral: string): NameMap {
  const n = GPU_NAMES[neutral];
  if (!n) throw new Error(`unknown GPU "${neutral}"; known: ${Object.keys(GPU_NAMES).join(", ")}`);
  return n;
}
