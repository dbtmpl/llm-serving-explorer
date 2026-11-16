/**
 * The same model or GPU goes by different names in the TypeScript model's catalogue and in each
 * reference's. A scenario uses the neutral name; this table says what the TypeScript model calls it,
 * and each reference module (`refs/<id>/names.ts`) says what its own catalogue calls it.
 *
 * Both entries must describe the same hardware and architecture: memory, caching, routing and fate
 * depend on the architecture (layers, KV heads, head dimension) and on the GPU's memory.
 */
export const MODEL_NAMES: Record<string, string> = {
  /** Llama 3.1 8B: 32 layers, 8 KV heads, head dimension 128. */
  "llama-3.1-8b": "llama-3.1-8b",
  /** Llama 3.1 70B: 80 layers, 8 KV heads, head dimension 128. */
  "llama-70b": "llama-3.1-70b"
};

export const GPU_NAMES: Record<string, string> = {
  h100: "h100",
  h200: "h200",
  b200: "b200",
  "rtx-pro-6000": "rtx-pro-6000",
  "rtx-4090": "rtx-4090"
};

export function typescriptModel(neutral: string): string {
  const n = MODEL_NAMES[neutral];
  if (!n) throw new Error(`unknown model "${neutral}"; known: ${Object.keys(MODEL_NAMES).join(", ")}`);
  return n;
}

export function typescriptGpu(neutral: string): string {
  const n = GPU_NAMES[neutral];
  if (!n) throw new Error(`unknown GPU "${neutral}"; known: ${Object.keys(GPU_NAMES).join(", ")}`);
  return n;
}
