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

LLM Serving Explorer is an interactive, animated explanation of how a modern inference stack serves requests. A single graph starts empty and grows as requests arrive: text becomes tokens, the router picks a pod, the engine batches work step by step, and KV-cache blocks fill, move and get evicted on the GPU. It runs in slow motion in your browser, explains each event where it happens, and lets you change the model, hardware and policies while requests are in flight.

The simulation is an independent TypeScript model that runs entirely in the browser. It re-implements the scheduling and memory behaviour of [vLLM](https://github.com/vllm-project/vllm) (continuous batching, chunked prefill, paged KV blocks, block-level prefix caching, preemption by recompute) and the routing and prefill/decode design of [llm-d](https://github.com/llm-d/llm-d), as described in their documentation and, for key rules, checked against the vLLM source. Step times come from closed-form roofline formulas. It does not run vLLM or llm-d code and is not calibrated against a real deployment or a simulator, so the mechanisms follow the real systems while absolute numbers are indicative. See [How accurate is it?](#how-accurate-is-it)

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

A built-in tutorial walks through the graph, and a step-through mode follows one request and stops the clock at each event.

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

## How accurate is it?

The simulation is a teaching model, not a calibrated simulator. It aims to get the mechanisms and their orders of magnitude right.

- **Exact where the sources are exact.** KV bytes per token, memory budgets, FLOPs, ridge points and roofline step times are closed-form and unit-tested against published numbers.
- **Adjustable where they are not.** Host time per step, tier transfer rates and utilisation factors sit inside measured ranges and are exposed as controls.
- **Checked against source code where behaviour matters.** For example, vLLM's preemption order and its default `max_num_seqs`.

[docs/design-choices.md](docs/design-choices.md) lists, topic by topic, what the sources say, where they disagree and which reading the model takes.

## Project Layout

| Path | Contents |
|---|---|
| [`src/live/model.ts`](src/live/model.ts) | Closed-form quantities: FLOPs, KV bytes, memory budget, roofline |
| [`src/live/sim.ts`](src/live/sim.ts) | The simulation: sessions, router, autoscaler, engine step, KV blocks, tiers |
| [`src/live/render.ts`](src/live/render.ts) | Canvas rendering of the graph |
| [`src/live/`](src/live/) | UI: menus, inspector, tutorial, callouts and architecture presets |
| [`e2e/`](e2e/) | Playwright end-to-end tests |
| [`docs/`](docs/) | Design choices and architecture decision records |

## Development

```bash
pnpm typecheck
pnpm test         # unit tests
pnpm test:e2e     # Playwright (first time: pnpm exec playwright install chromium)
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and for how changes to the model should be sourced and tested. Terms are defined in [GLOSSARY.md](GLOSSARY.md).

## License

[Apache-2.0](LICENSE)
