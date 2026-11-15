# Simulation

The model behind LLM Serving Explorer. It is plain TypeScript with no dependency on the user interface, so it can be run and tested on its own.

It is organised by **concept**: a decision a serving stack has to make. Each concept lives in its own directory, defines the interface an **approach** must implement, and keeps a registry of the approaches it supports. Each approach is one published or deployed way of making that decision, and names its sources.

## Layout

| Directory | Concept |
|---|---|
| [`hardware/`](hardware/) | Model and GPU facts |
| [`cost/`](cost/) | FLOPs, memory budget, roofline step time |
| [`batching/`](batching/) | When a request may join a running batch |
| [`admission/`](admission/) | How much KV to secure before a request starts |
| [`kvcache/`](kvcache/) | Block layout, prefix reuse, eviction, tiers, reload, preemption |
| [`decoding/`](decoding/) | Tokens gained per step |
| [`routing/`](routing/) | Which pod gets a request |
| [`disaggregation/`](disaggregation/) | Separate prefill and decode pools |
| [`autoscaling/`](autoscaling/) | How many pods to run |
| [`flowcontrol/`](flowcontrol/) | What to do with requests that cannot be served in time |
| [`workload/`](workload/) | Sessions, lengths, think time, front-end hops |
| [`engine/`](engine/) | The loop that ties the above together |
| [`core/`](core/) | Parameters, state types, the seeded random source and the event log |
| [`presets/`](presets/) | Serving architectures expressed as parameter sets |

Other files: [`citations.ts`](citations.ts) is the registry of sources, [`approach.ts`](approach.ts) the contract every approach meets, [`catalog.ts`](catalog.ts) the list of all concepts, [`index.ts`](index.ts) the public interface the user interface imports from.

Dependencies point one way: `engine` uses the concept modules, which use `cost`, `hardware` and `core`. No concept module imports from `engine`, and nothing in here imports from the user interface.

## Rules

1. **No approach without a source.** Every approach lists at least one entry of [`citations.ts`](citations.ts): a paper (arXiv, DOI or proceedings link), project documentation, or source code. A test enforces it.
2. **One approach, one file.** Different ways of making the same decision are never mixed in one function. The engine asks the concept's registry for the selected approach and calls its interface.
3. **The docstring carries the grounding.** It names the source, states the rule or formula in the source's notation, works one example with numbers, and says what is simplified or not modelled.
4. **Tests check the implementation against the source.** At least: the docstring's worked example, the edge cases the source names, and one test of the behaviour inside the engine.
5. **No unnamed numbers.** A constant is either taken from a source (and says which), or is illustrative (and says so), and has a name and a comment. A value that is a guess within a plausible range is a parameter with a control in the interface.
6. **State how faithful it is.** Each approach declares its fidelity: exact, structural or simplified.
7. **Determinism.** All randomness comes from the world's seeded generator. A deterministic approach must not consume random numbers.
8. **Regenerate the tables.** `pnpm docs:sync` rewrites the tables in the READMEs from the registries; a test fails when they are stale.

## Adding a new concept

When a paper introduces a decision that has no home yet (for example KV compression):

1. Create a directory with an `index.ts` that defines the interface, a `Concept` registry and the approach in use.
2. Implement the current behaviour as the first approach, so that existing results do not change. The behaviour fingerprints in `engine/__tests__/behaviour.test.ts` prove it.
3. Implement the new approach in its own file, following the rules above.
4. Add the concept to [`catalog.ts`](catalog.ts), add a `README.md` and `__tests__/`, and call the interface from the engine.

