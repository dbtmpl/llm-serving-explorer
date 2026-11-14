export interface GlossaryEntry {
  readonly term: string;
  readonly shortLabel: string;
  readonly definition: string;
}

export const GLOSSARY_ENTRIES: readonly GlossaryEntry[] = [
  {
    term: "BLIS (Blackbox Inference Simulator)",
    shortLabel: "BLIS",
    definition:
      "The discrete-event simulator (inference-sim) that models the end-to-end llm-d + vLLM serving stack and emits deterministic event streams."
  },
  {
    term: "EPP (Endpoint Picker)",
    shortLabel: "EPP",
    definition:
      "The llm-d router component embedded inside BLIS (sim/llmd) that performs admission control, flow control, and scored endpoint selection."
  },
  {
    term: "KV Block",
    shortLabel: "KV Block",
    definition:
      "A fixed-size page of block_size tokens (default 16) in GPU HBM or CPU DRAM. States: active/used (RefCnt > 0), cached (unpinned RefCnt == 0 holding a prefix hash until LRU eviction), or free."
  },
  {
    term: "Prefix Caching",
    shortLabel: "Prefix Cache",
    definition:
      "Reusing previously computed KV blocks across requests that share an identical leading token block chain. Shared active blocks have multiple owner requests."
  },
  {
    term: "Eviction",
    shortLabel: "Eviction",
    definition:
      "Removing a cached, unpinned KV block's hash from the prefix cache (either dropping it or offloading it to CPU DRAM) to make room for a new allocation."
  },
  {
    term: "Preemption",
    shortLabel: "Preemption",
    definition:
      "Evicting a running request back to the waiting queue and freeing its KV blocks when the engine runs out of free blocks mid-generation."
  },
  {
    term: "Chunked Prefill",
    shortLabel: "Chunked Prefill",
    definition:
      "Splitting a long prompt prefill across multiple engine steps (max_num_batched_tokens) so shorter decode/prefill requests can share GPU batches."
  },
  {
    term: "Continuous Batching",
    shortLabel: "Continuous Batching",
    definition:
      "Iteration-level scheduling (max_num_seqs > 1) where requests join or leave the running batch on every forward step rather than waiting for an entire batch to finish."
  },
  {
    term: "P/D Disaggregation",
    shortLabel: "P/D Split",
    definition:
      "Separating prefill pods and decode pods into distinct pools, transferring computed KV cache blocks between them via kv.transfer."
  },
  {
    term: "Tensor Parallelism (TP)",
    shortLabel: "TP",
    definition:
      "Sharding a single pod's model weights and KV cache heads across tp GPUs within the pod."
  },
  {
    term: "Arithmetic Intensity (AI)",
    shortLabel: "AI",
    definition:
      "FLOPs / BytesMoved for a GPU step, plotted on the Roofline chart against the GPU's peak compute (TFlops) and HBM bandwidth (TB/s) limits."
  },
  {
    term: "TTFT (Time to First Token)",
    shortLabel: "TTFT",
    definition:
      "Time from request arrival at the gateway to emission of its first output token."
  },
  {
    term: "TPOT (Time Per Output Token)",
    shortLabel: "TPOT",
    definition:
      "Mean time per generated token after the first token: (E2E - TTFT) / (output_tokens - 1)."
  }
];

const GLOSSARY_MAP = new Map<string, GlossaryEntry>(
  GLOSSARY_ENTRIES.map((e) => [e.shortLabel.toLowerCase(), e])
);

export function lookupGlossary(shortLabel: string): GlossaryEntry | undefined {
  return GLOSSARY_MAP.get(shortLabel.toLowerCase());
}
