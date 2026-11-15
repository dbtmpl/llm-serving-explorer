# ADR 0007: A calibrated mode replays BLIS runs of fixed scenarios, at request level

## Status

Accepted (2026-11-15). Implements phase 5 of [the BLIS plan](../blis-conformance-plan.md). Builds on [ADR 0004](0004-live-graph-view.md), [ADR 0005](0005-remove-blis-replay.md) and [ADR 0006](0006-modular-simulation-with-citations.md).

## Context

The site's graph is driven by a teaching model (`src/sim/`). The conformance suite checks that model against [BLIS](https://github.com/inference-sim/inference-sim), which embeds the llm-d router's own scoring code and a Go translation of vLLM's scheduler, but a visitor cannot see BLIS itself. ADR 0005 removed the old BLIS replay app because it needed a patched submodule, an event schema and a WebAssembly build. The plan accepted on 2026-11-15 asks for a second mode on the same graph that replays BLIS runs, without any change to BLIS.

What the pinned BLIS gives without a patch: per request, the arrival time, TTFT, end-to-end time, scheduling delay, time held at the router, cached prefix tokens, pod and fate (the Result's `request_rows`); per pod, a time series of KV usage and running and waiting requests (`server_series`); a count of preemptions; and, in its trace log (`--log trace`), every router plugin's score for every pod at every routing decision. It has no event stream: nothing says which block was allocated, which step ran or when a request was preempted.

## Decision

- **A second mode, "Calibrated (BLIS replay)", beside the architecture selector.** It replays one of four fixed scenarios: follow-up turns across four pods, overload with queueing and shedding, KV pressure with a preemption, and steady chat on Llama 3.1 70B. Settings are read-only; switching mode or scenario restarts the animation. A badge names the BLIS commit (short hash, linked to the commit on GitHub) for as long as a replay is shown.
- **A run interface.** `src/live/run.ts` defines `Run`: a `kind`, a `detail` (`blocks` or `aggregate`), the `world` to draw and `advance(dt)`. The canvas, the stats bar and the generic parts of the interface are typed against `RunWorld`, the part of `World` they read. The live model implements it with `exploreRun`, the replay with `ReplayRun` (`src/replay/adapter.ts`). Explore mode behaves as before.
- **Replay files are generated, committed and small.** `pnpm replay:build` (needs `BLIS_BIN`) runs the commit in `conformance/blis.lock` through the conformance translator and writes `public/replay/<id>.json`: the scenario's parameters, the commit, one record per request and the per-pod series. The four files total about 50 KiB, so they are served as plain JSON (GitHub Pages compresses them on the wire). A test checks the schema and that every file names the locked commit. The generator refuses a run that does not show what its scenario is for, and checks that the pod BLIS chose has the highest weighted router score before it writes anything.
- **Request level first.** The adapter turns the file into a world over time: a request appears, reaches the router at its arrival, is sent to BLIS's pod at the time BLIS sent it, waits, produces a first token and a last token at BLIS's times, and finishes or is shed as BLIS reports. Tests check that the first and last token times and the routed pod equal the file's. Step-through, explain boxes and the tour stay in Explore: they narrate the TypeScript model.
- **No change to BLIS and a thin dependency.** The generator imports the scenario format, the translator and the lock reader from `conformance/`; nothing under `src/` imports from there. The text of the mode is in `src/content/replay.md`, and the descriptions quote numbers computed from the file.

## What the replay can show

Arrival, routed pod and the router's per-plugin scores for each decision; time held at the router; time waiting in a pod's queue; first token and last token per request, and so TTFT and TPOT; cached prefix tokens; shedding at the router; the preemption count and, for the KV-pressure scenario, the interval of each preemption; each pod's KV pool use and its running and waiting counts over time.

## What it cannot show, and where it could mislead

- **No per-block KV map, forward-pass sweep, roofline dot, memory tier or conversation store.** BLIS emits no step-level events. A pod shows how full its KV pool is, as one bar. A note on each pod says so.
- **Tokens are spaced evenly** between the first and the last token BLIS reports; BLIS does not give every token's time. A preempted request pauses for the interval during which it waited.
- **Preemption time is derived.** BLIS counts preemptions but does not time them; the replay finds the moment from the step in the pod's waiting-request series, to within one series bin (0.5 s), and assigns it to the newest running request, which is vLLM's rule. A request preempted twice, or two preemptions inside one bin, could be placed wrongly; the generator refuses to write the KV-pressure file unless it can place every preemption from the series.
- **Shed time is derived.** BLIS reports that a request was dropped for waiting too long, not when; the replay shows it leaving the router at its arrival plus the queue deadline.
- **Presentation hops.** The 0.3 s a request takes from its session to the router is drawn just before BLIS's arrival time, and the 0.12 s from the router to the pod just after the dispatch time, never past the time BLIS scheduled the request. BLIS models neither trip.
- **Memory box.** The weights, activations and headroom of a GPU's memory box come from the TypeScript model; only the KV pool size is BLIS's, so the hover explanations of the memory box are off in this mode.
- **Preempted requests have no first scheduling time.** BLIS reports the last scheduling, so for a request that was preempted the replay shows no waiting before its first prefill.
- **BLIS is a simulator.** Its engine step times come from fitted coefficients, its router sees metrics that BLIS generates, and the scenarios are small and constructed. A replay is the best evidence the site has for how llm-d and vLLM schedule, not a measurement of a live cluster.

## Why request level first

The alternative, a block-level replay, needs an event stream (`--events-output`) that upstream does not have; ADR 0005 recorded what building and patching one cost. Request-level data needs no patch and is already enough to show the things BLIS is good evidence for: routing, queueing, shedding, preemption counts and latency. The adapter feeds the same `Run` interface, so a step-level replay can replace the aggregate pod later without changing the canvas contract.

## Consequences

- The site has two sources of truth for one graph; the badge and the `Run` kind keep them apart, and the content states what each is evidence for.
- Bumping `conformance/blis.lock` makes the committed replay files stale: the test names the mismatch, and `pnpm replay:build` regenerates them.
- The router's per-endpoint scores are read from BLIS's trace log, which is not a stable interface. If a later BLIS changes that log, the generator fails (it checks the chosen pod against the scores) and does not write a file.
