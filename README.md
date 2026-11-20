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

LLM Serving Explorer is an animated, interactive explanation of how an inference stack serves requests. One graph grows as requests arrive: text becomes tokens, the router picks a pod, the engine batches work step by step, and KV-cache blocks fill, move and are evicted. Everything runs in slow motion in the browser, with a short note next to each event.

- **Explore** runs a TypeScript model of vLLM's scheduling and memory (continuous batching, chunked prefill, paged KV blocks, prefix caching, preemption) and llm-d's routing, flow control and prefill/decode split. Change the model, hardware and policies while requests are in flight.
- **Calibrated** replays fixed scenarios recorded with [BLIS](https://github.com/inference-sim/inference-sim), a simulator that runs the [llm-d](https://github.com/llm-d/llm-d) router's code in front of a Go translation of [vLLM](https://github.com/vllm-project/vllm)'s scheduler.

The model runs no vLLM or llm-d code. Every push compares it with three references ([parity, in full](conformance/README.md#parity-with-blis-llm-d-and-vllm)):

- **BLIS:** median deviation 2.2% over 46 comparisons, 30 of them within 5%; 39 of 46 checks agree (84.8 percent).
- **Measured vLLM** (300 ShareGPT requests on an RTX PRO 6000 and an RTX 4090): median timing deviation 10.8% over 20 comparisons with the site's default parameters, 2.7% over 28 comparisons on held-out requests after fitting; 44 of 51 checks agree (86.3 percent).
- **[LLMServingSim](https://github.com/casys-kaist/LLMServingSim)**, a second port of vLLM's scheduler: median timing deviation 10.7% over 32 comparisons with the site's default parameters, 2.8% over 40 comparisons on held-out requests after fitting; 72 of 89 checks agree (80.9 percent).

BLIS and LLMServingSim are simulators, and the measurements cover one model and one workload on two GPUs, so absolute timings are indicative.

<p align="center">
  <img alt="Demo: one request explained step by step in numbered notes, then ten on one pod, then a thousand at once with pods scaling up" src="docs/assets/demo.webp" width="100%">
</p>

<p align="center">
  <a href="docs/assets/demo.mp4">Watch the demo in full HD (1080p, 60 fps)</a>
</p>

## About

Throughput, latency and cost come from how the router, the scheduler and the memory hierarchy interact. Those interactions are hard to see in metrics or text; this project draws them.

**What you can watch**

- **Routing:** per-pod scores for prefix-cache affinity, queue depth and KV use, and what happens when affinity overloads one pod.
- **Continuous batching:** requests joining and leaving the batch at every engine step, prefill chunks and decode tokens sharing a step.
- **Paged KV cache and prefix caching:** GPU memory split into weights and KV blocks, blocks shared by requests with a common prefix.
- **Eviction and preemption:** what the engine gives up when memory runs out, and why overload turns into thrashing.
- **Memory tiers:** KV moving from GPU memory to host DRAM, SSD and a shared pool, and when loading it back beats recomputing.
- **Prefill/decode disaggregation:** separate pools with KV transfer between pods.
- **Roofline:** each step's arithmetic intensity against the GPU's compute and bandwidth limits.
- **Autoscaling:** pods created, loading weights, serving, draining and terminating.

**What you can change while it runs:** model, GPU and tensor parallelism; engine settings (`max_num_seqs`, token budget, admission rule, speculative decoding); routing, autoscaling and load shedding; tier sizes and session behaviour; and the serving architecture, from static batching to today's tiered, disaggregated stacks.

**How it explains**

- **Notes:** a short, numbered note beside each event, with a line to the part it explains; every note stays in the history. A button in the corner turns them off.
- **Tutorial:** a guided tour of each part of the graph.
- **Step-through:** follows one request from its first step and stops the clock at each event. Back and Next replay the animation; each step has a "Dive deeper" section with the theory and links to the papers.
- **Inspector:** click a pod, the router or a request for its numbers and the formulas behind them.
- **Calibrated mode:** four BLIS scenarios (follow-up turns under prefix-aware routing, overload with shedding, KV pressure with a preemption, steady 70B chat). Settings are read-only, and a pod's inside is drawn as totals because BLIS reports neither single blocks nor steps.

Every source on the site is a link. All of the site's text is markdown in [`src/content/`](src/content/).

## Getting Started

You need [Node.js](https://nodejs.org) 22+ and [pnpm](https://pnpm.io) 12+.

```bash
git clone https://github.com/dbtmpl/llm-serving-explorer.git
cd llm-serving-explorer
pnpm install
pnpm dev
```

Open the URL Vite prints and press **Send one request**. To build the static site:

```bash
pnpm build      # output in dist/
pnpm preview    # serve the build locally
```

The build is a static bundle that any static host can serve. For a subpath, set the base: `VITE_BASE_PATH="/llm-serving-explorer/" pnpm build`.

## What is modelled, and where it comes from

Every mechanism implements a published or deployed approach, lives in its own module, names its sources and is tested against them. The table is generated from the code. "Verified against" names the [conformance scenarios](conformance/README.md) that check an approach against each reference; [docs/parity.md](docs/parity.md) says what that agreement shows and lists every known difference.

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

**Fidelity:** *Exact* reproduces a published formula or rule and is tested against it. *Structural* follows the source's mechanism with our own constants, exposed as parameters. *Simplified* is a stand-in whose documentation says what it leaves out.

All sources are listed in [`src/sim/README.md`](src/sim/README.md#sources); each module's README says what it does not model.

## How accurate is it?

It is a teaching model: the mechanisms are meant to be right and the magnitudes plausible.

- **Exact where the sources are.** KV bytes per token, memory budgets, FLOPs, ridge points, roofline step times and speculative-decoding speed-ups are closed-form and tested against worked numbers.
- **Checked against references where they have the mechanism:** BLIS for llm-d and vLLM decisions, measured vLLM runs and LLMServingSim for timings and KV pool size. See [parity](conformance/README.md#parity-with-blis-llm-d-and-vllm).
- **Checked against source code where behaviour matters,** such as vLLM's preemption order, its rule of admitting nothing in a step that preempted, how it sizes the KV pool, and its default `max_num_seqs`.
- **Adjustable where sources give a range.** Host time per step, tier copy rates and utilisation factors are controls.
- **Deterministic.** A seed and a sequence of inputs always give the same event stream, pinned by tests.

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
| [`conformance/`](conformance/) | Scenarios, the three references, calibration, the parity results and the tests that compare the model with the references |
| [`e2e/`](e2e/) | Playwright end-to-end tests |
| [`docs/`](docs/) | Design choices, the parity page and architecture decision records |

The simulation does not depend on the interface and runs on its own:

```ts
import { DEFAULT_PARAMS, advance, createWorld, spawnBurst } from "./src/sim/index.js";

const world = createWorld({ ...DEFAULT_PARAMS, routing: "prefix-aware" });
spawnBurst(world, 100);   // 100 sessions arrive at once
advance(world, 30);       // 30 simulated seconds
console.log(world.m.completed, world.m.preemptions);
```

To model a new paper, add an approach to the module that owns the decision ([`src/sim/README.md`](src/sim/README.md)).

## Development

```bash
pnpm typecheck
pnpm test         # unit tests per simulation module, and the comparison with the references
pnpm test:e2e     # Playwright (first time: pnpm exec playwright install chromium)
pnpm docs:sync    # regenerate the generated tables in the READMEs and the parity page
```

Regenerating the references needs the pinned simulators; see [`conformance/README.md`](conformance/README.md). For BLIS (Go, and a build of the commit in `conformance/refs/blis/lock`):

```bash
BLIS_BIN=/path/to/blis pnpm conformance:reference   # BLIS output per scenario
pnpm conformance:calibrate                          # refit the timing parameters
pnpm conformance:summary                            # the parity figures
BLIS_BIN=/path/to/blis pnpm replay:build            # replay files for Calibrated mode
```

## Contributing

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and how model changes are sourced and tested, and [GLOSSARY.md](GLOSSARY.md) for terms. `main` changes only through pull requests that pass CI.

## License

[Apache-2.0](LICENSE)
