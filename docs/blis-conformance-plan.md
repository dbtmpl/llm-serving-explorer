# Plan: the TypeScript model and BLIS side by side

Status: accepted; phases 1 to 4 done, phases 5 and 6 not started. Written 2026-11-15 against inference-sim `c79c7456` (2026-11-13). What agreement shows, and the results, are in [`blis-parity.md`](blis-parity.md).

## Goal

1. Every mechanism of the TypeScript model that BLIS also models is checked against BLIS in CI, so a pull request cannot silently drift from llm-d and vLLM behaviour.
2. The site offers two modes on the same graph: the TypeScript model for free exploration, and a "calibrated" mode that replays BLIS runs of fixed scenarios.

[BLIS](https://github.com/inference-sim/inference-sim) embeds the real llm-d router and a Go translation of vLLM's scheduler that is diff-tested against vLLM. Agreement with it is strong evidence for routing, flow control and engine scheduling. It is not proof against a live cluster, and the docs must say so.

## What was verified in the BLIS checkout

Measured on this machine, not assumed:

| Fact | Consequence |
|---|---|
| `go build` takes about 7 s with Go 1.27; runs are deterministic for a seed | Cheap enough to run in CI on every pull request if wanted |
| `blis replay` reads a trace CSV (arrival time, session, round, prefix length, input and output tokens) | Both simulators can be fed the same requests |
| `blis run --trace-output` writes the same CSV with `first_chunk_time_us` and `last_chunk_time_us` per request | Per-request TTFT and end-to-end time need no patch |
| The Result JSON has TTFT, TPOT and end-to-end percentiles, throughput, request fates, prefix-cache hit rate, CPU-tier hit rate, preemptions, KV capacity per replica, step intervals, per-instance request counts | Aggregate checks need no patch |
| `--trace-level decisions` records the router's score for every endpoint on every routing decision | Routing can be compared decision by decision |
| Upstream now models tiered KV offload (host DRAM, NVMe, remote object storage), prefill/decode pools with KV transfer, speculative decoding, flow control and an autoscaler loop | Most of what ADR 0004 listed as missing in the old pin now has a counterpart |
| No event stream (`--events-output`), no WebAssembly target and no stepping interface exist upstream | The calibrated mode cannot be interactive; step-level replay still needs an upstream change |
| The catalog has `llama-3.1-8b-instruct`, `llama-3.1-70b-instruct`, H100, H200, B200. It has no MI300X and no Llama 3 70B (done: the entry is now Llama 3.1 70B) | Conformance scenarios use the shared subset; the site's 70B entry should become Llama 3.1 70B (same architecture) |

## Coverage: which concept is checked how

Three kinds of check, strictest first:

- **Exact**: integers and decisions that must be equal (blocks per request, cached prefix tokens, chosen pod, request fate).
- **Calibrated**: timings. The TypeScript cost model is a roofline with two efficiency factors (MBU, MFU) and a host-time term; BLIS prices steps with fitted coefficients. Fit those three parameters per model and GPU on a calibration set, then check TTFT, TPOT and throughput on held-out scenarios within a stated tolerance.
- **Directional**: the same intervention moves the same metric in the same direction by a similar factor in both (prefix-aware routing against round robin on follow-up turns, and so on).

| Concept (`src/sim/…`) | BLIS counterpart | Check |
|---|---|---|
| `kvcache/blocks`, `cost/memory` | KV block budget per replica, blocks per request | Exact |
| `kvcache/prefix` | Block-aligned prefix cache, `cache_hit_rate` | Exact on cached tokens per request |
| `batching/continuous`, step scheduling | vLLM scheduler: decode first, chunked prefill under `max_num_batched_tokens` | Exact on admissions per step for small cases; calibrated on step interval |
| `admission/onDemand`, `kvcache/preemption` | vLLM allocation and preemption (newest first) | Exact on preemption counts in a constructed overflow case |
| `routing/prefixAware` | llm-d scorers at weights 3 / 2 / 2 | Exact on chosen pod per request with tiers off; directional with tiers on (our tier weighting is our own) |
| `routing/leastLoaded`, `routing/roundRobin` | Router configurations in BLIS | Exact on per-pod request counts |
| `flowcontrol` | llm-d flow control, `gateway_expired` fate | Exact on which requests are shed |
| `disaggregation` | Prefill and decode pools, `pd_transfer` | Exact on the prefill-pool decision; calibrated on transfer time |
| `kvcache/tiers`, `eviction`, `reload` | `kv_offload` tiers, LRU by chunk | Directional. BLIS evicts chunks, we evict whole sessions; hit rates are compared, not block traces |
| `decoding/speculative` | `speculative` engine block with an acceptance rate | Calibrated on tokens per step and TPOT |
| `cost/roofline`, `cost/throughput`, `cost/host` | Latency kernel | Calibrated |
| `autoscaling` | Workload-variant autoscaler loop | Directional only; the rules differ by design |
| `batching/static`, `admission/wholePrompt`, `admission/reserveToCompletion` | None (vLLM does neither) | Not verifiable; the registry states the reason |
| `workload` | Trace replay | Not a check: it is how both get the same input |

## Layout

Consistent with ADR 0006: `src/sim/` stays free of anything BLIS-specific except one new workload approach.

| Path | Role |
|---|---|
| `src/sim/workload/trace.ts` | New workload approach: inject requests from a list instead of generating sessions |
| `src/sim/approach.ts` | `ApproachMeta` gains `verification`: the conformance scenario ids that check it, or the reason BLIS cannot |
| `conformance/scenarios/<id>.yaml` | One neutral scenario per check: model, GPU, engine settings, routing, tiers, the request list or its generator seed, the checks to run and their tolerances |
| `conformance/translate/` | Scenario → TypeScript `Params` and trace; scenario → BLIS Scenario + Deployment YAML, router config, offload config and trace CSV |
| `conformance/run/` | Runs the TypeScript model headless; reduces either simulator's output to one comparable record (per-request rows plus aggregates) |
| `conformance/reference/<id>.json` | Committed, reduced BLIS records, with the BLIS commit and data hashes they came from |
| `conformance/calibration/` | Fitted MBU, MFU and host-time values per model and GPU, with the fit residuals |
| `conformance/blis.lock` | The pinned inference-sim commit. No submodule: CI clones that commit and builds it |
| `conformance/__tests__/` | Vitest suite comparing TypeScript output with the references |
| `src/replay/` | Later: adapter that drives the same `Scene` from a BLIS record |
| `public/replay/<id>.json.gz` | Later: replay files for the site, generated from the pinned BLIS |

The registry test gains one rule: every approach names at least one scenario or a reason. `pnpm docs:sync` adds a "verified against BLIS" column to the README tables from that field.

## CI

| Job | When | Needs | Does |
|---|---|---|---|
| `conformance` | Every pull request | Node only | Runs the TypeScript model on each scenario and compares with `conformance/reference/` |
| `blis-references` | Nightly, and when `blis.lock`, a scenario, a translator or the model changes | Go | Builds the pinned BLIS, regenerates the references, refits the timing parameters and rebuilds the summary, fails if any differs from the committed one |
| `blis-upstream` | Weekly, allowed to fail | Go | Same against upstream `main`, to see drift before bumping the pin (`.github/workflows/blis-upstream.yml`) |

Tolerances are written into each scenario with a one-line justification before the first run. A failing check is fixed in the model or recorded as a known difference with a reason; a tolerance is never widened to make a test pass without that record.

## The calibrated mode on the site

Two levels, and only the second needs upstream:

1. **Request-level replay, no patch.** Arrival, routed pod, first token and last token per request come from the trace output and the decision trace; KV usage and running/waiting counts per engine come from the server series. Enough to animate routing, queueing, TTFT and streaming with BLIS's numbers. Step-level detail (which blocks, which step) is absent, so the pod's inside is drawn from the series, not per block.
2. **Step-level replay.** Needs the event stream proposed upstream (`--events-output`). The same adapter then feeds block-level events.

In both, parameters are fixed per scenario: the menus are read-only, and switching mode restarts the animation. The mode toggle sits beside the architecture selector; each BLIS scenario states the BLIS commit it was generated from.

## Phases

1. **Shared input and exact checks.** Done. Trace workload, scenario format, translators, BLIS runner, reducer. Scenarios for KV budget, prefix cache, routing (three policies), preemption, shedding.
2. **Calibration.** Done. `conformance/calibration/` fits MBU, MFU and the two host-time coefficients per model and GPU (`pnpm conformance:calibrate`, deterministic, documented loss and search), plus the draft cost and the link rate; held-out timing scenarios check time to first token, time per token, end-to-end time and throughput; speculative decoding and the prefill/decode split are checked the same way. Time to first token is the weak spot: a single MFU cannot follow BLIS's prefill cost, and a 32-request burst is recorded as a known difference.
3. **Registry and docs.** Done. `ApproachMeta.verification` (scenario ids, or `{ notVerifiable }`), the enforcing test, the README column, the parity summary (`conformance/summary.json`, `pnpm conformance:summary`, kept in step by a test) and [`blis-parity.md`](blis-parity.md).
4. **Directional checks.** Done, with a different scenario shape than first planned: a scenario can have `arms`. Tiers (host memory only), eviction pressure, prefix-aware routing against round robin and autoscaling. BLIS's autoscaler runs only under `blis run`, so that scenario is a constant-rate stream.
5. **Scene interface and request-level calibrated mode.** Not started. Extract what `Scene` needs from `World` into an interface both the live model and the replay adapter implement.
6. **Upstream.** Not started. Propose `--events-output`; step-level replay when it lands.

Phase 1 found real differences (the router sees exact pod state while llm-d scores from scraped metrics with a delay; round robin; KV budget). Each became either a fix or a documented difference, and so did those of phases 2 to 4.

## Decisions

Accepted by the owner on 2026-11-15.

| Decision | Outcome |
|---|---|
| How to pin BLIS | A lock file with a commit, cloned in CI. A submodule was the maintenance cost ADR 0005 removed |
| Site catalog | Rename the 70B entry to Llama 3.1 70B so it matches BLIS's catalog; keep MI300X as "not verifiable" |
| Run BLIS on pull requests too | No at first: committed references keep pull-request CI Node-only; the nightly job catches stale references |
| Scope of the first calibrated mode | Request-level, without waiting for upstream |
