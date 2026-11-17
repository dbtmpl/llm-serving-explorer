<h1 align="center">LLM Serving Explorer</h1>

<p align="center">
  <b>Watch an LLM inference stack serve requests, one token at a time.</b>
</p>

<p align="center">
  <a href="https://dbtmpl.github.io/llm-serving-explorer/"><b>Open the live site</b></a>
</p>

<p align="center">
  <a href="https://github.com/dbtmpl/llm-serving-explorer/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/dbtmpl/llm-serving-explorer/actions/workflows/ci.yml/badge.svg"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white">
  <img alt="Static site" src="https://img.shields.io/badge/Backend-none-1BC070">
</p>

LLM Serving Explorer is an interactive, animated explanation of how a modern inference stack serves requests. One graph starts empty and grows as requests arrive: text becomes tokens, the router picks a pod, the engine batches work step by step, and KV-cache blocks fill, move and are evicted on the GPU. It runs in slow motion in your browser and explains each event where it happens. In **Explore** mode you change the model, hardware and policies while requests are in flight. In **Calibrated** mode the same graph replays runs of [BLIS](https://github.com/inference-sim/inference-sim), a simulator built on the [llm-d](https://github.com/llm-d/llm-d) router's own code and a translation of [vLLM](https://github.com/vllm-project/vllm)'s scheduler.

Explore mode is driven by an independent TypeScript model that re-implements vLLM's scheduling and memory behaviour (continuous batching, chunked prefill, paged KV blocks, block-level prefix caching, preemption by recompute) and llm-d's routing, flow control and prefill/decode design. It runs no vLLM or llm-d code. Instead, every push is compared with three references on shared scenarios, and the offsets are what we report. Against BLIS: median deviation 2.2% over 46 comparisons, 30 of them within 5%; 39 of 46 checks agree (84.8 percent) as written, and each of the other 7 is a recorded difference with its cause. Against real vLLM runs measured on two workstation GPUs (one workload): median timing deviation 10.8% over 20 comparisons with the site's default parameters, 2.7% over 28 comparisons on held-out requests after fitting; 44 of 51 checks agree (86.3 percent). Against [LLMServingSim](https://github.com/casys-kaist/LLMServingSim), a second simulator with its own port of vLLM's scheduler, on the same measured workloads and on constructed scenarios: median timing deviation 10.7% over 32 comparisons with the site's default parameters, 2.8% over 40 comparisons on held-out requests after fitting; 72 of 89 checks agree (80.9 percent). BLIS is itself a simulator, so this is agreement with how llm-d and vLLM decide, not a measurement on a GPU cluster, and absolute timings remain indicative. See [Parity with BLIS, llm-d and vLLM](#parity-with-blis-llm-d-and-vllm).

<p align="center">
  <img alt="Demo: ten requests on one pod, then a thousand at once with pods scaling up" src="docs/assets/demo.webp" width="100%">
</p>

<p align="center">
  <a href="docs/assets/demo.mp4">Watch the demo in full HD (1080p, 60 fps)</a>
</p>

## About

Serving an LLM is a systems problem as much as a model problem. Throughput, latency and cost come out of how the router, the scheduler and the memory hierarchy interact, and those interactions are hard to see in metrics or in text. This project makes them visible.

**What you can watch**

- **Routing.** Per-pod scoring on prefix-cache affinity, queue depth and KV utilisation, and what happens when affinity overloads one pod.
- **Continuous batching.** Requests joining and leaving the batch at every engine step, with prefill chunks and decode tokens sharing a step.
- **Paged KV cache and prefix caching.** GPU memory split into weights and KV blocks, with blocks shared between requests that have a common prefix.
- **Eviction and preemption.** What the engine gives up when memory runs out, and why overload turns into thrashing.
- **Memory tiers.** KV moving from GPU memory to host DRAM, SSD and a shared remote pool, and when loading it back beats recomputing.
- **Prefill/decode disaggregation.** Separate pools with KV transfer between pods.
- **Roofline.** Each step's arithmetic intensity against the GPU's compute and memory-bandwidth limits.
- **Autoscaling.** Pods being created, loading weights, serving, draining and terminating.

**What you can change while it runs**

- Model, GPU and tensor parallelism
- Engine settings such as `max_num_seqs`, the token budget, the admission rule and speculative decoding
- Routing policy, autoscaling limits and load shedding
- Tier sizes and session behaviour (follow-up turns, idle time, churn)
- The serving architecture, as a timeline from static batching to today's tiered, disaggregated stacks

**How it explains**

- **Tutorial.** A guided tour moves the view to each part of the graph in turn.
- **Step-through.** Follows one conversation and stops the clock at each event. Back and Next replay the step's animation, and every step has a "Dive deeper" section with the theory behind it and links to the papers.
- **Dive in.** Click a pod, the router or a request to see its numbers and the formulas they come from.
- **Calibrated mode.** Four fixed scenarios (follow-up turns under prefix-aware routing, overload with shedding, KV pressure with a preemption, a steady 70B chat load) replayed from BLIS: arrival, the pod chosen with the router's scores, first and last token, and each pod's KV fill. Settings are read-only there, and the inside of a pod is drawn as totals because BLIS does not report single blocks or steps.

Every source named on the site is a link, and all of the site's text lives in [`src/content/`](src/content/) as markdown.

## Getting Started

You need [Node.js](https://nodejs.org) 22+ and [pnpm](https://pnpm.io) 12+.

```bash
git clone https://github.com/dbtmpl/llm-serving-explorer.git
cd llm-serving-explorer
pnpm install
pnpm dev
```

Open the URL that Vite prints and press **Send one request**.

To build the static site:

```bash
pnpm build      # output in dist/
pnpm preview    # serve the build locally
```

The build is a plain static bundle with no backend, so any static host can serve it. If it is served from a subpath, set the base path: `VITE_BASE_PATH="/llm-serving-explorer/" pnpm build`.

## What is modelled, and where it comes from

Every mechanism in the simulation is an implementation of a published or deployed approach, lives in its own module, names its sources, and is unit-tested against them. This table is generated from the code. The "Verified against" column names the [conformance scenarios](conformance/README.md) that check an approach against the llm-d router and vLLM's scheduler as BLIS runs them; [what that agreement does and does not show](docs/parity.md), with every known difference, is on its own page.

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against | Sources |
|---|---|---|---|---|---|
| [Cost model](src/sim/cost/) | Roofline step time | A step takes the longer of FLOPs over achieved compute and bytes over achieved memory bandwidth (MBU 0.85, MFU 0.7 by default), plus communication and launch time. | Exact | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Williams et al., CACM 2009](https://doi.org/10.1145/1498765.1498785); [NVIDIA RTX Blackwell GPU architecture whitepaper](https://www.nvidia.com/content/dam/en-zz/Solutions/design-visualization/quadro-product-literature/pdf/NVIDIA-RTX-Blackwell-PRO-GPU-Architecture-v1_1.pdf); [LLMServingSim, measured vLLM runs](https://github.com/casys-kaist/LLMServingSim/tree/49df63f2af61230da63dd2136044a2dbf9bd4161/bench/examples) |
| [Cost model](src/sim/cost/) | FLOPs per token | 2N per token through the weights, plus an attention term linear in context length. | Exact | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kaplan et al., 2020](https://arxiv.org/abs/2001.08361); [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| [Cost model](src/sim/cost/) | KV bytes per token and memory budget | Two vectors per layer and KV head per token; the KV pool is what weights, the start-up profiling pass (sized by max_num_batched_tokens and max_num_seqs), CUDA graphs and headroom leave of the memory the driver reports. | Exact | BLIS: `kv-budget-8b-h100`, `kv-budget-70b-h200-tp4`; LLMServingSim: `lss-kv-budget-8b-rtx-pro-6000`, `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090`; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM docs, engine arguments](https://docs.vllm.ai/en/latest/configuration/engine_args.html); [vLLM source, worker memory profiling](https://github.com/vllm-project/vllm/blob/main/vllm/v1/worker/gpu_worker.py); [vLLM v0.19.0 source, worker memory profiling](https://github.com/vllm-project/vllm/blob/v0.19.0/vllm/v1/worker/gpu_worker.py); [vLLM v0.31.0 source, start-up profiling pass and sampler](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/v1/worker/gpu_model_runner.py#L6409-L6440); [vLLM v0.31.0 source, CUDA graph capture sizes](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/config/vllm.py#L2388-L2420); [BLIS substrate registry, cost-model-memory](https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-memory.yaml) |
| [Cost model](src/sim/cost/) | Tensor parallelism | Weights and KV are split evenly over the GPUs of a pod; compute and bandwidth add up, and two all-reduces per layer add communication time. | Simplified | BLIS: 17 scenarios | [Shoeybi et al., 2019](https://arxiv.org/abs/1909.08053); [Pope et al., 2022](https://arxiv.org/abs/2211.05102); [NCCL tests, performance notes](https://github.com/NVIDIA/nccl-tests/blob/master/doc/PERFORMANCE.md) |
| [Cost model](src/sim/cost/) | Kernel launch time per layer | A fixed time per layer to launch a step's kernels, higher for a step too large for a captured CUDA graph. | Simplified | BLIS: 24 scenarios | [vLLM docs, CUDA graphs](https://docs.vllm.ai/en/latest/design/cuda_graphs/); [vLLM v0.31.0 source, CUDA graph capture sizes](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/config/vllm.py#L2388-L2420); [BLIS substrate registry, host overheads](https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-host-overheads.yaml) |
| [Cost model](src/sim/cost/) | Host time per step | A fixed plus per-sequence CPU cost that adds to, or overlaps with, GPU time. | Simplified | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html) |
| [Step scheduling](src/sim/engine/) | Chunked prefill under a token budget | A long prompt is prefilled in chunks sharing each step with decodes, bounded by a per-step token budget. | Structural | BLIS: `timing-8b-h100-burst`, `timing-8b-h100-heavy`, `preemption-overflow`; LLMServingSim: `lss-preemption-overflow`, `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090`; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Agrawal et al., OSDI 2024](https://arxiv.org/abs/2403.02310); [Agrawal et al., 2023](https://arxiv.org/abs/2308.16369); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py); [vLLM source, config/scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/config/scheduler.py) |
| [Batching](src/sim/batching/) | Static batching | A batch runs to completion before the next one is formed. | Structural | Not verifiable | [Crankshaw et al., NSDI 2017](https://arxiv.org/abs/1612.03079); [NVIDIA Triton docs](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/batcher.html); [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu) |
| [Batching](src/sim/batching/) | Continuous batching | Requests join and leave the batch at every engine step. | Structural | BLIS: 32 scenarios; LLMServingSim: 12 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py) |
| [KV admission](src/sim/admission/) | On-demand (paged) | Allocate blocks for the tokens scheduled this step; grow as the sequence grows. | Structural | BLIS: `preemption-overflow`, `queue-deadline-shedding`; LLMServingSim: `lss-preemption-overflow` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py) |
| [KV admission](src/sim/admission/) | Whole prompt | Allocate blocks for the full prompt at admission; outputs grow on demand. | Structural | Not verifiable | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [KV admission](src/sim/admission/) | Reserve to completion | Reserve prompt plus max_tokens up front; admitted requests are never preempted. | Structural | Not verifiable | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [TensorRT-LLM docs](https://github.com/NVIDIA/TensorRT-LLM/blob/main/cpp/include/tensorrt_llm/executor/types.h); [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu) |
| [KV cache layout](src/sim/kvcache/) | Paged KV blocks (PagedAttention) | KV memory is handed out in fixed 16-token blocks as tokens are written, like virtual-memory pages. | Structural | BLIS: 4 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090`; LLMServingSim: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Prefix reuse](src/sim/kvcache/) | Block-hash prefix cache | Reuse whole KV blocks whose entire token prefix matches; always compute the last token. | Exact | BLIS: 4 scenarios; LLMServingSim: `lss-prefix-cache` | [vLLM docs, prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html); [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Eviction order](src/sim/kvcache/) | LRU, whole session | Evict the idle session that was used longest ago. | Simplified | BLIS: `eviction-pressure`, `tiers-offload` | [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708); [vLLM docs, prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html) |
| [KV tiers](src/sim/kvcache/) | HBM → DRAM → SSD → shared pool | Idle sessions move down a memory hierarchy instead of being dropped, and are loaded back on return. | Structural | BLIS: `tiers-offload`; LLMServingSim: `lss-tiers-offload` | [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708); [Qin et al., FAST 2025](https://arxiv.org/abs/2407.00079); [Liu et al., 2025 (LMCache)](https://arxiv.org/abs/2510.09665); [llm-d docs, KV offloader](https://github.com/llm-d/llm-d/blob/main/docs/architecture/kv-management/kv-offloader.md); [NVIDIA Dynamo docs](https://github.com/ai-dynamo/dynamo/blob/main/lib/kvbm-engine/docs/architecture.md) |
| [Reload decision](src/sim/kvcache/) | Adaptive load-or-recompute | Load KV from a lower tier only when copying is faster than prefilling again. | Simplified | Not verifiable | [Liu et al., 2025 (LMCache)](https://arxiv.org/abs/2510.09665); [Liu et al., SIGCOMM 2024](https://arxiv.org/abs/2310.07240) |
| [Preemption](src/sim/kvcache/) | Preempt newest, recompute | Free the most recently admitted sequence and prefill it again later. | Exact | BLIS: `preemption-overflow`; LLMServingSim: `lss-preemption-overflow` | [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py); [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html); [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Decoding](src/sim/decoding/) | Autoregressive | One token per sequence per step. | Exact | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| [Decoding](src/sim/decoding/) | Speculative decoding | A draft model proposes several tokens; the target verifies them in one pass. | Exact | BLIS: `spec-decoding`, `calib-8b-h100-spec`; LLMServingSim: `lss-spec-decoding`, `calib-lss-8b-rtx-pro-6000-spec` | [Leviathan et al., ICML 2023](https://arxiv.org/abs/2211.17192) |
| [Routing](src/sim/routing/) | Round robin | Rotate through pods regardless of load or cache. | Exact | BLIS: `routing-round-robin`, `routing-prefix-vs-round-robin`; LLMServingSim: `lss-routing-round-robin` | [Envoy docs, load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) |
| [Routing](src/sim/routing/) | Least loaded | Send to the pod with the fewest requests in flight. | Simplified | BLIS: `routing-least-loaded` | [Envoy docs, load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) |
| [Routing](src/sim/routing/) | Prefix-cache aware | Weighted score of cached prefix, KV utilisation and queue depth, as in llm-d. | Structural | BLIS: 4 scenarios | [llm-d docs, router scheduling](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/scheduling.md); [Gateway API Inference Extension](https://github.com/kubernetes-sigs/gateway-api-inference-extension) |
| [Prefill/decode disaggregation](src/sim/disaggregation/) | Decode-first with token threshold | Pick the decode pod first; use the prefill pool only when enough of the prompt is uncached there. | Structural | BLIS: `pd-disaggregation`, `calib-8b-h100-pd`; LLMServingSim: `lss-pd-disaggregation` | [llm-d docs, P/D disaggregation](https://github.com/llm-d/llm-d/blob/main/docs/architecture/disaggregation/pd-disaggregation.md); [Zhong et al., OSDI 2024](https://arxiv.org/abs/2401.09670); [Patel et al., ISCA 2024](https://arxiv.org/abs/2311.18677) |
| [Autoscaling](src/sim/autoscaling/) | Target concurrency | Run enough pods that each carries at most its target number of requests. | Simplified | BLIS: `autoscale-overload` | [Knative docs, autoscaling](https://knative.dev/docs/serving/autoscaling/concurrency/); [llm-d docs, autoscaling](https://github.com/llm-d/llm-d/blob/main/docs/architecture/autoscaling/keda-epp.md) |
| [Flow control](src/sim/flowcontrol/) | Deadline shedding | Reject requests that have waited at the router longer than a time-to-live. | Simplified | BLIS: `queue-deadline-shedding` | [llm-d docs, flow control](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/flow-control.md) |
| [Workload](src/sim/workload/) | Closed-loop multi-turn sessions | Users wait for an answer, think, then re-send the whole conversation plus a new message. | Simplified | Not verifiable | [Schroeder et al., NSDI 2006](https://www.usenix.org/conference/nsdi-06/presentation/open-versus-closed-cautionary-tale); [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708) |
| [Workload](src/sim/workload/) | Trace replay | Requests are injected at recorded times with recorded lengths, so a run can be repeated or compared exactly. | Simplified | Not verifiable | [Schroeder et al., NSDI 2006](https://www.usenix.org/conference/nsdi-06/presentation/open-versus-closed-cautionary-tale); [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708) |
<!-- generated:approaches:end -->

**Fidelity** says how closely an approach follows its source. *Exact*: a published formula or rule, reproduced and tested against it. *Structural*: the source's mechanism with our own constants, exposed as parameters. *Simplified*: a stand-in whose documentation says what is left out.

The full list of sources, with links, is in [`src/sim/README.md`](src/sim/README.md#sources). Each module's README lists what it does not model.

## Parity with BLIS, llm-d and vLLM

The model is checked against [BLIS](https://github.com/inference-sim/inference-sim) (inference-sim), a discrete-event simulator that runs the llm-d router's code in front of a Go translation of vLLM 0.32's scheduler. Agreement with BLIS is therefore agreement with how those two systems route, queue, admit, preempt and account for KV memory.

It is also compared with real vLLM timings: 300 ShareGPT requests replayed through the model against what vLLM 0.31.0 and 0.19.0 measured on one RTX PRO 6000 and one RTX 4090 (data published with [LLMServingSim](https://github.com/casys-kaist/LLMServingSim), MIT licence). It is compared, third, with [LLMServingSim](https://github.com/casys-kaist/LLMServingSim) run as a simulator (a second, independent port of vLLM's scheduler and block pool whose step times come from kernels profiled on those two GPUs; its authors validate it against the measured runs). The three references are evidence for different things. BLIS: the decisions of llm-d and vLLM as simulated (routing, admission, preemption, KV accounting), and timings fitted to a simulator. Measured vLLM: how far the model's timings and KV pool sizing are from real hardware, for one model and one load on two workstation GPUs; nothing about routing, other GPUs or other loads. LLMServingSim: a second implementation's scheduling, caching, tier and prefill/decode decisions and profiled-kernel timings on two GPUs; on the measured scenarios it agrees with the measurement within 1.2 percent (its own validation), so there it adds little beyond a second preemption count and a prefix-hit rate. Each is reported separately below, and where the model is fitted the readings before and after the fit are kept apart.

<!-- generated:parity-readme:start -->
**BLIS** (commit `c79c7456`): median deviation 2.2% over 46 comparisons, 30 of them within 5%.

| Group | Comparisons | Median deviation | Largest deviation | Within 1% | Within 5% | Within 10% | Within 25% |
|---|---|---|---|---|---|---|---|
| Capacity and KV accounting | 2 | 0.8% | 1.0% | 2 | 2 | 2 | 2 |
| Decisions | 12 | 0% | 75.0% | 10 | 10 | 10 | 10 |
| Timings and rates (fitted, held out) | 24 | 2.7% | 33.6% | 4 | 17 | 20 | 23 |
| Directional effects | 8 | 14.0% | unbounded | 1 | 1 | 3 | 5 |
| **All** | 46 | 2.2% | unbounded | 17 | 30 | 35 | 40 |

Counting checks instead: 39 of 46 checks agree (84.8 percent), 7 known differences; 22 of the 28 approaches in the table above are covered by at least one of its scenarios.

| Kind of check | What must hold | Checks | Agree | Known difference |
|---|---|---|---|---|
| Exact | Decisions and discrete counts are equal (the pod chosen, cached prefix tokens, which requests are shed or preempted) | 12 | 10 | 2 |
| Capacity | KV blocks per replica within 0.1%: both sides derive them from estimates | 2 | 0 | 2 |
| Calibrated | A timing or rate is within the tolerance written in the scenario | 24 | 23 | 1 |
| Directional | The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling) | 8 | 6 | 2 |
| **All** | | **46** | **39** | **7** |

Every check that does not hold as written (the scenario files carry the full reasons, [the parity page](docs/parity.md) the numbers):

| Compared | Ours | Reference | Deviation | Missed | Cause |
|---|---|---|---|---|---|
| `autoscale-overload`: mean time to first token, fixed to autoscaled | 8.4% of baseline | 40% of baseline | ratio 0.21 | effect ratio 0.33 to 3 (different by design) | The autoscalers follow different rules and reach different sizes |
| `kv-budget-70b-h200-tp4`: KV blocks per replica | 75,234 blocks | 74,760 blocks | +0.6% | 0.1% | BLIS's flat graph median is above what measured engines set aside; the model follows the measurements |
| `kv-budget-8b-h100`: KV blocks per replica | 28,205 blocks | 27,926 blocks | +1.0% | 0.1% | BLIS's flat graph median is above what measured engines set aside; the model follows the measurements |
| `routing-round-robin`: pod chosen per request | per request | per request | 8 of 12 differ (67%) | different by design | llm-d picks at random among tied pods; the model rotates strictly, as Envoy does |
| `routing-round-robin`: requests per pod | 3/3/3/3 | 4/4/3/1 | 3 of 4 differ (75%); largest 200% | different by design | Same cause: random choice among tied pods against strict rotation |
| `tiers-offload`: host-tier hit rate, gpu-only to with-dram | 49.8% | 0.0% | unbounded (reference effect is zero), direction differs | effect ratio 0.67 to 1.5 | The reference reports a zero host-tier hit counter although the tier works (its counter, not the behaviour) |
| `timing-8b-h100-burst`: mean time to first token | 728 ms | 545 ms | +33.6% | 30% | One compute-efficiency factor cannot follow the reference's prefill cost curve |

**Measured vLLM** (revision `49df63f2`): median timing deviation 10.8% over 20 comparisons with the site's default parameters, 2.7% over 28 comparisons on held-out requests after fitting.

| Group | Comparisons | Median deviation | Largest deviation | Within 1% | Within 5% | Within 10% | Within 25% |
|---|---|---|---|---|---|---|---|
| Capacity and KV accounting | 2 | 50.6% | 100.0% | 0 | 1 | 1 | 1 |
| Decisions | 1 | 0% | 0% | 1 | 1 | 1 | 1 |
| Timings, default parameters (no fit) | 20 | 10.8% | 16.4% | 0 | 1 | 9 | 20 |
| Timings and rates (fitted, held out) | 28 | 2.7% | 41.3% | 2 | 22 | 24 | 27 |

Counting checks instead: 44 of 51 checks agree (86.3 percent), 7 known differences; 8 of the 28 approaches in the table above are covered by at least one of its scenarios.

| Kind of check | What must hold | Checks | Agree | Known difference |
|---|---|---|---|---|
| Exact | Decisions and discrete counts are equal (the pod chosen, cached prefix tokens, which requests are shed or preempted) | 1 | 1 | 0 |
| Capacity | KV blocks per replica within 0.1%: both sides derive them from estimates | 1 | 0 | 1 |
| Calibrated | A timing or rate is within the tolerance written in the scenario | 49 | 43 | 6 |
| Directional | The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling) | 0 | 0 | 0 |
| **All** | | **51** | **44** | **7** |

Every check that does not hold as written (the scenario files carry the full reasons, [the parity page](docs/parity.md) the numbers):

| Compared | Ours | Reference | Deviation | Missed | Cause |
|---|---|---|---|---|---|
| `measured-8b-rtx-4090`: KV blocks per replica | 2,620 blocks | 2,588 blocks | +1.2% | 0.1% | The empirical runtime allowance is fitted to two runs; this one keeps part of their spread |
| `measured-8b-rtx-4090`: median end-to-end time | 97.12 s | 83.42 s | +16.4% | 15% | Time per token on this run is still 10 percent high at the defaults |
| `measured-8b-rtx-pro-6000`: prefix-cache hit rate | 0.0% | 7.6% | -100.0% | 5% | The model's prefix cache is per conversation; the trace carries no shared prefixes |
| `measured-8b-rtx-pro-6000`: mean time to first token | 3,830 ms | 6,520 ms | -41.3% | 30% | Parameters fitted on the other card sit at their MBU bound |
| `measured-8b-rtx-pro-6000`: mean time per output token | 26 ms | 31 ms | -16.7% | 12% | Parameters fitted on the other card sit at their MBU bound |
| `measured-8b-rtx-pro-6000`: mean end-to-end time | 20.85 s | 26.95 s | -22.6% | 15% | Parameters fitted on the other card sit at their MBU bound |
| `measured-8b-rtx-pro-6000`: throughput | 3,570 tok/s | 3,068 tok/s | +16.3% | 10% | Parameters fitted on the other card sit at their MBU bound |

**LLMServingSim** (commit `49df63f2`): median timing deviation 10.7% over 32 comparisons with the site's default parameters, 2.8% over 40 comparisons on held-out requests after fitting.

| Group | Comparisons | Median deviation | Largest deviation | Within 1% | Within 5% | Within 10% | Within 25% |
|---|---|---|---|---|---|---|---|
| Capacity and KV accounting | 3 | 100.0% | 100.0% | 0 | 1 | 1 | 1 |
| Decisions | 8 | 0% | 100.0% | 7 | 7 | 7 | 7 |
| Timings, default parameters (no fit) | 32 | 10.7% | 48.4% | 1 | 3 | 13 | 30 |
| Timings and rates (fitted, held out) | 40 | 2.8% | 41.6% | 6 | 28 | 34 | 37 |
| Directional effects | 6 | 4.5% | 184.0% | 2 | 3 | 4 | 4 |

Counting checks instead: 72 of 89 checks agree (80.9 percent), 17 known differences; 15 of the 28 approaches in the table above are covered by at least one of its scenarios.

| Kind of check | What must hold | Checks | Agree | Known difference |
|---|---|---|---|---|
| Exact | Decisions and discrete counts are equal (the pod chosen, cached prefix tokens, which requests are shed or preempted) | 7 | 6 | 1 |
| Capacity | KV blocks per replica within 0.1%: both sides derive them from estimates | 1 | 0 | 1 |
| Calibrated | A timing or rate is within the tolerance written in the scenario | 75 | 62 | 13 |
| Directional | The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling) | 6 | 4 | 2 |
| **All** | | **89** | **72** | **17** |

Every check that does not hold as written (the scenario files carry the full reasons, [the parity page](docs/parity.md) the numbers):

| Compared | Ours | Reference | Deviation | Missed | Cause |
|---|---|---|---|---|---|
| `lss-kv-budget-8b-rtx-pro-6000`: KV blocks per replica | 36,437 blocks | 37,090 blocks | -1.8% | 0.1% | LLMServingSim sets nothing aside for activations or CUDA graphs |
| `lss-pd-disaggregation`: mean time to first token, colocated to split | 130% of baseline | 89% of baseline | ratio 1.44, direction differs | effect ratio 0.67 to 1.5 | LLMServingSim's time to first token ends at the prefill replica, before the hand-over |
| `lss-tiers-offload`: mean time to first token of follow-up turns, gpu-only to with-dram | 47% of baseline | 16% of baseline | ratio 2.84 | effect ratio 0.75 to 1.33 | The model's fixed front-end tokenisation and slower host copy dominate a short reload |
| `measured-8b-rtx-4090`: prefix-cache hit rate | 0.0% | 1.9% | -100.0% | 5% | The model's prefix cache is per conversation; the trace carries no shared prefixes |
| `measured-8b-rtx-4090`: preemptions | 204 | 191 | 1 of 1 differ (100%); largest 7% | decision differs | A count that compounds small timing differences over a saturated run |
| `measured-8b-rtx-4090`: median end-to-end time | 97.12 s | 83.97 s | +15.6% | 15% | Time per token on this run is still 10 percent high at the defaults |
| `measured-8b-rtx-pro-6000`: prefix-cache hit rate | 0.0% | 7.6% | -100.0% | 5% | The model's prefix cache is per conversation; the trace carries no shared prefixes |
| `measured-8b-rtx-pro-6000`: mean time to first token | 3,830 ms | 6,560 ms | -41.6% | 30% | Parameters fitted on the other card sit at their MBU bound |
| `measured-8b-rtx-pro-6000`: mean time per output token | 26 ms | 32 ms | -16.9% | 12% | Parameters fitted on the other card sit at their MBU bound |
| `measured-8b-rtx-pro-6000`: mean end-to-end time | 20.85 s | 27.03 s | -22.9% | 15% | Parameters fitted on the other card sit at their MBU bound |
| `measured-8b-rtx-pro-6000`: throughput | 3,570 tok/s | 3,070 tok/s | +16.3% | 10% | Parameters fitted on the other card sit at their MBU bound |
| `timing-lss-8b-rtx-pro-6000-chat`: mean time to first token | 120 ms | 85 ms | +41.1% | 30% | Front-end tokenisation LLMServingSim lacks |
| `timing-lss-8b-rtx-pro-6000-chat`: mean time per output token | 14 ms | 12 ms | +13.8% | 12% | At small batches the default launch cost and MBU add 1.7 ms to a profiled 12.0 ms step |
| `timing-lss-8b-rtx-pro-6000-isolated`: mean time to first token | 180 ms | 121 ms | +48.4% | 30% | Front-end tokenisation LLMServingSim lacks, and prefill at default MFU |
| `timing-lss-8b-rtx-pro-6000-isolated`: mean time per output token | 13 ms | 12 ms | +13.5% | 12% | At batch 1 the default launch cost and MBU add 1.5 ms to a profiled 11.6 ms step |
| `timing-lss-8b-rtx-pro-6000-isolated`: mean end-to-end time | 2,790 ms | 2,420 ms | +15.3% | 15% | Follows the default time per token and the front end |
| `timing-lss-8b-rtx-pro-6000-isolated`: mean time to first token | 161 ms | 121 ms | +32.7% | 30% | Front-end tokenisation LLMServingSim lacks |

6 of the 28 approaches have no counterpart in any reference and are counted neither way; regenerate with `pnpm conformance:summary && pnpm docs:sync`.
<!-- generated:parity-readme:end -->

In short, against BLIS: median deviation 2.2% over 46 comparisons, 30 of them within 5%; 39 of 46 checks agree (84.8 percent) as written. Against measured vLLM (real runs of 300 ShareGPT requests on one RTX PRO 6000 and one RTX 4090): median timing deviation 10.8% over 20 comparisons with the site's default parameters, 2.7% over 28 comparisons on held-out requests after fitting; 44 of 51 checks agree (86.3 percent). Out of the box (MBU 0.85, MFU 0.7, both taken from these runs and from BLIS) every default timing check on the RTX PRO 6000 holds, and on the RTX 4090 all but the median end-to-end time (+16.4 percent against 15) hold; the 4090's time per token is +10.6 percent. It was +22 percent until the model kept a preempted request's full KV blocks in the prefix cache, as vLLM does, instead of recomputing it from zero (2026-11-17). Before the cost model was changed (2026-11-16, [ADR 0008](docs/adr/0008-step-time-and-memory-from-measured-vllm.md)) the decode step was 50 to 60 percent slow, queue waits roughly doubled and throughput was 33 to 45 percent low. The KV pool is within 0.07 percent of the RTX PRO 6000's and 1.2 percent above the RTX 4090's, with an empirical 0.7 GB per GPU for memory outside PyTorch fitted to these two runs (without it the model was 0.8 and 14.1 percent over). Parameters fitted to the RTX PRO 6000 hold all four checks on the RTX 4090; those fitted to the RTX 4090 hold none on the RTX PRO 6000, because that fit still reaches its MBU bound. Two readings, never pooled. The one prefix-cache check, a 7.6 percent hit rate, is out of reach for now: the model's prefix cache is per conversation and the trace gives it token counts, not the prefixes these separate conversations share. Against LLMServingSim (the same two measured workloads, and constructed scenarios on the RTX PRO 6000: prefix cache, preemption, round robin, `max_num_seqs`, host tier, prefill/decode, speculative decoding, held-out timing): median timing deviation 10.7% over 32 comparisons with the site's default parameters, 2.8% over 40 comparisons on held-out requests after fitting; 72 of 89 checks agree (80.9 percent). Its decisions agree with the model's on 6 of 7 exact checks (cached prefix tokens per follow-up, preemption count, round-robin placement, `max_num_seqs`); the miss is the RTX 4090's preemption count over a long saturated run, 204 against 191. Its KV pool on the RTX PRO 6000 is 37,090 blocks against 36,649 measured, since it sets nothing aside for activations, CUDA graphs or memory outside PyTorch. Two of its features are compared as effects, not times, and one of those differs by definition: in a prefill/decode split its time to first token ends at the prefill replica, before the hand-over. At small batches the model's front-end tokenisation (30 ms plus 4 microseconds per token), which LLMServingSim does not model, is most of what separates their first-token times. Its authors validated it against these very vLLM runs, so its agreement with the measurement is not independent evidence. The seven checks against BLIS that do not hold are in the table above: round robin (Envoy's strict rotation against llm-d's random choice among tied pods, two checks); time to first token when 32 requests arrive at one instant, where one compute-efficiency factor cannot follow BLIS's prefill cost; the host-memory tier's hit-rate counter, which BLIS reports as zero; how far queue wait falls under autoscaling, because the two autoscalers follow different rules; and the KV pool of one replica, which the model sizes 1.0 percent (8B on an H100) and 0.6 percent (70B on four H200s) above BLIS, because BLIS charges an assumed 1.16 GB median for CUDA graphs where the model follows what the measured engines set aside. The preemption check of the overflow scenario agrees again.

**How it is achieved**

1. **Shared scenarios.** Each check is a YAML file in [`conformance/scenarios/`](conformance/scenarios/) that describes a deployment, a request list and what must hold, with its tolerance and the reason for it written before the first run.
2. **One adapter per reference.** A scenario is turned into parameters and a request trace for the TypeScript model, and each reference (so far BLIS) turns it into its own input, so both see the same requests. A reference may be a simulator or measured data; the suite knows only the interface.
3. **Pinned, committed references.** [`conformance/refs/blis/lock`](conformance/refs/blis/lock) names one BLIS commit. Its output per scenario is committed, so the comparison on every push needs only Node. A nightly job rebuilds that commit and fails if the references are stale; a weekly job runs BLIS's `main` to show drift early.
4. **Calibration for timings.** Step times come from a roofline with two efficiency factors and a host-time term. For the comparison these are fitted to BLIS per model and GPU on one set of scenarios and checked on another. The site's defaults are not changed by the fit.
5. **No silent tolerance.** A check holds as written, or it is recorded as a known difference with its numbers and cause, and the test fails if that difference changes or disappears. Where the first comparison showed the model wrong against the vLLM source (the size of the KV pool, what a finished turn leaves cached, when a waiting request is admitted), the model was fixed.

**What it does not show.** BLIS is a simulator, not a cluster: nothing here was measured on GPUs. The scenarios are small and constructed. Timings agree after a fit to BLIS, which says the cost model can follow BLIS, not that either matches hardware. Mechanisms with no counterpart in BLIS (static batching, admission rules that reserve memory for a whole prompt or a whole answer) cannot be checked at all, and BLIS's catalog has no MI300X.

[docs/parity.md](docs/parity.md) has every known difference with its numbers, the fitted values and what is not verifiable.

## How accurate is it?

The simulation is a teaching model. It aims to get the mechanisms right and the magnitudes plausible.

- **Exact where the sources are exact.** KV bytes per token, memory budgets, FLOPs, ridge points, roofline step times and speculative-decoding speed-ups are closed-form and tested against worked numbers.
- **Checked against BLIS where BLIS has the mechanism.** See the section above.
- **Checked against source code where behaviour matters.** For example, vLLM's preemption order, its rule of admitting nothing in a step that preempted, its sizing of the KV pool from the memory the driver reports, and its default `max_num_seqs`.
- **Adjustable where the sources give a range.** Host time per step, tier copy rates and utilisation factors sit inside plausible ranges and are exposed as controls.
- **Deterministic.** A seed and a sequence of inputs always give the same event stream; such streams are pinned by tests.

[docs/design-choices.md](docs/design-choices.md) lists, topic by topic, what the sources say, where they disagree and which reading the model takes.

## Project Layout

| Path | Contents |
|---|---|
| [`src/sim/`](src/sim/) | The simulation: one module per concept (routing, batching, KV cache, ...), each with its own README, sources and tests |
| [`src/sim/citations.ts`](src/sim/citations.ts) | The registry of every paper, document and datasheet the model relies on |
| [`src/live/`](src/live/) | The user interface: canvas rendering, menus, inspector, tutorial and step-through |
| [`src/content/`](src/content/) | Every explanatory text on the site, as markdown |
| [`src/replay/`](src/replay/) | Calibrated mode: plays a BLIS replay file on the same graph |
| [`public/replay/`](public/replay/) | The replay files, generated from the pinned BLIS |
| [`conformance/`](conformance/) | Scenarios, translators, BLIS references, calibration and the tests that compare the model with BLIS |
| [`e2e/`](e2e/) | Playwright end-to-end tests |
| [`docs/`](docs/) | Design choices, the parity page and architecture decision records |

The simulation has no dependency on the interface and can be run on its own:

```ts
import { DEFAULT_PARAMS, advance, createWorld, spawnBurst } from "./src/sim/index.js";

const world = createWorld({ ...DEFAULT_PARAMS, routing: "prefix-aware" });
spawnBurst(world, 100);   // 100 sessions arrive at once
advance(world, 30);       // 30 simulated seconds
console.log(world.m.completed, world.m.preemptions);
```

To model a new paper, add an approach to the module that owns the decision: see [`src/sim/README.md`](src/sim/README.md).

## Development

```bash
pnpm typecheck
pnpm test         # unit tests, one suite per simulation module, and the comparison with the BLIS references
pnpm test:e2e     # Playwright (first time: pnpm exec playwright install chromium)
pnpm docs:sync    # regenerate the tables in the READMEs and the parity page from the code
```

Regenerating what comes from BLIS needs Go and a build of the commit in `conformance/refs/blis/lock` (see [`conformance/README.md`](conformance/README.md)):

```bash
BLIS_BIN=/path/to/blis pnpm conformance:reference   # BLIS output per scenario
pnpm conformance:calibrate                          # refit the timing parameters
pnpm conformance:summary                            # the parity figures
BLIS_BIN=/path/to/blis pnpm replay:build            # replay files for Calibrated mode
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and for how changes to the model should be sourced and tested. Terms are defined in [GLOSSARY.md](GLOSSARY.md).

## License

[Apache-2.0](LICENSE)
