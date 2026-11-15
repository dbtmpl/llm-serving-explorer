/**
 * Every source this simulation is built on, in one place.
 *
 * Rule: no approach enters the simulation without an entry here. Modules refer to sources by key,
 * so a citation is written once and the tables in the READMEs are generated from this file
 * (`pnpm docs:sync`).
 */

export type CitationKind = "paper" | "docs" | "source" | "datasheet";

export interface Citation {
  /** Short reference used in prose and tables, e.g. "Kwon et al., SOSP 2023". */
  short: string;
  title: string;
  kind: CitationKind;
  /** Stable link: arXiv abstract, DOI, proceedings page, or project documentation. */
  url: string;
}

export const CITATIONS = {
  vaswani2017: {
    short: "Vaswani et al., NeurIPS 2017",
    title: "Attention Is All You Need",
    kind: "paper",
    url: "https://arxiv.org/abs/1706.03762"
  },
  kaplan2020: {
    short: "Kaplan et al., 2020",
    title: "Scaling Laws for Neural Language Models",
    kind: "paper",
    url: "https://arxiv.org/abs/2001.08361"
  },
  williams2009: {
    short: "Williams et al., CACM 2009",
    title: "Roofline: An Insightful Visual Performance Model for Multicore Architectures",
    kind: "paper",
    url: "https://doi.org/10.1145/1498765.1498785"
  },
  shoeybi2019: {
    short: "Shoeybi et al., 2019",
    title: "Megatron-LM: Training Multi-Billion Parameter Language Models Using Model Parallelism",
    kind: "paper",
    url: "https://arxiv.org/abs/1909.08053"
  },
  crankshaw2017: {
    short: "Crankshaw et al., NSDI 2017",
    title: "Clipper: A Low-Latency Online Prediction Serving System",
    kind: "paper",
    url: "https://arxiv.org/abs/1612.03079"
  },
  tritonBatcher: {
    short: "NVIDIA Triton docs",
    title: "Triton Inference Server: Batchers",
    kind: "docs",
    url: "https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/batcher.html"
  },
  yu2022: {
    short: "Yu et al., OSDI 2022",
    title: "Orca: A Distributed Serving System for Transformer-Based Generative Models",
    kind: "paper",
    url: "https://www.usenix.org/conference/osdi22/presentation/yu"
  },
  kwon2023: {
    short: "Kwon et al., SOSP 2023",
    title: "Efficient Memory Management for Large Language Model Serving with PagedAttention",
    kind: "paper",
    url: "https://arxiv.org/abs/2309.06180"
  },
  agrawal2023: {
    short: "Agrawal et al., 2023",
    title: "SARATHI: Efficient LLM Inference by Piggybacking Decodes with Chunked Prefills",
    kind: "paper",
    url: "https://arxiv.org/abs/2308.16369"
  },
  agrawal2024: {
    short: "Agrawal et al., OSDI 2024",
    title: "Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve",
    kind: "paper",
    url: "https://arxiv.org/abs/2403.02310"
  },
  zheng2023: {
    short: "Zheng et al., 2023",
    title: "SGLang: Efficient Execution of Structured Language Model Programs",
    kind: "paper",
    url: "https://arxiv.org/abs/2312.07104"
  },
  leviathan2023: {
    short: "Leviathan et al., ICML 2023",
    title: "Fast Inference from Transformers via Speculative Decoding",
    kind: "paper",
    url: "https://arxiv.org/abs/2211.17192"
  },
  gao2024: {
    short: "Gao et al., USENIX ATC 2024",
    title: "Cost-Efficient Large Language Model Serving for Multi-turn Conversations with CachedAttention",
    kind: "paper",
    url: "https://arxiv.org/abs/2403.19708"
  },
  qin2024: {
    short: "Qin et al., FAST 2025",
    title: "Mooncake: A KVCache-centric Disaggregated Architecture for LLM Serving",
    kind: "paper",
    url: "https://arxiv.org/abs/2407.00079"
  },
  lmcache2025: {
    short: "Liu et al., 2025 (LMCache)",
    title: "LMCache: An Efficient KV Cache Layer for Enterprise-Scale LLM Inference",
    kind: "paper",
    url: "https://arxiv.org/abs/2510.09665"
  },
  liu2023: {
    short: "Liu et al., SIGCOMM 2024",
    title: "CacheGen: KV Cache Compression and Streaming for Fast Large Language Model Serving",
    kind: "paper",
    url: "https://arxiv.org/abs/2310.07240"
  },
  yu2023: {
    short: "Yu et al., 2023",
    title: "Stateful Large Language Model Serving with Pensieve",
    kind: "paper",
    url: "https://arxiv.org/abs/2312.05516"
  },
  zhong2024: {
    short: "Zhong et al., OSDI 2024",
    title: "DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving",
    kind: "paper",
    url: "https://arxiv.org/abs/2401.09670"
  },
  patel2023: {
    short: "Patel et al., ISCA 2024",
    title: "Splitwise: Efficient Generative LLM Inference Using Phase Splitting",
    kind: "paper",
    url: "https://arxiv.org/abs/2311.18677"
  },
  sun2024: {
    short: "Sun et al., OSDI 2024",
    title: "Llumnix: Dynamic Scheduling for Large Language Model Serving",
    kind: "paper",
    url: "https://arxiv.org/abs/2406.03243"
  },
  schroeder2006: {
    short: "Schroeder et al., NSDI 2006",
    title: "Open Versus Closed: A Cautionary Tale",
    kind: "paper",
    url: "https://www.usenix.org/conference/nsdi-06/presentation/open-versus-closed-cautionary-tale"
  },
  vllmScheduler: {
    short: "vLLM source, scheduler.py",
    title: "vLLM V1 scheduler (decode-first scheduling, preemption, no admission in a preempting step)",
    kind: "source",
    url: "https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py"
  },
  vllmSchedulerConfig: {
    short: "vLLM source, config/scheduler.py",
    title: "vLLM SchedulerConfig (max_num_seqs, max_num_batched_tokens)",
    kind: "source",
    url: "https://github.com/vllm-project/vllm/blob/main/vllm/config/scheduler.py"
  },
  vllmPrefixCaching: {
    short: "vLLM docs, prefix caching",
    title: "vLLM design: Automatic Prefix Caching",
    kind: "docs",
    url: "https://docs.vllm.ai/en/latest/design/prefix_caching.html"
  },
  vllmOptimization: {
    short: "vLLM docs, optimization",
    title: "vLLM: Optimization and Tuning (preemption, chunked prefill)",
    kind: "docs",
    url: "https://docs.vllm.ai/en/latest/configuration/optimization.html"
  },
  vllmEngineArgs: {
    short: "vLLM docs, engine arguments",
    title: "vLLM: Engine Arguments (gpu_memory_utilization, block_size)",
    kind: "docs",
    url: "https://docs.vllm.ai/en/latest/configuration/engine_args.html"
  },
  vllmMemoryProfiling: {
    short: "vLLM source, worker memory profiling",
    title: "vLLM worker: request_memory (ceil(total_memory x gpu_memory_utilization)) and determine_available_memory (KV memory = requested - non-KV memory - CUDA-graph estimate)",
    kind: "source",
    url: "https://github.com/vllm-project/vllm/blob/main/vllm/v1/worker/gpu_worker.py"
  },
  vllmUsageStats: {
    short: "vLLM pull request 26836",
    title: "vLLM usage stats of an H100 80GB HBM3: gpu_memory_per_device 85029158912 bytes (79.19 GiB)",
    kind: "source",
    url: "https://github.com/vllm-project/vllm/pull/26836"
  },
  blisSubstrateCatalog: {
    short: "BLIS substrate catalogue, hardware",
    title: "blis-substrate catalog/hardware/*.yaml: MemoryGiB measured as the device total the CUDA driver reports",
    kind: "source",
    url: "https://github.com/inference-sim/blis-substrate/tree/main/catalog/hardware"
  },
  blisSubstrateMemory: {
    short: "BLIS substrate registry, cost-model-memory",
    title: "blis-substrate registry cost-model-memory: CUDA-graph capture memory, median of 22 vLLM start-up logs (1.08 GiB)",
    kind: "source",
    url: "https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-memory.yaml"
  },
  tensorrtLlm: {
    short: "TensorRT-LLM docs",
    title: "TensorRT-LLM: scheduler policies (GuaranteedNoEvict)",
    kind: "docs",
    url: "https://nvidia.github.io/TensorRT-LLM/"
  },
  llmdScheduling: {
    short: "llm-d docs, router scheduling",
    title: "llm-d architecture: router scheduling (filters, weighted scorers, picker)",
    kind: "docs",
    url: "https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/scheduling.md"
  },
  llmdFlowControl: {
    short: "llm-d docs, flow control",
    title: "llm-d architecture: flow control (queueing, request TTL, eviction)",
    kind: "docs",
    url: "https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/flow-control.md"
  },
  llmdDisaggregation: {
    short: "llm-d docs, P/D disaggregation",
    title: "llm-d architecture: prefill/decode disaggregation (decode-first decider)",
    kind: "docs",
    url: "https://github.com/llm-d/llm-d/blob/main/docs/architecture/disaggregation/pd-disaggregation.md"
  },
  llmdAutoscaling: {
    short: "llm-d docs, autoscaling",
    title: "llm-d architecture: autoscaling with KEDA on endpoint-picker metrics",
    kind: "docs",
    url: "https://github.com/llm-d/llm-d/blob/main/docs/architecture/autoscaling/keda-epp.md"
  },
  llmdKvOffloader: {
    short: "llm-d docs, KV offloader",
    title: "llm-d architecture: KV offloading to CPU memory and storage",
    kind: "docs",
    url: "https://github.com/llm-d/llm-d/blob/main/docs/architecture/kv-management/kv-offloader.md"
  },
  gatewayInferenceExtension: {
    short: "Gateway API Inference Extension",
    title: "Kubernetes Gateway API Inference Extension (endpoint picker)",
    kind: "source",
    url: "https://github.com/kubernetes-sigs/gateway-api-inference-extension"
  },
  envoyLoadBalancing: {
    short: "Envoy docs, load balancers",
    title: "Envoy: supported load balancers (round robin, least request)",
    kind: "docs",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers"
  },
  knativeAutoscaling: {
    short: "Knative docs, autoscaling",
    title: "Knative Serving: autoscaling concepts (target concurrency)",
    kind: "docs",
    url: "https://knative.dev/docs/serving/autoscaling/autoscaling-concepts/"
  },
  dynamoKvbm: {
    short: "NVIDIA Dynamo docs",
    title: "NVIDIA Dynamo: KV block manager and tiered KV storage",
    kind: "docs",
    url: "https://docs.nvidia.com/dynamo/latest/"
  },
  keda: {
    short: "KEDA docs",
    title: "KEDA: Kubernetes event-driven autoscaling",
    kind: "docs",
    url: "https://keda.sh/"
  },
  openaiRateLimits: {
    short: "OpenAI docs, rate limits",
    title: "OpenAI API: rate limits (requests per minute and tokens per minute)",
    kind: "docs",
    url: "https://platform.openai.com/docs/guides/rate-limits"
  },
  sreHandlingOverload: {
    short: "Google SRE book, Handling Overload",
    title: "Site Reliability Engineering, chapter 21: Handling Overload (load shedding, graceful degradation)",
    kind: "docs",
    url: "https://sre.google/sre-book/handling-overload/"
  },
  awsLoadShedding: {
    short: "AWS Builders' Library, load shedding",
    title: "Using load shedding to avoid overload (Amazon Builders' Library)",
    kind: "docs",
    url: "https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/"
  },
  openaiChatCompletions: {
    short: "OpenAI API reference, chat completions",
    title: "OpenAI API reference: create chat completion (the request and response format other engines copy)",
    kind: "docs",
    url: "https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create"
  },
  andes2024: {
    short: "Liu et al., 2024 (Andes)",
    title: "Andes: Defining and Enhancing Quality-of-Experience in LLM-Based Text Streaming Services",
    kind: "paper",
    url: "https://arxiv.org/abs/2404.16283"
  },
  etalon2024: {
    short: "Agrawal et al., 2024 (Etalon)",
    title: "Etalon: Holistic Performance Evaluation Framework for LLM Inference Systems",
    kind: "paper",
    url: "https://arxiv.org/abs/2407.07000"
  },
  little1961: {
    short: "Little, 1961",
    title: "A Proof for the Queuing Formula: L = λW",
    kind: "paper",
    url: "https://doi.org/10.1287/opre.9.3.383"
  },
  shazeer2019: {
    short: "Shazeer, 2019",
    title: "Fast Transformer Decoding: One Write-Head is All You Need (multi-query attention)",
    kind: "paper",
    url: "https://arxiv.org/abs/1911.02150"
  },
  ainslie2023: {
    short: "Ainslie et al., EMNLP 2023",
    title: "GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints",
    kind: "paper",
    url: "https://arxiv.org/abs/2305.13245"
  },
  pope2022: {
    short: "Pope et al., 2022",
    title: "Efficiently Scaling Transformer Inference",
    kind: "paper",
    url: "https://arxiv.org/abs/2211.05102"
  },
  chen2023: {
    short: "Chen et al., 2023",
    title: "Accelerating Large Language Model Decoding with Speculative Sampling",
    kind: "paper",
    url: "https://arxiv.org/abs/2302.01318"
  },
  dean2013: {
    short: "Dean and Barroso, CACM 2013",
    title: "The Tail at Scale",
    kind: "paper",
    url: "https://doi.org/10.1145/2408776.2408794"
  },
  sennrich2016: {
    short: "Sennrich et al., ACL 2016",
    title: "Neural Machine Translation of Rare Words with Subword Units (byte-pair encoding)",
    kind: "paper",
    url: "https://arxiv.org/abs/1508.07909"
  },
  kudo2018: {
    short: "Kudo and Richardson, 2018",
    title: "SentencePiece: A simple and language independent subword tokenizer and detokenizer",
    kind: "paper",
    url: "https://arxiv.org/abs/1808.06226"
  },
  hfChatTemplates: {
    short: "Hugging Face docs, chat templates",
    title: "Hugging Face Transformers: chat templates (message list to the model's token format)",
    kind: "docs",
    url: "https://huggingface.co/docs/transformers/chat_templating"
  },
  fielding2000: {
    short: "Fielding, 2000, REST",
    title: "Architectural Styles and the Design of Network-based Software Architectures, chapter 5: Representational State Transfer (the stateless constraint)",
    kind: "docs",
    url: "https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm"
  },
  fowlerEventSourcing: {
    short: "Fowler, Event Sourcing",
    title: "Martin Fowler: Event Sourcing (an append-only log as the record, state derived from it)",
    kind: "docs",
    url: "https://martinfowler.com/eaaDev/EventSourcing.html"
  },
  grpcDeadlines: {
    short: "gRPC docs, deadlines",
    title: "gRPC: deadlines (a deadline is set by the caller and propagated down the call chain)",
    kind: "docs",
    url: "https://grpc.io/docs/guides/deadlines/"
  },
  fu2024: {
    short: "Fu et al., OSDI 2024 (ServerlessLLM)",
    title: "ServerlessLLM: Low-Latency Serverless Inference for Large Language Models",
    kind: "paper",
    url: "https://arxiv.org/abs/2401.14351"
  },
  sseSpec: {
    short: "WHATWG, server-sent events",
    title: "HTML Living Standard: server-sent events (the stream format chat-completions APIs use)",
    kind: "docs",
    url: "https://html.spec.whatwg.org/multipage/server-sent-events.html"
  },
  reddi2019: {
    short: "Reddi et al., ISCA 2020 (MLPerf Inference)",
    title: "MLPerf Inference Benchmark",
    kind: "paper",
    url: "https://arxiv.org/abs/1911.02549"
  },
  srivatsa2024: {
    short: "Srivatsa et al., 2024 (Preble)",
    title: "Preble: Efficient Distributed Prompt Scheduling for LLM Serving",
    kind: "paper",
    url: "https://arxiv.org/abs/2407.00023"
  },
  envoyAiGatewayRateLimit: {
    short: "Envoy AI Gateway docs, usage-based rate limiting",
    title: "Envoy AI Gateway: usage-based rate limiting (limits counted in tokens)",
    kind: "docs",
    url: "https://aigateway.envoyproxy.io/docs/capabilities/traffic/usage-based-ratelimiting"
  },
  llmdKvCacheIndexer: {
    short: "llm-d KV-cache indexer",
    title: "llm-d KV-cache: indexer that maps a prompt's KV-block keys to the pods holding them",
    kind: "source",
    url: "https://github.com/llm-d/llm-d-kv-cache"
  },
  vllmOpenAiServer: {
    short: "vLLM docs, chat-completions server",
    title: "vLLM: OpenAI-compatible server (chat completions, chat template, streaming)",
    kind: "docs",
    url: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html"
  },
  vllmRepo: {
    short: "vLLM repository",
    title: "vLLM: high-throughput and memory-efficient inference and serving engine",
    kind: "source",
    url: "https://github.com/vllm-project/vllm"
  },
  sglangRepo: {
    short: "SGLang repository",
    title: "SGLang: a fast serving framework for large language models",
    kind: "source",
    url: "https://github.com/sgl-project/sglang"
  },
  tgiRepo: {
    short: "TGI repository",
    title: "Text Generation Inference (Hugging Face)",
    kind: "source",
    url: "https://github.com/huggingface/text-generation-inference"
  },
  tfServing: {
    short: "TF Serving repository",
    title: "TensorFlow Serving",
    kind: "source",
    url: "https://github.com/tensorflow/serving"
  },
  dynamoRepo: {
    short: "NVIDIA Dynamo repository",
    title: "NVIDIA Dynamo: datacenter-scale distributed inference serving framework",
    kind: "source",
    url: "https://github.com/ai-dynamo/dynamo"
  },
  llama31Card: {
    short: "Meta, Llama 3.1 8B model card",
    title: "meta-llama/Llama-3.1-8B-Instruct (architecture in config.json)",
    kind: "datasheet",
    url: "https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct"
  },
  llama3170Card: {
    short: "Meta, Llama 3.1 70B model card",
    title: "meta-llama/Llama-3.1-70B-Instruct (architecture in config.json)",
    kind: "datasheet",
    url: "https://huggingface.co/meta-llama/Llama-3.1-70B-Instruct"
  },
  nvidiaH100: {
    short: "NVIDIA H100 datasheet",
    title: "NVIDIA H100 Tensor Core GPU",
    kind: "datasheet",
    url: "https://www.nvidia.com/en-us/data-center/h100/"
  },
  nvidiaH200: {
    short: "NVIDIA H200 datasheet",
    title: "NVIDIA H200 Tensor Core GPU",
    kind: "datasheet",
    url: "https://www.nvidia.com/en-us/data-center/h200/"
  },
  nvidiaB200: {
    short: "NVIDIA DGX B200 datasheet",
    title: "NVIDIA DGX B200 (Blackwell B200)",
    kind: "datasheet",
    url: "https://www.nvidia.com/en-us/data-center/dgx-b200/"
  },
  amdMi300x: {
    short: "AMD Instinct MI300X datasheet",
    title: "AMD Instinct MI300X Accelerator",
    kind: "datasheet",
    url: "https://www.amd.com/en/products/accelerators/instinct/mi300/mi300x.html"
  }
} as const satisfies Record<string, Citation>;

export type CitationKey = keyof typeof CITATIONS;

/** Markdown link for one source: `[Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180)`. */
export function citeMarkdown(key: CitationKey): string {
  const c = CITATIONS[key];
  return `[${c.short}](${c.url})`;
}
