# ADR 0004: A live graph view, driven by an in-browser model, is the landing page

## Status

Accepted (2026-11-14). Amended by [ADR 0005](0005-remove-blis-replay.md), which removed the BLIS replay app this record refers to.

## Context

The first version replayed BLIS event files in eleven tabbed views. Readers needed one view instead: a single animated graph (request, tokenizer, router, pods, GPUs) that starts empty and grows, runs in slow motion, lets the viewer change components and hyperparameters while requests are in flight, shows KV blocks moving HBM to DRAM to SSD, and teaches FLOPs, bytes, roofline, memory budget, the engine step loop, host time.

Three of those needs cannot be met by replaying a finished BLIS run:

- Parameters changed mid-run. A replay is fixed; BLIS-in-WASM (27 MB) can only restart a run.
- An SSD tier. `blis-vllm` v0.32.0 models HBM and host DRAM only (ADR 0001).
- Tokenisation, host time per step and CPU/GPU overlap, which BLIS does not emit.

## Decision

The landing page (`src/live/`, at the time `web/src/live/`) runs its own small simulation in the browser:

- `model.ts`: the closed-form quantities (2N FLOPs, attention term, KV bytes per token, four-pool memory budget, roofline step time, throughput curve). Unit tests check them against worked numbers.
- `sim.ts`: sessions, front-end hops, router policies, autoscaler, pod lifecycle, the decode-first engine step with a token budget, paged KV blocks, prefix reuse, LRU eviction through HBM, DRAM and SSD, and preemption by recomputation.
- `render.ts`, `LiveView.tsx`, `Inspector.tsx`, `callouts.ts`: one canvas graph, floating menus, event-driven callouts and a dive-in panel.

The BLIS replay app is unchanged and reachable at `classic.html` ("BLIS replay" link).

## Consequences

- The landing page is a teaching model, not a calibrated simulator. It is exact where closed forms exist (bytes, FLOPs, memory budget) and illustrative elsewhere: host time per step, DRAM and SSD transfer rates, front-end hop times, cold-start time, and MBU/MFU are parameters, not measurements.
- KV tiering below HBM is shown as an offloading layer would do it. vLLM V1 itself recomputes after preemption.
- Two models of the same stack now live in the repo. Numbers on the landing page will not match a BLIS run of the "same" scenario. If that becomes confusing, the next step is to drive the same graph from BLIS events in a replay mode.

## Addendum (2026-11-14): hops, conversation store and a shared KV pool

The first cut showed HBM → DRAM → SSD → dropped. The model now goes further:

- **Hops.** The graph is ordered as the canonical turn: gateway and prompt assembly (hops 1 and 2), router (hop 3), admission and execution on the pod (hops 4 and 5), streaming back (hop 6). The earlier "tokenizer before gateway" order was wrong.
- **Conversation store.** The text of every turn is the system of record; every KV tier is a derived copy. History is read from it on each turn and the finished turn is appended. A session whose KV is gone from every tier is prefilled again from text.
- **Remote pool.** A fourth tier below SSD, shared by all pods over the network. It is the only tier that survives a pod scale-down and the only one another pod can load from.
- **Whole-session eviction, least recently used first** (CachedAttention's granularity).
- **Adaptive loading.** A copy is loaded back only when that is faster than recomputing it, per LMCache's finding that loading "should be adaptive".

Still left out, and said so in the dive-in panel: layer-wise overlap of loads with compute, prefetch at routing time, chunk- or page-level eviction (Pensieve, HiCache), TTL-based demotion, write-back at end of turn, and prefill/decode disaggregation. Tier transfer rates remain illustrative constants.