## All approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Sources |
|---|---|---|---|---|
| [Cost model](cost/) | Roofline step time | A step takes the longer of FLOPs over peak compute and bytes over memory bandwidth. | Exact | [Williams et al., CACM 2009](https://doi.org/10.1145/1498765.1498785) |
| [Cost model](cost/) | FLOPs per token | 2N per token through the weights, plus an attention term linear in context length. | Exact | [Kaplan et al., 2020](https://arxiv.org/abs/2001.08361); [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| [Cost model](cost/) | KV bytes per token and memory budget | Two vectors per layer and KV head per token; the KV pool is what weights, activations and headroom leave. | Exact | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM docs, engine arguments](https://docs.vllm.ai/en/latest/configuration/engine_args.html) |
| [Cost model](cost/) | Tensor parallelism | Weights and KV are split evenly over the GPUs of a pod; compute and bandwidth add up. | Simplified | [Shoeybi et al., 2019](https://arxiv.org/abs/1909.08053) |
| [Cost model](cost/) | Host time per step | A fixed plus per-sequence CPU cost that adds to, or overlaps with, GPU time. | Simplified | [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html) |
| [Step scheduling](engine/) | Chunked prefill under a token budget | A long prompt is prefilled in chunks sharing each step with decodes, bounded by a per-step token budget. | Structural | [Agrawal et al., OSDI 2024](https://arxiv.org/abs/2403.02310); [Agrawal et al., 2023](https://arxiv.org/abs/2308.16369); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py); [vLLM source, config/scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/config/scheduler.py) |
| [Batching](batching/) | Static batching | A batch runs to completion before the next one is formed. | Structural | [Crankshaw et al., NSDI 2017](https://arxiv.org/abs/1612.03079); [NVIDIA Triton docs](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/batcher.html); [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu) |
| [Batching](batching/) | Continuous batching | Requests join and leave the batch at every engine step. | Structural | [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py) |
| [KV admission](admission/) | On-demand (paged) | Allocate blocks for the tokens scheduled this step; grow as the sequence grows. | Structural | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py) |
| [KV admission](admission/) | Whole prompt | Allocate blocks for the full prompt at admission; outputs grow on demand. | Structural | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [KV admission](admission/) | Reserve to completion | Reserve prompt plus max_tokens up front; admitted requests are never preempted. | Structural | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [TensorRT-LLM docs](https://nvidia.github.io/TensorRT-LLM/); [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu) |
| [KV cache layout](kvcache/) | Paged KV blocks (PagedAttention) | KV memory is handed out in fixed 16-token blocks as tokens are written, like virtual-memory pages. | Structural | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Prefix reuse](kvcache/) | Block-hash prefix cache | Reuse whole KV blocks whose entire token prefix matches; always compute the last token. | Exact | [vLLM docs, prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html); [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Eviction order](kvcache/) | LRU, whole session | Evict the idle session that was used longest ago. | Simplified | [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708); [vLLM docs, prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html) |
| [KV tiers](kvcache/) | HBM → DRAM → SSD → shared pool | Idle sessions move down a memory hierarchy instead of being dropped, and are loaded back on return. | Structural | [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708); [Qin et al., FAST 2025](https://arxiv.org/abs/2407.00079); [Liu et al., 2025 (LMCache)](https://arxiv.org/abs/2510.09665); [llm-d docs, KV offloader](https://github.com/llm-d/llm-d/blob/main/docs/architecture/kv-management/kv-offloader.md); [NVIDIA Dynamo docs](https://docs.nvidia.com/dynamo/latest/) |
| [Reload decision](kvcache/) | Adaptive load-or-recompute | Load KV from a lower tier only when copying is faster than prefilling again. | Simplified | [Liu et al., 2025 (LMCache)](https://arxiv.org/abs/2510.09665); [Liu et al., SIGCOMM 2024](https://arxiv.org/abs/2310.07240) |
| [Preemption](kvcache/) | Preempt newest, recompute | Free the most recently admitted sequence and prefill it again later. | Exact | [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py); [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html); [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Decoding](decoding/) | Autoregressive | One token per sequence per step. | Exact | [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| [Decoding](decoding/) | Speculative decoding | A draft model proposes several tokens; the target verifies them in one pass. | Exact | [Leviathan et al., ICML 2023](https://arxiv.org/abs/2211.17192) |
| [Routing](routing/) | Round robin | Rotate through pods regardless of load or cache. | Exact | [Envoy docs, load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) |
| [Routing](routing/) | Least loaded | Send to the pod with the fewest requests in flight. | Simplified | [Envoy docs, load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) |
| [Routing](routing/) | Prefix-cache aware | Weighted score of cached prefix, KV utilisation and queue depth, as in llm-d. | Structural | [llm-d docs, router scheduling](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/scheduling.md); [Gateway API Inference Extension](https://github.com/kubernetes-sigs/gateway-api-inference-extension) |
| [Prefill/decode disaggregation](disaggregation/) | Decode-first with token threshold | Pick the decode pod first; use the prefill pool only when enough of the prompt is uncached there. | Structural | [llm-d docs, P/D disaggregation](https://github.com/llm-d/llm-d/blob/main/docs/architecture/disaggregation/pd-disaggregation.md); [Zhong et al., OSDI 2024](https://arxiv.org/abs/2401.09670); [Patel et al., ISCA 2024](https://arxiv.org/abs/2311.18677) |
| [Autoscaling](autoscaling/) | Target concurrency | Run enough pods that each carries at most its target number of requests. | Simplified | [Knative docs, autoscaling](https://knative.dev/docs/serving/autoscaling/autoscaling-concepts/); [llm-d docs, autoscaling](https://github.com/llm-d/llm-d/blob/main/docs/architecture/autoscaling/keda-epp.md) |
| [Flow control](flowcontrol/) | Deadline shedding | Reject requests that have waited at the router longer than a time-to-live. | Simplified | [llm-d docs, flow control](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/flow-control.md) |
| [Workload](workload/) | Closed-loop multi-turn sessions | Users wait for an answer, think, then re-send the whole conversation plus a new message. | Simplified | [Schroeder et al., NSDI 2006](https://www.usenix.org/conference/nsdi-06/presentation/open-versus-closed-cautionary-tale); [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708) |
| [Workload](workload/) | Trace replay | Requests are injected at recorded times with recorded lengths, so a run can be repeated or compared exactly. | Simplified | [Schroeder et al., NSDI 2006](https://www.usenix.org/conference/nsdi-06/presentation/open-versus-closed-cautionary-tale); [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708) |
<!-- generated:approaches:end -->

## Sources

<!-- generated:citations:start -->
- **Vaswani et al., NeurIPS 2017.** [Attention Is All You Need](https://arxiv.org/abs/1706.03762). Used by: FLOPs per token, Autoregressive.
- **Kaplan et al., 2020.** [Scaling Laws for Neural Language Models](https://arxiv.org/abs/2001.08361). Used by: FLOPs per token.
- **Williams et al., CACM 2009.** [Roofline: An Insightful Visual Performance Model for Multicore Architectures](https://doi.org/10.1145/1498765.1498785). Used by: Roofline step time.
- **Shoeybi et al., 2019.** [Megatron-LM: Training Multi-Billion Parameter Language Models Using Model Parallelism](https://arxiv.org/abs/1909.08053). Used by: Tensor parallelism.
- **Crankshaw et al., NSDI 2017.** [Clipper: A Low-Latency Online Prediction Serving System](https://arxiv.org/abs/1612.03079). Used by: Static batching.
- **NVIDIA Triton docs.** [Triton Inference Server: Batchers](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/batcher.html). Used by: Static batching.
- **Yu et al., OSDI 2022.** [Orca: A Distributed Serving System for Transformer-Based Generative Models](https://www.usenix.org/conference/osdi22/presentation/yu). Used by: Static batching, Continuous batching, Reserve to completion.
- **Kwon et al., SOSP 2023.** [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180). Used by: KV bytes per token and memory budget, On-demand (paged), Whole prompt, Reserve to completion, Paged KV blocks (PagedAttention), Block-hash prefix cache, Preempt newest, recompute.
- **Agrawal et al., 2023.** [SARATHI: Efficient LLM Inference by Piggybacking Decodes with Chunked Prefills](https://arxiv.org/abs/2308.16369). Used by: Chunked prefill under a token budget.
- **Agrawal et al., OSDI 2024.** [Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve](https://arxiv.org/abs/2403.02310). Used by: Chunked prefill under a token budget.
- **Zheng et al., 2023.** [SGLang: Efficient Execution of Structured Language Model Programs](https://arxiv.org/abs/2312.07104).
- **Leviathan et al., ICML 2023.** [Fast Inference from Transformers via Speculative Decoding](https://arxiv.org/abs/2211.17192). Used by: Speculative decoding.
- **Gao et al., USENIX ATC 2024.** [Cost-Efficient Large Language Model Serving for Multi-turn Conversations with CachedAttention](https://arxiv.org/abs/2403.19708). Used by: LRU, whole session, HBM → DRAM → SSD → shared pool, Closed-loop multi-turn sessions, Trace replay.
- **Qin et al., FAST 2025.** [Mooncake: A KVCache-centric Disaggregated Architecture for LLM Serving](https://arxiv.org/abs/2407.00079). Used by: HBM → DRAM → SSD → shared pool.
- **Liu et al., 2025 (LMCache).** [LMCache: An Efficient KV Cache Layer for Enterprise-Scale LLM Inference](https://arxiv.org/abs/2510.09665). Used by: HBM → DRAM → SSD → shared pool, Adaptive load-or-recompute.
- **Liu et al., SIGCOMM 2024.** [CacheGen: KV Cache Compression and Streaming for Fast Large Language Model Serving](https://arxiv.org/abs/2310.07240). Used by: Adaptive load-or-recompute.
- **Yu et al., 2023.** [Stateful Large Language Model Serving with Pensieve](https://arxiv.org/abs/2312.05516).
- **Zhong et al., OSDI 2024.** [DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving](https://arxiv.org/abs/2401.09670). Used by: Decode-first with token threshold.
- **Patel et al., ISCA 2024.** [Splitwise: Efficient Generative LLM Inference Using Phase Splitting](https://arxiv.org/abs/2311.18677). Used by: Decode-first with token threshold.
- **Sun et al., OSDI 2024.** [Llumnix: Dynamic Scheduling for Large Language Model Serving](https://arxiv.org/abs/2406.03243).
- **Schroeder et al., NSDI 2006.** [Open Versus Closed: A Cautionary Tale](https://www.usenix.org/conference/nsdi-06/presentation/open-versus-closed-cautionary-tale). Used by: Closed-loop multi-turn sessions, Trace replay.
- **vLLM source, scheduler.py.** [vLLM V1 scheduler (decode-first scheduling, preemption, no admission in a preempting step)](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py). Used by: Chunked prefill under a token budget, Continuous batching, On-demand (paged), Preempt newest, recompute.
- **vLLM source, config/scheduler.py.** [vLLM SchedulerConfig (max_num_seqs, max_num_batched_tokens)](https://github.com/vllm-project/vllm/blob/main/vllm/config/scheduler.py). Used by: Chunked prefill under a token budget.
- **vLLM docs, prefix caching.** [vLLM design: Automatic Prefix Caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html). Used by: Block-hash prefix cache, LRU, whole session.
- **vLLM docs, optimization.** [vLLM: Optimization and Tuning (preemption, chunked prefill)](https://docs.vllm.ai/en/latest/configuration/optimization.html). Used by: Host time per step, Preempt newest, recompute.
- **vLLM docs, engine arguments.** [vLLM: Engine Arguments (gpu_memory_utilization, block_size)](https://docs.vllm.ai/en/latest/configuration/engine_args.html). Used by: KV bytes per token and memory budget.
- **TensorRT-LLM docs.** [TensorRT-LLM: scheduler policies (GuaranteedNoEvict)](https://nvidia.github.io/TensorRT-LLM/). Used by: Reserve to completion.
- **llm-d docs, router scheduling.** [llm-d architecture: router scheduling (filters, weighted scorers, picker)](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/scheduling.md). Used by: Prefix-cache aware.
- **llm-d docs, flow control.** [llm-d architecture: flow control (queueing, request TTL, eviction)](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/flow-control.md). Used by: Deadline shedding.
- **llm-d docs, P/D disaggregation.** [llm-d architecture: prefill/decode disaggregation (decode-first decider)](https://github.com/llm-d/llm-d/blob/main/docs/architecture/disaggregation/pd-disaggregation.md). Used by: Decode-first with token threshold.
- **llm-d docs, autoscaling.** [llm-d architecture: autoscaling with KEDA on endpoint-picker metrics](https://github.com/llm-d/llm-d/blob/main/docs/architecture/autoscaling/keda-epp.md). Used by: Target concurrency.
- **llm-d docs, KV offloader.** [llm-d architecture: KV offloading to CPU memory and storage](https://github.com/llm-d/llm-d/blob/main/docs/architecture/kv-management/kv-offloader.md). Used by: HBM → DRAM → SSD → shared pool.
- **Gateway API Inference Extension.** [Kubernetes Gateway API Inference Extension (endpoint picker)](https://github.com/kubernetes-sigs/gateway-api-inference-extension). Used by: Prefix-cache aware.
- **Envoy docs, load balancers.** [Envoy: supported load balancers (round robin, least request)](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers). Used by: Round robin, Least loaded.
- **Knative docs, autoscaling.** [Knative Serving: autoscaling concepts (target concurrency)](https://knative.dev/docs/serving/autoscaling/autoscaling-concepts/). Used by: Target concurrency.
- **NVIDIA Dynamo docs.** [NVIDIA Dynamo: KV block manager and tiered KV storage](https://docs.nvidia.com/dynamo/latest/). Used by: HBM → DRAM → SSD → shared pool.
- **KEDA docs.** [KEDA: Kubernetes event-driven autoscaling](https://keda.sh/).
- **OpenAI docs, rate limits.** [OpenAI API: rate limits (requests per minute and tokens per minute)](https://platform.openai.com/docs/guides/rate-limits).
- **Envoy AI Gateway docs, usage-based rate limiting.** [Envoy AI Gateway: usage-based rate limiting (limits counted in tokens)](https://aigateway.envoyproxy.io/docs/capabilities/traffic/usage-based-ratelimiting).
- **llm-d KV-cache indexer.** [llm-d KV-cache: indexer that maps a prompt's KV-block keys to the pods holding them](https://github.com/llm-d/llm-d-kv-cache).
- **vLLM docs, OpenAI-compatible server.** [vLLM: OpenAI-compatible server (chat completions, chat template, streaming)](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html).
- **vLLM repository.** [vLLM: high-throughput and memory-efficient inference and serving engine](https://github.com/vllm-project/vllm).
- **SGLang repository.** [SGLang: a fast serving framework for large language models](https://github.com/sgl-project/sglang).
- **TGI repository.** [Text Generation Inference (Hugging Face)](https://github.com/huggingface/text-generation-inference).
- **TF Serving repository.** [TensorFlow Serving](https://github.com/tensorflow/serving).
- **NVIDIA Dynamo repository.** [NVIDIA Dynamo: datacenter-scale distributed inference serving framework](https://github.com/ai-dynamo/dynamo).
- **Meta, Llama 3.1 8B model card.** [meta-llama/Llama-3.1-8B-Instruct (architecture in config.json)](https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct).
- **Meta, Llama 3 70B model card.** [meta-llama/Meta-Llama-3-70B-Instruct (architecture in config.json)](https://huggingface.co/meta-llama/Meta-Llama-3-70B-Instruct).
- **NVIDIA H100 datasheet.** [NVIDIA H100 Tensor Core GPU](https://www.nvidia.com/en-us/data-center/h100/).
- **NVIDIA H200 datasheet.** [NVIDIA H200 Tensor Core GPU](https://www.nvidia.com/en-us/data-center/h200/).
- **NVIDIA DGX B200 datasheet.** [NVIDIA DGX B200 (Blackwell B200)](https://www.nvidia.com/en-us/data-center/dgx-b200/).
- **AMD Instinct MI300X datasheet.** [AMD Instinct MI300X Accelerator](https://www.amd.com/en/products/accelerators/instinct/mi300/mi300x.html).
<!-- generated:citations:end -->
