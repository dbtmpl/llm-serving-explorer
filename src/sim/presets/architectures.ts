/**
 * A trajectory of serving architectures, oldest first. Each one is the previous plus one idea,
 * expressed as parameter changes to the same simulation so the difference can be watched.
 */
import type { CitationKey } from "../citations.js";
import type { Params } from "../core/params.js";

export interface Architecture {
  id: string;
  year: string;
  name: string;
  /** label for the dropdown */
  short: string;
  /** what this step adds, and the problem it fixes */
  adds: string;
  /** where the idea comes from and who ships it */
  source: string;
  /** the sources behind this step, as keys into the citation registry */
  citations: readonly CitationKey[];
  params: Partial<Params>;
}

const VANILLA: Partial<Params> = {
  batching: "static",
  admission: "reserve",
  tokenBudget: 65536,
  prefixCaching: false,
  routing: "round-robin",
  dramGB: 0,
  ssdGB: 0,
  remoteGB: 0,
  disagg: false,
  specDecode: false,
  overlap: false,
  shedAfterS: 0
};

export const ARCHITECTURES: Architecture[] = [
  {
    id: "static",
    year: "before 2022",
    name: "Static batching, reserved memory",
    short: "Static batching",
    adds: "The baseline. A batch is formed, runs until its longest answer ends, and only then does the next batch start. Every request reserves KV memory for its prompt plus the maximum output it might produce. Watch finished slots sit idle, late arrivals wait for the whole batch, and most reserved memory stay empty.",
    source: "Request-level batching as in general model servers (TF Serving, Triton dynamic batching).",
    citations: ["crankshaw2017", "tritonBatcher"],
    params: { ...VANILLA }
  },
  {
    id: "orca",
    year: "2022",
    name: "Continuous batching",
    short: "Continuous batching",
    adds: "The batch is re-decided at every engine step: a finished sequence leaves at once and a waiting one takes its slot. Removes both waits of static batching. Memory is still reserved for the maximum length.",
    source: "Orca (Yu et al., OSDI 2022) called it iteration-level scheduling. Now universal: vLLM, TGI, TensorRT-LLM (in-flight batching), SGLang.",
    citations: ["yu2022"],
    params: { ...VANILLA, batching: "continuous" }
  },
  {
    id: "paged",
    year: "2023",
    name: "PagedAttention: KV in blocks, on demand",
    short: "PagedAttention",
    adds: "KV memory is cut into fixed blocks handed out as tokens are actually written, like virtual memory pages. A sequence holds what it uses, so several times more sequences fit. The price: the pool can run out mid-decode, and then the newest sequence is preempted and recomputed.",
    source: "vLLM (Kwon et al., SOSP 2023). TensorRT-LLM and SGLang use paged KV pools too.",
    citations: ["kwon2023"],
    params: { ...VANILLA, batching: "continuous", admission: "on-demand" }
  },
  {
    id: "prefix",
    year: "2024",
    name: "Chunked prefill, prefix cache, cache-aware routing",
    short: "Chunked prefill + prefix cache",
    adds: "Three fixes that arrived together. A long prompt is prefilled in chunks under a per-step token budget, so it no longer stalls every running stream for its whole length. Finished sequences keep their blocks, so a follow-up turn only prefills its new tokens. And the router sends a session back to the pod that holds its cache.",
    source: "Sarathi-Serve (Agrawal et al., OSDI 2024) for chunked prefill; SGLang RadixAttention and vLLM automatic prefix caching; prefix-aware routing in llm-d, SGLang router, Dynamo.",
    citations: ["agrawal2024", "zheng2023", "vllmPrefixCaching", "llmdScheduling"],
    params: { ...VANILLA, batching: "continuous", admission: "on-demand", tokenBudget: 8192, prefixCaching: true, routing: "prefix-aware" }
  },
  {
    id: "tiers",
    year: "2024–25",
    name: "Tiered KV cache below the GPU",
    short: "Tiered KV cache",
    adds: "Idle sessions no longer hold GPU memory or get thrown away. Their KV moves to host DRAM, local SSD and a pool shared by all pods, and is loaded back when that beats recomputing. Fixes the choice between wasting HBM on absent users and paying a full prefill when they return.",
    source: "CachedAttention (Gao et al., USENIX ATC 2024), Mooncake (Qin et al., FAST 2025), LMCache, SGLang HiCache, NVIDIA Dynamo's KV block manager (tiers G1 to G4), vLLM's OffloadingConnector (0.11, late 2025).",
    citations: ["gao2024", "qin2024", "lmcache2025", "dynamoKvbm", "llmdKvOffloader"],
    params: { ...VANILLA, batching: "continuous", admission: "on-demand", tokenBudget: 8192, prefixCaching: true, routing: "prefix-aware", dramGB: 32, ssdGB: 128, remoteGB: 256 }
  },
  {
    id: "disagg",
    year: "2024–26",
    name: "Prefill / decode disaggregation",
    short: "Prefill/decode split",
    adds: "Prefill and decode run on separate pools. A prefill pod computes the prompt's KV and ships it over the network to a decode pod. Compute-bound and memory-bound work stop sharing steps, so each pool can be sized and tuned for its own latency target. Follow-ups whose history is already cached skip the prefill pool.",
    source: "DistServe (Zhong et al., OSDI 2024) and Splitwise (Patel et al., ISCA 2024); in production at Moonshot (Mooncake); shipped in llm-d, NVIDIA Dynamo, vLLM and SGLang. Pays off most for long prompts with short answers and medium to large models, and needs a fast (RDMA) link for the transfer.",
    citations: ["zhong2024", "patel2023", "qin2024", "llmdDisaggregation"],
    params: { ...VANILLA, batching: "continuous", admission: "on-demand", tokenBudget: 8192, prefixCaching: true, routing: "prefix-aware", dramGB: 32, ssdGB: 128, remoteGB: 256, disagg: true }
  },
  {
    id: "full",
    year: "2026",
    name: "Today's full stack",
    short: "Today's full stack",
    adds: "Adds the remaining common levers. Speculative decoding emits several tokens per step. Host work overlaps the GPU step instead of adding to it. The gateway sheds requests that have waited past their deadline instead of answering late.",
    source: "Speculative decoding (Leviathan et al., ICML 2023), now built into vLLM, SGLang and TensorRT-LLM; asynchronous scheduling in SGLang and vLLM; flow control in llm-d and Dynamo.",
    citations: ["leviathan2023", "llmdFlowControl"],
    params: { ...VANILLA, batching: "continuous", admission: "on-demand", tokenBudget: 8192, prefixCaching: true, routing: "prefix-aware", dramGB: 32, ssdGB: 128, remoteGB: 256, disagg: true, specDecode: true, overlap: true, shedAfterS: 20 }
  }
];

/** The architecture the default parameters correspond to. */
export const DEFAULT_ARCH = "tiers";
