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
| Concept | Approach | What it does | Fidelity | Verified against | Sources |
|---|---|---|---|---|---|
| [Cost model](cost/) | Roofline step time | A step takes the longer of FLOPs over achieved compute and bytes over achieved memory bandwidth (MBU 0.85, MFU 0.7 by default), plus communication and launch time. | Exact | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Williams et al., CACM 2009](https://doi.org/10.1145/1498765.1498785); [NVIDIA RTX Blackwell GPU architecture whitepaper](https://www.nvidia.com/content/dam/en-zz/Solutions/design-visualization/quadro-product-literature/pdf/NVIDIA-RTX-Blackwell-PRO-GPU-Architecture-v1_1.pdf); [LLMServingSim, measured vLLM runs](https://github.com/casys-kaist/LLMServingSim/tree/49df63f2af61230da63dd2136044a2dbf9bd4161/bench/examples) |
| [Cost model](cost/) | FLOPs per token | 2N per token through the weights, plus an attention term linear in context length. | Exact | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kaplan et al., 2020](https://arxiv.org/abs/2001.08361); [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| [Cost model](cost/) | KV bytes per token and memory budget | Two vectors per layer and KV head per token; the KV pool is what weights, the start-up profiling pass (sized by max_num_batched_tokens and max_num_seqs), CUDA graphs and headroom leave of the memory the driver reports. | Exact | BLIS: `kv-budget-8b-h100`, `kv-budget-70b-h200-tp4`; LLMServingSim: `lss-kv-budget-8b-rtx-pro-6000`, `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090`; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM docs, engine arguments](https://docs.vllm.ai/en/latest/configuration/engine_args.html); [vLLM source, worker memory profiling](https://github.com/vllm-project/vllm/blob/main/vllm/v1/worker/gpu_worker.py); [vLLM v0.19.0 source, worker memory profiling](https://github.com/vllm-project/vllm/blob/v0.19.0/vllm/v1/worker/gpu_worker.py); [vLLM v0.31.0 source, start-up profiling pass and sampler](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/v1/worker/gpu_model_runner.py#L6409-L6440); [vLLM v0.31.0 source, CUDA graph capture sizes](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/config/vllm.py#L2388-L2420); [BLIS substrate registry, cost-model-memory](https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-memory.yaml) |
| [Cost model](cost/) | Tensor parallelism | Weights and KV are split evenly over the GPUs of a pod; compute and bandwidth add up, and two all-reduces per layer add communication time. | Simplified | BLIS: 17 scenarios | [Shoeybi et al., 2019](https://arxiv.org/abs/1909.08053); [Pope et al., 2022](https://arxiv.org/abs/2211.05102); [NCCL tests, performance notes](https://github.com/NVIDIA/nccl-tests/blob/master/doc/PERFORMANCE.md) |
| [Cost model](cost/) | Kernel launch time per layer | A fixed time per layer to launch a step's kernels, higher for a step too large for a captured CUDA graph. | Simplified | BLIS: 24 scenarios | [vLLM docs, CUDA graphs](https://docs.vllm.ai/en/latest/design/cuda_graphs/); [vLLM v0.31.0 source, CUDA graph capture sizes](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/config/vllm.py#L2388-L2420); [BLIS substrate registry, host overheads](https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-host-overheads.yaml) |
| [Cost model](cost/) | Host time per step | A fixed plus per-sequence CPU cost that adds to, or overlaps with, GPU time. | Simplified | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html) |
| [Step scheduling](engine/) | Chunked prefill under a token budget | A long prompt is prefilled in chunks sharing each step with decodes, bounded by a per-step token budget. | Structural | BLIS: `timing-8b-h100-burst`, `timing-8b-h100-heavy`, `preemption-overflow`; LLMServingSim: `lss-preemption-overflow`, `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090`; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Agrawal et al., OSDI 2024](https://arxiv.org/abs/2403.02310); [Agrawal et al., 2023](https://arxiv.org/abs/2308.16369); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py); [vLLM source, config/scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/config/scheduler.py) |
| [Batching](batching/) | Static batching | A batch runs to completion before the next one is formed. | Structural | Not verifiable | [Crankshaw et al., NSDI 2017](https://arxiv.org/abs/1612.03079); [NVIDIA Triton docs](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/batcher.html); [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu) |
| [Batching](batching/) | Continuous batching | Requests join and leave the batch at every engine step. | Structural | BLIS: 32 scenarios; LLMServingSim: 12 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py) |
| [KV admission](admission/) | On-demand (paged) | Allocate blocks for the tokens scheduled this step; grow as the sequence grows. | Structural | BLIS: `preemption-overflow`, `queue-deadline-shedding`; LLMServingSim: `lss-preemption-overflow` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py) |
| [KV admission](admission/) | Whole prompt | Allocate blocks for the full prompt at admission; outputs grow on demand. | Structural | Not verifiable | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [KV admission](admission/) | Reserve to completion | Reserve prompt plus max_tokens up front; admitted requests are never preempted. | Structural | Not verifiable | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [TensorRT-LLM docs](https://github.com/NVIDIA/TensorRT-LLM/blob/main/cpp/include/tensorrt_llm/executor/types.h); [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu) |
| [KV cache layout](kvcache/) | Paged KV blocks (PagedAttention) | KV memory is handed out in fixed 16-token blocks as tokens are written, like virtual-memory pages. | Structural | BLIS: 4 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090`; LLMServingSim: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Prefix reuse](kvcache/) | Block-hash prefix cache | Reuse whole KV blocks whose entire token prefix matches; always compute the last token. | Exact | BLIS: 4 scenarios; LLMServingSim: `lss-prefix-cache` | [vLLM docs, prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html); [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Eviction order](kvcache/) | LRU, whole session | Evict the idle session that was used longest ago. | Simplified | BLIS: `eviction-pressure`, `tiers-offload` | [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708); [vLLM docs, prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html) |
| [KV tiers](kvcache/) | HBM → DRAM → SSD → shared pool | Idle sessions move down a memory hierarchy instead of being dropped, and are loaded back on return. | Structural | BLIS: `tiers-offload`; LLMServingSim: `lss-tiers-offload` | [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708); [Qin et al., FAST 2025](https://arxiv.org/abs/2407.00079); [Liu et al., 2025 (LMCache)](https://arxiv.org/abs/2510.09665); [llm-d docs, KV offloader](https://github.com/llm-d/llm-d/blob/main/docs/architecture/kv-management/kv-offloader.md); [NVIDIA Dynamo docs](https://github.com/ai-dynamo/dynamo/blob/main/lib/kvbm-engine/docs/architecture.md) |
| [Reload decision](kvcache/) | Adaptive load-or-recompute | Load KV from a lower tier only when copying is faster than prefilling again. | Simplified | Not verifiable | [Liu et al., 2025 (LMCache)](https://arxiv.org/abs/2510.09665); [Liu et al., SIGCOMM 2024](https://arxiv.org/abs/2310.07240) |
| [Preemption](kvcache/) | Preempt newest, recompute | Free the most recently admitted sequence and prefill it again later. | Exact | BLIS: `preemption-overflow`; LLMServingSim: `lss-preemption-overflow` | [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py); [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html); [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Decoding](decoding/) | Autoregressive | One token per sequence per step. | Exact | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| [Decoding](decoding/) | Speculative decoding | A draft model proposes several tokens; the target verifies them in one pass. | Exact | BLIS: `spec-decoding`, `calib-8b-h100-spec`; LLMServingSim: `lss-spec-decoding`, `calib-lss-8b-rtx-pro-6000-spec` | [Leviathan et al., ICML 2023](https://arxiv.org/abs/2211.17192) |
| [Routing](routing/) | Round robin | Rotate through pods regardless of load or cache. | Exact | BLIS: `routing-round-robin`, `routing-prefix-vs-round-robin`; LLMServingSim: `lss-routing-round-robin` | [Envoy docs, load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) |
| [Routing](routing/) | Least loaded | Send to the pod with the fewest requests in flight. | Simplified | BLIS: `routing-least-loaded` | [Envoy docs, load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) |
| [Routing](routing/) | Prefix-cache aware | Weighted score of cached prefix, KV utilisation and queue depth, as in llm-d. | Structural | BLIS: 4 scenarios | [llm-d docs, router scheduling](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/scheduling.md); [Gateway API Inference Extension](https://github.com/kubernetes-sigs/gateway-api-inference-extension) |
| [Prefill/decode disaggregation](disaggregation/) | Decode-first with token threshold | Pick the decode pod first; use the prefill pool only when enough of the prompt is uncached there. | Structural | BLIS: `pd-disaggregation`, `calib-8b-h100-pd`; LLMServingSim: `lss-pd-disaggregation` | [llm-d docs, P/D disaggregation](https://github.com/llm-d/llm-d/blob/main/docs/architecture/disaggregation/pd-disaggregation.md); [Zhong et al., OSDI 2024](https://arxiv.org/abs/2401.09670); [Patel et al., ISCA 2024](https://arxiv.org/abs/2311.18677) |
| [Autoscaling](autoscaling/) | Target concurrency | Run enough pods that each carries at most its target number of requests. | Simplified | BLIS: `autoscale-overload` | [Knative docs, autoscaling](https://knative.dev/docs/serving/autoscaling/concurrency/); [llm-d docs, autoscaling](https://github.com/llm-d/llm-d/blob/main/docs/architecture/autoscaling/keda-epp.md) |
| [Flow control](flowcontrol/) | Deadline shedding | Reject requests that have waited at the router longer than a time-to-live. | Simplified | BLIS: `queue-deadline-shedding` | [llm-d docs, flow control](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/flow-control.md) |
| [Workload](workload/) | Closed-loop multi-turn sessions | Users wait for an answer, think, then re-send the whole conversation plus a new message. | Simplified | Not verifiable | [Schroeder et al., NSDI 2006](https://www.usenix.org/conference/nsdi-06/presentation/open-versus-closed-cautionary-tale); [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708) |
| [Workload](workload/) | Trace replay | Requests are injected at recorded times with recorded lengths, so a run can be repeated or compared exactly. | Simplified | Not verifiable | [Schroeder et al., NSDI 2006](https://www.usenix.org/conference/nsdi-06/presentation/open-versus-closed-cautionary-tale); [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708) |
<!-- generated:approaches:end -->

**Fidelity:** *Exact* reproduces a published formula or rule and is tested against it. *Structural* follows the source's mechanism with our own constants, exposed as parameters. *Simplified* is a stand-in whose module README says what it leaves out. "Verified against" names the [conformance scenarios](../../conformance/README.md) that check the approach against each reference.

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
- **vLLM source, worker memory profiling.** [vLLM worker: request_memory (ceil(total_memory x gpu_memory_utilization)) and determine_available_memory (KV memory = requested - non-KV memory - CUDA-graph estimate)](https://github.com/vllm-project/vllm/blob/main/vllm/v1/worker/gpu_worker.py). Used by: KV bytes per token and memory budget.
- **vLLM v0.31.0 source, start-up profiling pass and sampler.** [vLLM v0.31.0 gpu_model_runner.py: profile_run (a forward pass over max_num_batched_tokens, then the sampler over min(tokens, max_num_seqs) rows), _dummy_sampler_run, profile_cudagraph_memory (shared pool plus at least 1 MiB per graph); sampler.py: logits.to(torch.float32); topk_topp_sampler.py: softmax in float32](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/v1/worker/gpu_model_runner.py#L6409-L6440). Used by: KV bytes per token and memory budget.
- **vLLM v0.31.0 source, CUDA graph capture sizes.** [vLLM v0.31.0 vllm/config/vllm.py _set_cudagraph_sizes: capture sizes 1, 2, 4, multiples of 8 below 256, then of 16, up to min(2 x max_num_seqs, 512)](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/config/vllm.py#L2388-L2420). Used by: KV bytes per token and memory budget, Kernel launch time per layer.
- **vLLM v0.19.0 source, worker memory profiling.** [vLLM v0.19.0 gpu_worker.py determine_available_memory: the CUDA-graph estimate is computed only when VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS is set, which defaults to off (on from v0.21)](https://github.com/vllm-project/vllm/blob/v0.19.0/vllm/v1/worker/gpu_worker.py). Used by: KV bytes per token and memory budget.
- **NVIDIA RTX Blackwell GPU architecture whitepaper.** [NVIDIA RTX Blackwell GPU Architecture v1.1, appendix A, table 4: RTX PRO 6000 Blackwell Workstation Edition, peak BF16 tensor TFLOPS with FP32 accumulate 503.8 dense / 1007.6 with sparsity (the Server Edition's "1 PFLOP" is the sparse figure)](https://www.nvidia.com/content/dam/en-zz/Solutions/design-visualization/quadro-product-literature/pdf/NVIDIA-RTX-Blackwell-PRO-GPU-Architecture-v1_1.pdf). Used by: Roofline step time.
- **NCCL tests, performance notes.** [NVIDIA nccl-tests doc/PERFORMANCE.md: algorithm bandwidth and bus bandwidth; a ring all-reduce moves 2(n-1)/n of the message through each rank](https://github.com/NVIDIA/nccl-tests/blob/master/doc/PERFORMANCE.md). Used by: Tensor parallelism.
- **vLLM docs, CUDA graphs.** [vLLM design document: CUDA Graphs (steps up to the largest capture size replay a graph; larger ones run without)](https://docs.vllm.ai/en/latest/design/cuda_graphs/). Used by: Kernel launch time per layer.
- **BLIS substrate registry, host overheads.** [blis-substrate registry cost-model-host-overheads: assumed (not measured) per-launch and per-layer CPU costs of its kernel model](https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-host-overheads.yaml). Used by: Kernel launch time per layer.
- **vLLM pull request 26836.** [vLLM usage stats of an H100 80GB HBM3: gpu_memory_per_device 85029158912 bytes (79.19 GiB)](https://github.com/vllm-project/vllm/pull/26836).
- **BLIS substrate catalogue, hardware.** [blis-substrate catalog/hardware/*.yaml: MemoryGiB measured as the device total the CUDA driver reports](https://github.com/inference-sim/blis-substrate/tree/main/catalog/hardware).
- **BLIS substrate registry, cost-model-memory.** [blis-substrate registry cost-model-memory: CUDA-graph capture memory, median of 22 vLLM start-up logs (1.08 GiB)](https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-memory.yaml). Used by: KV bytes per token and memory budget.
- **TensorRT-LLM docs.** [TensorRT-LLM: scheduler policies (GuaranteedNoEvict)](https://github.com/NVIDIA/TensorRT-LLM/blob/main/cpp/include/tensorrt_llm/executor/types.h). Used by: Reserve to completion.
- **llm-d docs, router scheduling.** [llm-d architecture: router scheduling (filters, weighted scorers, picker)](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/scheduling.md). Used by: Prefix-cache aware.
- **llm-d docs, flow control.** [llm-d architecture: flow control (queueing, request TTL, eviction)](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/flow-control.md). Used by: Deadline shedding.
- **llm-d docs, P/D disaggregation.** [llm-d architecture: prefill/decode disaggregation (decode-first decider)](https://github.com/llm-d/llm-d/blob/main/docs/architecture/disaggregation/pd-disaggregation.md). Used by: Decode-first with token threshold.
- **llm-d docs, autoscaling.** [llm-d architecture: autoscaling with KEDA on endpoint-picker metrics](https://github.com/llm-d/llm-d/blob/main/docs/architecture/autoscaling/keda-epp.md). Used by: Target concurrency.
- **llm-d docs, KV offloader.** [llm-d architecture: KV offloading to CPU memory and storage](https://github.com/llm-d/llm-d/blob/main/docs/architecture/kv-management/kv-offloader.md). Used by: HBM → DRAM → SSD → shared pool.
- **Gateway API Inference Extension.** [Kubernetes Gateway API Inference Extension (endpoint picker)](https://github.com/kubernetes-sigs/gateway-api-inference-extension). Used by: Prefix-cache aware.
- **Envoy docs, load balancers.** [Envoy: supported load balancers (round robin, least request)](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers). Used by: Round robin, Least loaded.
- **Knative docs, autoscaling.** [Knative Serving: configuring concurrency (target concurrency per replica)](https://knative.dev/docs/serving/autoscaling/concurrency/). Used by: Target concurrency.
- **NVIDIA Dynamo docs.** [NVIDIA Dynamo: KV block manager architecture (memory tiers G1 to G4)](https://github.com/ai-dynamo/dynamo/blob/main/lib/kvbm-engine/docs/architecture.md). Used by: HBM → DRAM → SSD → shared pool.
- **KEDA docs.** [KEDA: Kubernetes event-driven autoscaling](https://keda.sh/).
- **OpenAI docs, rate limits.** [OpenAI API: rate limits (requests per minute and tokens per minute)](https://platform.openai.com/docs/guides/rate-limits).
- **Google SRE book, Handling Overload.** [Site Reliability Engineering, chapter 21: Handling Overload (load shedding, graceful degradation)](https://sre.google/sre-book/handling-overload/).
- **AWS Builders' Library, load shedding.** [Using load shedding to avoid overload (Amazon Builders' Library)](https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/).
- **OpenAI API reference, chat completions.** [OpenAI API reference: create chat completion (the request and response format other engines copy)](https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create).
- **Liu et al., 2024 (Andes).** [Andes: Defining and Enhancing Quality-of-Experience in LLM-Based Text Streaming Services](https://arxiv.org/abs/2404.16283).
- **Agrawal et al., 2024 (Etalon).** [Etalon: Holistic Performance Evaluation Framework for LLM Inference Systems](https://arxiv.org/abs/2407.07000).
- **Little, 1961.** [A Proof for the Queuing Formula: L = λW](https://doi.org/10.1287/opre.9.3.383).
- **Shazeer, 2019.** [Fast Transformer Decoding: One Write-Head is All You Need (multi-query attention)](https://arxiv.org/abs/1911.02150).
- **Ainslie et al., EMNLP 2023.** [GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints](https://arxiv.org/abs/2305.13245).
- **Pope et al., 2022.** [Efficiently Scaling Transformer Inference](https://arxiv.org/abs/2211.05102). Used by: Tensor parallelism.
- **Chen et al., 2023.** [Accelerating Large Language Model Decoding with Speculative Sampling](https://arxiv.org/abs/2302.01318).
- **Dean and Barroso, CACM 2013.** [The Tail at Scale](https://doi.org/10.1145/2408776.2408794).
- **Sennrich et al., ACL 2016.** [Neural Machine Translation of Rare Words with Subword Units (byte-pair encoding)](https://arxiv.org/abs/1508.07909).
- **Kudo and Richardson, 2018.** [SentencePiece: A simple and language independent subword tokenizer and detokenizer](https://arxiv.org/abs/1808.06226).
- **Hugging Face docs, chat templates.** [Hugging Face Transformers: chat templates (message list to the model's token format)](https://huggingface.co/docs/transformers/chat_templating).
- **Fielding, 2000, REST.** [Architectural Styles and the Design of Network-based Software Architectures, chapter 5: Representational State Transfer (the stateless constraint)](https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm).
- **Fowler, Event Sourcing.** [Martin Fowler: Event Sourcing (an append-only log as the record, state derived from it)](https://martinfowler.com/eaaDev/EventSourcing.html).
- **gRPC docs, deadlines.** [gRPC: deadlines (a deadline is set by the caller and propagated down the call chain)](https://grpc.io/docs/guides/deadlines/).
- **Fu et al., OSDI 2024 (ServerlessLLM).** [ServerlessLLM: Low-Latency Serverless Inference for Large Language Models](https://arxiv.org/abs/2401.14351).
- **WHATWG, server-sent events.** [HTML Living Standard: server-sent events (the stream format chat-completions APIs use)](https://html.spec.whatwg.org/multipage/server-sent-events.html).
- **Reddi et al., ISCA 2020 (MLPerf Inference).** [MLPerf Inference Benchmark](https://arxiv.org/abs/1911.02549).
- **Srivatsa et al., 2024 (Preble).** [Preble: Efficient Distributed Prompt Scheduling for LLM Serving](https://arxiv.org/abs/2407.00023).
- **Envoy AI Gateway docs, usage-based rate limiting.** [Envoy AI Gateway: usage-based rate limiting (limits counted in tokens)](https://aigateway.envoyproxy.io/docs/capabilities/traffic/usage-based-ratelimiting).
- **llm-d KV-cache indexer.** [llm-d KV-cache: indexer that maps a prompt's KV-block keys to the pods holding them](https://github.com/llm-d/llm-d-kv-cache).
- **vLLM docs, chat-completions server.** [vLLM: OpenAI-compatible server (chat completions, chat template, streaming)](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html).
- **vLLM repository.** [vLLM: high-throughput and memory-efficient inference and serving engine](https://github.com/vllm-project/vllm).
- **SGLang repository.** [SGLang: a fast serving framework for large language models](https://github.com/sgl-project/sglang).
- **TGI repository.** [Text Generation Inference (Hugging Face)](https://github.com/huggingface/text-generation-inference).
- **TF Serving repository.** [TensorFlow Serving](https://github.com/tensorflow/serving).
- **NVIDIA Dynamo repository.** [NVIDIA Dynamo: datacenter-scale distributed inference serving framework](https://github.com/ai-dynamo/dynamo).
- **Meta, Llama 3.1 8B model card.** [meta-llama/Llama-3.1-8B-Instruct (architecture in config.json)](https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct).
- **Meta, Llama 3.1 70B model card.** [meta-llama/Llama-3.1-70B-Instruct (architecture in config.json)](https://huggingface.co/meta-llama/Llama-3.1-70B-Instruct).
- **NVIDIA H100 datasheet.** [NVIDIA H100 Tensor Core GPU](https://www.nvidia.com/en-us/data-center/h100/).
- **NVIDIA H200 datasheet.** [NVIDIA H200 Tensor Core GPU](https://www.nvidia.com/en-us/data-center/h200/).
- **NVIDIA DGX B200 datasheet.** [NVIDIA DGX B200 (Blackwell B200)](https://www.nvidia.com/en-us/data-center/dgx-b200/).
- **AMD Instinct MI300X datasheet.** [AMD Instinct MI300X Accelerator](https://www.amd.com/en/products/accelerators/instinct/mi300/mi300x.html).
- **NVIDIA RTX PRO 6000 Blackwell Server Edition datasheet.** [NVIDIA RTX PRO 6000 Blackwell Server Edition (96 GB GDDR7, 1597 GB/s; its "FP16/BF16 Tensor Core 1 PFLOP" is the sparse figure)](https://www.nvidia.com/en-us/data-center/rtx-pro-6000-blackwell-server-edition/).
- **NVIDIA Ada GPU architecture whitepaper.** [NVIDIA Ada GPU Architecture, appendix A: GeForce RTX 4090 full specifications (BF16 Tensor TFLOPS with FP32 accumulate 165.2 dense, 1008 GB/s)](https://images.nvidia.com/aem-dam/Solutions/Data-Center/l4/nvidia-ada-gpu-architecture-whitepaper-v2.1.pdf).
- **LLMServingSim, measured vLLM runs.** [LLMServingSim bench/examples: real vLLM runs whose meta.json records device_total_memory_bytes as the driver reports it (MIT licence)](https://github.com/casys-kaist/LLMServingSim/tree/49df63f2af61230da63dd2136044a2dbf9bd4161/bench/examples). Used by: Roofline step time.
- **Knative docs, scale bounds.** [Knative Serving: configuring scale bounds (min-scale, scale-down delay)](https://knative.dev/docs/serving/autoscaling/scale-bounds/).
- **TensorRT-LLM source, executor types.** [TensorRT-LLM: capacity scheduler policies (GUARANTEED_NO_EVICT runs a started request to completion)](https://github.com/NVIDIA/TensorRT-LLM/blob/main/cpp/include/tensorrt_llm/executor/types.h).
- **Databricks, 2023.** [LLM Inference Performance Engineering: Best Practices (defines MBU, compares it with MFU)](https://www.databricks.com/blog/llm-inference-performance-engineering-best-practices).
- **Grattafiori et al., 2024 (Llama 3).** [The Llama 3 Herd of Models (Table 3: layers and key-value heads of the 8B, 70B and 405B models)](https://arxiv.org/abs/2407.21783).
- **Token bucket (Wikipedia).** [Token bucket: capacity, refill rate and conformance test of a rate limiter](https://en.wikipedia.org/wiki/Token_bucket).
<!-- generated:citations:end -->
