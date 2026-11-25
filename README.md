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
</p>

LLM Serving Explorer animates how an inference stack such as [vLLM](https://github.com/vllm-project/vllm) behind [llm-d](https://github.com/llm-d/llm-d) serves requests. One graph grows as requests arrive: text becomes tokens, the router picks a pod, the engine batches work step by step, and KV-cache blocks fill, move and are evicted. It runs in slow motion in the browser, with a short note beside each event, and you can change the model, hardware and policies while requests are in flight.

The simulation behind it is a TypeScript model of vLLM's scheduler and memory and of llm-d's router. Every push checks it against three references ([details](conformance/README.md#parity-with-blis-llm-d-and-vllm)):

- **[BLIS](https://github.com/inference-sim/inference-sim)**, which runs the llm-d router's code in front of a Go translation of vLLM's scheduler: median deviation 2.8% over 76 comparisons, 44 of them within 5% (previously 2.2% over 46 comparisons, 30 within 5%, at commit `c79c7456`).
- **Measured vLLM**, 300 ShareGPT requests on an RTX PRO 6000 and an RTX 4090: median timing deviation 10.8% over 20 comparisons with the site's default parameters, 2.7% over 28 comparisons on held-out requests after fitting.
- **[LLMServingSim](https://github.com/casys-kaist/LLMServingSim)**, a second port of vLLM's scheduler: median timing deviation 10.7% over 32 comparisons with the site's default parameters, 2.8% over 40 comparisons on held-out requests after fitting.

The measurements cover one model and one workload on two GPUs, so absolute timings are indicative. To watch BLIS itself, press **Switch to Calibrated BLIS Replay** in the bottom right corner of the app: it replays recorded BLIS runs of four scenarios on the same graph.

<p align="center">
  <img alt="Demo: one request explained in numbered notes, ten requests sharing one pod, then a thousand with pods scaling out" src="docs/assets/demo.webp" width="100%">
</p>

## What you can watch

- **Routing:** per-pod scores for prefix-cache affinity, queue depth and KV use, and what happens when affinity overloads one pod.
- **Continuous batching:** requests join and leave the batch at every engine step; prefill chunks and decode tokens share a step.
- **Paged KV cache and prefix caching:** GPU memory split into weights and KV blocks, with blocks shared by requests that have a common prefix.
- **Eviction and preemption:** what the engine gives up when memory runs out, and why overload turns into thrashing.
- **Memory tiers:** KV moving from GPU memory to host DRAM, SSD and a shared pool, and when loading it back is faster than recomputing it.
- **Prefill/decode disaggregation:** separate pools, with KV transferred between pods.
- **Roofline:** each step's arithmetic intensity against the GPU's compute and bandwidth limits.
- **Autoscaling:** pods start, load weights, serve, drain and terminate.

While it runs you can change the model, GPU and tensor parallelism; engine settings (`max_num_seqs`, token budget, admission rule, speculative decoding); routing, autoscaling and load shedding; tier sizes and session behaviour; and the serving architecture, from static batching to today's tiered, disaggregated stacks.

The app explains what happens in four ways:

- **Notes:** a numbered note beside each event, with a line to the part it explains. Every note goes to the history. The button in the corner turns notes off.
- **Tutorial:** a guided tour of each part of the graph.
- **Step-through:** follows one request and stops the clock at each event. Back and Next replay the animation, and each step has a "Dive deeper" section with the theory and links to the papers.
- **Inspector:** click a pod, the router or a request to see its numbers and the formulas behind them.

All text on the site is markdown in [`src/content/`](src/content/), and every source is a link.

## Getting started

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

## What is modelled

Each mechanism (routing, batching, KV admission, prefix reuse, eviction, tiers, preemption, decoding, disaggregation, autoscaling, flow control, workload) is a module in [`src/sim/`](src/sim/) that implements a published or deployed approach, names its sources and tests against them. [`src/sim/README.md`](src/sim/README.md#all-approaches) lists every approach with its fidelity, the scenarios that verify it and its sources; each module's README says what it leaves out.

## How accurate is it?

It is a teaching model: the mechanisms should be right and the magnitudes plausible.

- **Closed-form where the sources are.** KV bytes per token, memory budgets, FLOPs, ridge points, roofline step times and speculative-decoding speed-ups are tested against worked numbers.
- **Checked against the three references** where they have the mechanism: BLIS for llm-d and vLLM decisions; measured vLLM and LLMServingSim for timings and KV pool size.
- **Checked against vLLM's source** where behaviour matters: the preemption order, admitting nothing in a step that preempted, how the KV pool is sized and the default `max_num_seqs`.
- **Adjustable where sources give a range.** Host time per step, tier copy rates and utilisation factors are controls.
- **Deterministic.** A seed and a sequence of inputs always give the same event stream.

[`docs/design-choices.md`](docs/design-choices.md) lists, topic by topic, what the sources say, where they disagree and which reading the model takes.

## Project layout

| Path | Contents |
|---|---|
| [`src/sim/`](src/sim/) | The simulation: one module per concept (routing, batching, KV cache, ...), each with its own README, sources and tests |
| [`src/sim/citations.ts`](src/sim/citations.ts) | The registry of every paper, document and datasheet the model relies on |
| [`src/live/`](src/live/) | The user interface: canvas rendering, menus, inspector, tutorial and step-through |
| [`src/content/`](src/content/) | Every explanatory text on the site, as markdown |
| [`src/replay/`](src/replay/) | Calibrated mode: plays a BLIS replay file on the same graph |
| [`public/replay/`](public/replay/) | The replay files, generated from the pinned BLIS |
| [`conformance/`](conformance/) | Scenarios, the three references, calibration, the parity page and the tests that compare the model with them |
| [`e2e/`](e2e/) | Playwright end-to-end tests |
| [`docs/`](docs/) | Design choices and the demo |

The simulation does not depend on the interface and runs on its own:

```ts
import { DEFAULT_PARAMS, advance, createWorld, spawnBurst } from "./src/sim/index.js";

const world = createWorld({ ...DEFAULT_PARAMS, routing: "prefix-aware" });
spawnBurst(world, 100);   // 100 new sessions
advance(world, 30);       // 30 simulated seconds
console.log(world.m.completed, world.m.preemptions);
```

To model a new paper, add an approach to the module that owns the decision ([`src/sim/README.md`](src/sim/README.md)).

## Development

```bash
pnpm typecheck
pnpm test         # unit tests per simulation module, and the comparison with the references
pnpm test:e2e     # Playwright (first time: pnpm exec playwright install chromium)
pnpm docs:sync    # regenerate the generated tables and the parity page
```

Regenerating the references needs the pinned simulators; see [`conformance/README.md`](conformance/README.md). For BLIS (Go, and a build of the commit in `conformance/refs/blis/lock`):

```bash
BLIS_BIN=/path/to/blis pnpm conformance:reference   # BLIS output per scenario
pnpm conformance:calibrate                          # refit the timing parameters
pnpm conformance:summary                            # the parity figures
BLIS_BIN=/path/to/blis pnpm replay:build            # replay files for the calibrated replay
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and how model changes are sourced and tested, and [GLOSSARY.md](GLOSSARY.md) for terms. `main` changes only through pull requests that pass CI.

## License

[Apache-2.0](LICENSE)
