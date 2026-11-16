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

Explore mode is driven by an independent TypeScript model that re-implements vLLM's scheduling and memory behaviour (continuous batching, chunked prefill, paged KV blocks, block-level prefix caching, preemption by recompute) and llm-d's routing, flow control and prefill/decode design. It runs no vLLM or llm-d code. Instead, every push is compared with two references on shared scenarios, and the offsets are what we report. Against BLIS: median deviation 3.1% over 46 comparisons, 28 of them within 5%; 40 of 46 checks agree (87.0 percent) as written, and each of the other 6 is a recorded difference with its cause. Against real vLLM runs measured on two workstation GPUs (one workload): median timing deviation 73.3% over 20 comparisons with the site's default parameters, 8.1% over 20 comparisons on held-out requests after fitting; 20 of 43 checks agree (46.5 percent). BLIS is itself a simulator, so this is agreement with how llm-d and vLLM decide, not a measurement on a GPU cluster, and absolute timings remain indicative. See [Parity with BLIS, llm-d and vLLM](#parity-with-blis-llm-d-and-vllm).

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
| [Cost model](src/sim/cost/) | Roofline step time | A step takes the longer of FLOPs over peak compute and bytes over memory bandwidth. | Exact | BLIS: 20 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Williams et al., CACM 2009](https://doi.org/10.1145/1498765.1498785) |
| [Cost model](src/sim/cost/) | FLOPs per token | 2N per token through the weights, plus an attention term linear in context length. | Exact | BLIS: 20 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kaplan et al., 2020](https://arxiv.org/abs/2001.08361); [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| [Cost model](src/sim/cost/) | KV bytes per token and memory budget | Two vectors per layer and KV head per token; the KV pool is what weights, activations, CUDA graphs and headroom leave of the memory the driver reports. | Exact | BLIS: `kv-budget-8b-h100`, `kv-budget-70b-h200-tp4`; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM docs, engine arguments](https://docs.vllm.ai/en/latest/configuration/engine_args.html); [vLLM source, worker memory profiling](https://github.com/vllm-project/vllm/blob/main/vllm/v1/worker/gpu_worker.py); [BLIS substrate registry, cost-model-memory](https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-memory.yaml) |
| [Cost model](src/sim/cost/) | Tensor parallelism | Weights and KV are split evenly over the GPUs of a pod; compute and bandwidth add up. | Simplified | BLIS: 7 scenarios | [Shoeybi et al., 2019](https://arxiv.org/abs/1909.08053) |
| [Cost model](src/sim/cost/) | Host time per step | A fixed plus per-sequence CPU cost that adds to, or overlaps with, GPU time. | Simplified | BLIS: 20 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html) |
| [Step scheduling](src/sim/engine/) | Chunked prefill under a token budget | A long prompt is prefilled in chunks sharing each step with decodes, bounded by a per-step token budget. | Structural | BLIS: `timing-8b-h100-burst`, `timing-8b-h100-heavy`, `preemption-overflow`; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Agrawal et al., OSDI 2024](https://arxiv.org/abs/2403.02310); [Agrawal et al., 2023](https://arxiv.org/abs/2308.16369); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py); [vLLM source, config/scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/config/scheduler.py) |
| [Batching](src/sim/batching/) | Static batching | A batch runs to completion before the next one is formed. | Structural | Not verifiable | [Crankshaw et al., NSDI 2017](https://arxiv.org/abs/1612.03079); [NVIDIA Triton docs](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/batcher.html); [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu) |
| [Batching](src/sim/batching/) | Continuous batching | Requests join and leave the batch at every engine step. | Structural | BLIS: 22 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py) |
| [KV admission](src/sim/admission/) | On-demand (paged) | Allocate blocks for the tokens scheduled this step; grow as the sequence grows. | Structural | BLIS: `preemption-overflow`, `queue-deadline-shedding` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py) |
| [KV admission](src/sim/admission/) | Whole prompt | Allocate blocks for the full prompt at admission; outputs grow on demand. | Structural | Not verifiable | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [KV admission](src/sim/admission/) | Reserve to completion | Reserve prompt plus max_tokens up front; admitted requests are never preempted. | Structural | Not verifiable | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [TensorRT-LLM docs](https://github.com/NVIDIA/TensorRT-LLM/blob/main/cpp/include/tensorrt_llm/executor/types.h); [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu) |
| [KV cache layout](src/sim/kvcache/) | Paged KV blocks (PagedAttention) | KV memory is handed out in fixed 16-token blocks as tokens are written, like virtual-memory pages. | Structural | BLIS: 4 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Prefix reuse](src/sim/kvcache/) | Block-hash prefix cache | Reuse whole KV blocks whose entire token prefix matches; always compute the last token. | Exact | BLIS: 4 scenarios | [vLLM docs, prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html); [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Eviction order](src/sim/kvcache/) | LRU, whole session | Evict the idle session that was used longest ago. | Simplified | BLIS: `eviction-pressure`, `tiers-offload` | [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708); [vLLM docs, prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html) |
| [KV tiers](src/sim/kvcache/) | HBM → DRAM → SSD → shared pool | Idle sessions move down a memory hierarchy instead of being dropped, and are loaded back on return. | Structural | BLIS: `tiers-offload` | [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708); [Qin et al., FAST 2025](https://arxiv.org/abs/2407.00079); [Liu et al., 2025 (LMCache)](https://arxiv.org/abs/2510.09665); [llm-d docs, KV offloader](https://github.com/llm-d/llm-d/blob/main/docs/architecture/kv-management/kv-offloader.md); [NVIDIA Dynamo docs](https://github.com/ai-dynamo/dynamo/blob/main/lib/kvbm-engine/docs/architecture.md) |
| [Reload decision](src/sim/kvcache/) | Adaptive load-or-recompute | Load KV from a lower tier only when copying is faster than prefilling again. | Simplified | Not verifiable | [Liu et al., 2025 (LMCache)](https://arxiv.org/abs/2510.09665); [Liu et al., SIGCOMM 2024](https://arxiv.org/abs/2310.07240) |
| [Preemption](src/sim/kvcache/) | Preempt newest, recompute | Free the most recently admitted sequence and prefill it again later. | Exact | BLIS: `preemption-overflow` | [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py); [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html); [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| [Decoding](src/sim/decoding/) | Autoregressive | One token per sequence per step. | Exact | BLIS: 20 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| [Decoding](src/sim/decoding/) | Speculative decoding | A draft model proposes several tokens; the target verifies them in one pass. | Exact | BLIS: `spec-decoding`, `calib-8b-h100-spec` | [Leviathan et al., ICML 2023](https://arxiv.org/abs/2211.17192) |
| [Routing](src/sim/routing/) | Round robin | Rotate through pods regardless of load or cache. | Exact | BLIS: `routing-round-robin`, `routing-prefix-vs-round-robin` | [Envoy docs, load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) |
| [Routing](src/sim/routing/) | Least loaded | Send to the pod with the fewest requests in flight. | Simplified | BLIS: `routing-least-loaded` | [Envoy docs, load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) |
| [Routing](src/sim/routing/) | Prefix-cache aware | Weighted score of cached prefix, KV utilisation and queue depth, as in llm-d. | Structural | BLIS: 4 scenarios | [llm-d docs, router scheduling](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/scheduling.md); [Gateway API Inference Extension](https://github.com/kubernetes-sigs/gateway-api-inference-extension) |
| [Prefill/decode disaggregation](src/sim/disaggregation/) | Decode-first with token threshold | Pick the decode pod first; use the prefill pool only when enough of the prompt is uncached there. | Structural | BLIS: `pd-disaggregation`, `calib-8b-h100-pd` | [llm-d docs, P/D disaggregation](https://github.com/llm-d/llm-d/blob/main/docs/architecture/disaggregation/pd-disaggregation.md); [Zhong et al., OSDI 2024](https://arxiv.org/abs/2401.09670); [Patel et al., ISCA 2024](https://arxiv.org/abs/2311.18677) |
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
**BLIS** (commit `c79c7456`): median deviation 3.1% over 46 comparisons, 28 of them within 5%.

| Group | Comparisons | Median deviation | Largest deviation | Within 1% | Within 5% | Within 10% | Within 25% |
|---|---|---|---|---|---|---|---|
| Capacity and KV accounting | 2 | 0.02% | 0.04% | 2 | 2 | 2 | 2 |
| Decisions | 12 | 0% | 75.0% | 10 | 10 | 10 | 10 |
| Timings and rates (fitted, held out) | 24 | 4.0% | 39.1% | 8 | 15 | 19 | 23 |
| Directional effects | 8 | 15.8% | unbounded | 1 | 1 | 3 | 5 |
| **All** | 46 | 3.1% | unbounded | 21 | 28 | 34 | 40 |

Counting checks instead: 40 of 46 checks agree (87.0 percent), 6 known differences; 21 of the 27 approaches in the table above are covered by at least one of its scenarios.

| Kind of check | What must hold | Checks | Agree | Known difference |
|---|---|---|---|---|
| Exact | Decisions and discrete counts are equal (the pod chosen, cached prefix tokens, which requests are shed or preempted) | 12 | 10 | 2 |
| Capacity | KV blocks per replica within 0.1%: both sides derive them from estimates | 2 | 2 | 0 |
| Calibrated | A timing or rate is within the tolerance written in the scenario | 24 | 22 | 2 |
| Directional | The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling) | 8 | 6 | 2 |
| **All** | | **46** | **40** | **6** |

Every check that does not hold as written (the scenario files carry the full reasons, [the parity page](docs/parity.md) the numbers):

| Compared | Ours | Reference | Deviation | Missed | Cause |
|---|---|---|---|---|---|
| `autoscale-overload`: mean time to first token, fixed to autoscaled | 8.3% of baseline | 40% of baseline | ratio 0.206 | effect ratio 0.33 to 3 (different by design) | The autoscalers follow different rules and reach different sizes |
| `routing-round-robin`: pod chosen per request | per request | per request | 8 of 12 differ (67%) | different by design | llm-d picks at random among tied pods; the model rotates strictly, as Envoy does |
| `routing-round-robin`: requests per pod | 3/3/3/3 | 4/4/3/1 | 3 of 4 differ (75%); largest 200% | different by design | Same cause: random choice among tied pods against strict rotation |
| `tiers-offload`: host-tier hit rate, gpu-only to with-dram | 49.8% | 0.0% | unbounded (reference effect is zero), direction differs | effect ratio 0.67 to 1.5 | The reference reports a zero host-tier hit counter although the tier works (its counter, not the behaviour) |
| `timing-8b-h100-burst`: mean time to first token | 759 ms | 545 ms | +39.1% | 30% | One compute-efficiency factor cannot follow the reference's prefill cost curve |
| `timing-8b-h100-burst`: throughput | 1,678 tok/s | 1,870 tok/s | -10.3% | 10% | Same prefill cost curve, seen from the throughput side |

**Measured vLLM** (revision `49df63f2`): median timing deviation 73.3% over 20 comparisons with the site's default parameters, 8.1% over 20 comparisons on held-out requests after fitting.

| Group | Comparisons | Median deviation | Largest deviation | Within 1% | Within 5% | Within 10% | Within 25% |
|---|---|---|---|---|---|---|---|
| Capacity and KV accounting | 2 | 6.7% | 12.1% | 0 | 1 | 1 | 2 |
| Decisions | 1 | 0% | 0% | 1 | 1 | 1 | 1 |
| Timings, default parameters (no fit) | 20 | 73.3% | 135.5% | 0 | 0 | 0 | 0 |
| Timings and rates (fitted, held out) | 20 | 8.1% | 31.9% | 0 | 3 | 15 | 19 |

Counting checks instead: 20 of 43 checks agree (46.5 percent), 23 known differences; 8 of the 27 approaches in the table above are covered by at least one of its scenarios.

| Kind of check | What must hold | Checks | Agree | Known difference |
|---|---|---|---|---|
| Exact | Decisions and discrete counts are equal (the pod chosen, cached prefix tokens, which requests are shed or preempted) | 1 | 1 | 0 |
| Capacity | KV blocks per replica within 0.1%: both sides derive them from estimates | 2 | 0 | 2 |
| Calibrated | A timing or rate is within the tolerance written in the scenario | 40 | 19 | 21 |
| Directional | The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling) | 0 | 0 | 0 |
| **All** | | **43** | **20** | **23** |

Every check that does not hold as written (the scenario files carry the full reasons, [the parity page](docs/parity.md) the numbers):

| Compared | Ours | Reference | Deviation | Missed | Cause |
|---|---|---|---|---|---|
| `measured-8b-rtx-4090`: KV blocks per replica | 2,274 blocks | 2,588 blocks | -12.1% | 0.1% | The activation and graph terms of the model's memory budget are not the real engine's |
| `measured-8b-rtx-4090`: mean time to first token | 135.1 s | 65.49 s | +106.3% | 30% | Queue wait compounds the slower service rate: the engine is saturated from the first requests |
| `measured-8b-rtx-4090`: median time to first token | 130.2 s | 60.13 s | +116.5% | 30% | Queue wait compounds the slower service rate: the engine is saturated from the first requests |
| `measured-8b-rtx-4090`: 99th percentile time to first token | 274.1 s | 137.4 s | +99.5% | 30% | Queue wait compounds the slower service rate: the engine is saturated from the first requests |
| `measured-8b-rtx-4090`: mean time per output token | 51 ms | 32 ms | +58.3% | 12% | The model's decode step is slower than the real engine's at default parameters, and the fit goes to a bound |
| `measured-8b-rtx-4090`: median time per output token | 49 ms | 31 ms | +60.1% | 12% | The model's decode step is slower than the real engine's at default parameters, and the fit goes to a bound |
| `measured-8b-rtx-4090`: 99th percentile time per output token | 87 ms | 56 ms | +54.5% | 20% | The model's decode step is slower than the real engine's at default parameters, and the fit goes to a bound |
| `measured-8b-rtx-4090`: mean end-to-end time | 168.6 s | 86.61 s | +94.7% | 15% | End-to-end time is the queue wait plus a decode that is over half again too slow |
| `measured-8b-rtx-4090`: median end-to-end time | 161.6 s | 83.42 s | +93.7% | 15% | End-to-end time is the queue wait plus a decode that is over half again too slow |
| `measured-8b-rtx-4090`: 99th percentile end-to-end time | 301.4 s | 153.6 s | +96.2% | 20% | End-to-end time is the queue wait plus a decode that is over half again too slow |
| `measured-8b-rtx-4090`: throughput | 590 tok/s | 1,066 tok/s | -44.7% | 10% | Throughput follows the slower service rate |
| `measured-8b-rtx-4090`: 99th percentile time per output token | 38 ms | 55 ms | -31.9% | 20% | The real run has a heavier tail of per-token time than the model reproduces; not explained |
| `measured-8b-rtx-pro-6000`: KV blocks per replica | 36,174 blocks | 36,649 blocks | -1.3% | 0.1% | The activation and graph terms of the model's memory budget are not the real engine's |
| `measured-8b-rtx-pro-6000`: mean time to first token | 14.58 s | 6,520 ms | +123.8% | 30% | Queue wait compounds the slower service rate: the engine is saturated after the first 100 requests |
| `measured-8b-rtx-pro-6000`: median time to first token | 19.7 s | 8,370 ms | +135.5% | 30% | Queue wait compounds the slower service rate: the engine is saturated after the first 100 requests |
| `measured-8b-rtx-pro-6000`: 99th percentile time to first token | 39.75 s | 18.39 s | +116.2% | 30% | Queue wait compounds the slower service rate: the engine is saturated after the first 100 requests |
| `measured-8b-rtx-pro-6000`: mean time per output token | 48 ms | 31 ms | +51.0% | 12% | The model's decode step is slower than the real engine's at default parameters, and the fit goes to a bound |
| `measured-8b-rtx-pro-6000`: median time per output token | 49 ms | 33 ms | +50.9% | 12% | The model's decode step is slower than the real engine's at default parameters, and the fit goes to a bound |
| `measured-8b-rtx-pro-6000`: 99th percentile time per output token | 53 ms | 36 ms | +45.9% | 20% | The model's decode step is slower than the real engine's at default parameters, and the fit goes to a bound |
| `measured-8b-rtx-pro-6000`: mean end-to-end time | 45.48 s | 26.95 s | +68.8% | 15% | End-to-end time is the queue wait plus a decode that is half again too slow |
| `measured-8b-rtx-pro-6000`: median end-to-end time | 49.25 s | 28.36 s | +73.7% | 15% | End-to-end time is the queue wait plus a decode that is half again too slow |
| `measured-8b-rtx-pro-6000`: 99th percentile end-to-end time | 62.34 s | 36.06 s | +72.8% | 20% | End-to-end time is the queue wait plus a decode that is half again too slow |
| `measured-8b-rtx-pro-6000`: throughput | 2,067 tok/s | 3,068 tok/s | -32.6% | 10% | Throughput follows the slower service rate |

6 of the 27 approaches have no counterpart in any reference and are counted neither way; regenerate with `pnpm conformance:summary && pnpm docs:sync`.
<!-- generated:parity-readme:end -->

In short, against BLIS: median deviation 3.1% over 46 comparisons, 28 of them within 5%; 40 of 46 checks agree (87.0 percent) as written. Against measured vLLM (real runs of 300 ShareGPT requests on one RTX PRO 6000 and one RTX 4090): median timing deviation 73.3% over 20 comparisons with the site's default parameters, 8.1% over 20 comparisons on held-out requests after fitting; 20 of 43 checks agree (46.5 percent). Out of the box the model's decode step is 50 to 60 percent slower than the real engines', so under this saturating load queue waits roughly double and throughput is 33 to 45 percent low; after fitting four timing parameters to the first 100 requests the other 200 are within 14 percent on time to first token (RTX PRO 6000) and within 11 percent on mean time per token, except the RTX 4090's 99th-percentile time per token (-32%); the KV pool sizes differ by 1.3 percent and 12.1 percent (the model's activation term, below). Two readings, never pooled. Against LLMServingSim (run on the same two measured workloads and on constructed scenarios on the RTX PRO 6000: prefix cache, preemption, round robin, `max_num_seqs`, host tier, prefill/decode, speculative decoding, held-out timing): median timing deviation 65.4% over 32 comparisons with the site's default parameters, 5.4% over 32 comparisons on held-out requests after fitting; 44 of 81 checks agree (54.3 percent). The decisions agree (cached prefix tokens per follow-up, the preemption count, round robin placement: 6 of 7 exact checks, the one miss being the RTX 4090's preemption count, 184 against 191); the default-parameter timings miss by the same 50 to 60 percent decode step; after fitting to LLMServingSim's calibration scenarios held-out loads are within 29 percent on time to first token and within 5 percent on time per token. Where both it and the measurement cover a check (43), they agree with each other and the model is outside both for 22; they disagree on one, the KV pool (36,649 measured, 37,090 in LLMServingSim, which sets nothing aside for activations; 36,174 in the model). Two of its features are compared as effects, not times (its time to first token in a prefill/decode split ends before the hand-over, so that effect has the opposite direction). BLIS's six that do not hold are in the table above: round robin (Envoy's strict rotation against llm-d's random choice among tied pods, two checks); time to first token and throughput when 32 requests arrive at one instant, where one compute-efficiency factor cannot follow BLIS's prefill cost; the host-memory tier's hit-rate counter, which BLIS reports as zero; and how far queue wait falls under autoscaling, because the two autoscalers follow different rules. KV blocks per replica, which differ by 2 in about 28,000 and by 30 in about 75,000, used to be recorded as differences; since 2026-11-16 they are checked within 0.1% (see [the parity page](docs/parity.md)).

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
