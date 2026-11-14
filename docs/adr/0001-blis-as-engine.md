# ADR 0001: BLIS as the Simulation Engine

- **Status:** Accepted
- **Date:** 2026-11-14
- **Pinned BLIS commit:** `c79c745619b16a8019339e3bbc79ee5e2923b258` (`github.com/inference-sim/inference-sim`, `engine/` submodule)
- **Pinned stack versions (`engine/stack.json`):**
  - `blis-substrate`: `v0.14.0`
  - `blis-vllm`: `v0.32.0-blis.3` (models vLLM `0.32.0`, commit `5df63a7203cdb9328d824a27b682e77c7b9928be`, with v0.31.0 latency kernel pricing rules)
  - `llm-d-router`: `v1.0.0-blis.4` (models llm-d `1.0.0`, commit `b9393d1a9f1d5a72ecd86f8d2b643ab54c2a9b92`)

## Context

The visualizer must animate request routing, queueing, batching, KV cache block allocation/sharing/eviction, memory tier movement, preemption, prefill/decode disaggregation, tensor parallelism, and autoscaling without implementing any simulation logic in the browser.

Before building any UI, we ran a trial building and running BLIS on macOS (`darwin/arm64`, Go `go1.27.3`), running two example scenarios (`gpt-oss-120b-h100-fp4-vllm-tp2.yaml` and `glm-5-h200-3p1d-ib.yaml`) with `--trace-level decisions --counterfactual-k 4 --summarize-trace --server-series-interval-s 1.0`, and auditing `engine/sim/`, `engine/sim/cluster/`, `engine/sim/trace/`, `blis-vllm`, and `blis-substrate`.

## Trial Findings: Events Available vs. Missing

| Needed for the visualizer | Found in BLIS (`c79c7456`) | Gap & Resolution |
|---|---|---|
| Routing decisions with per-candidate scores | `sim/trace/record.go` (`RoutingRecord`, `CandidateScore`), `sim/cluster/gateway.go`, `--trace-level decisions --counterfactual-k` | Only stored in memory (`SimulationTrace`) and summarized under `reports.router.trace_summary`. Export via `EventSink` (`request.routed`). Note: `PrefillRoutingRecord.Scores` is nil in P/D mode (`PrefillRoutingRecord` records chosen instance without separate scores). |
| Admission, P/D disaggregation, KV transfer | `sim/trace/record.go` (`AdmissionRecord`, `DisaggregationRecord`, `PrefillRoutingRecord`, `KVTransferRecord`), `sim/cluster/pd_events.go` | Only stored in memory (`SimulationTrace`). Export via `EventSink` (`request.admitted`, `request.rejected`, `kv.transfer`). |
| KV block stored / removed (hash, parent, tier) & owner request | `blis-vllm` `core/kv/pool.go` & `core/vllm/engine.go` (`EnableKVEvents()`, `Result.KVEvents`), `EngineDriver.Snapshot()` (`KVBlocksTotal`, `KVBlocksUsed`, `KVBlockSize`), `engine.Batch.Reqs` (`Computed`, `Tokens`, `CachedTokens`, `PromptLen`) | `KVEvents` are only enabled when the router `WantsKVEvents()` and are not written to a file; `KVEvent` has no physical block ID or owner request ID. **Resolution without forking `blis-vllm`:** enable read-only `EnableKVEvents()` when `--events-output` is set, and track deterministic block ownership & block slots in `EngineDriver`'s `EventSink` from `Batch.Reqs`, `Result.Emitted`, `Batch.Preempted`, `Result.Finished`, `Result.KVEvents`, and `Snapshot()`, cross-checking `used`, `cached`, and `free` block counts against `Snapshot()` at every step. |
| Per-step engine state (waiting, running, batch membership, prefill/decode, preemptions) | `sim/engine_driver.go` (`EngineDriver.kick`, `EngineDriver.apply`, `engine.Batch`, `engine.Result`, `EngineMetrics`) | `EngineDriver` already receives every `Batch` (`Reqs`, `Preempted`, `TransfersStarted`, `Finished`), `StepTime(b)`, and `Result` (`Emitted`, `FirstTokens`, `Finished`), but does not stream them. Export via `EventSink` in `sim/engine_driver.go` (`request.queued`, `request.scheduled`, `request.prefill`, `request.decode_step`, `request.preempted`, `request.finished`, `request.timed_out`, `batch.step`). |
| Per-instance periodic snapshots | `sim/progress_hook.go` (`ProgressHook`, `InstanceSnapshot`, `ProgressSnapshot`) | Aggregates and per-instance snapshots exist in memory. Emit `metrics.snapshot` from `EventSink` for cross-checking replay state against BLIS counters. |
| Pod lifecycle & autoscaling | `sim/cluster/infra_lifecycle_event.go` (`NodeReadyEvent`, `InstanceLoadedEvent`), `sim/cluster/instance.go` (`TransitionTo`), `sim/cluster/autoscaler.go` (`ScalingTickEvent`, `ScaleActuationEvent`) | Lifecycle transitions (`Loading`, `WarmingUp`, `Active`, `Draining`, `Terminated`) are not exported. Export via `EventSink` (`pod.created`, `pod.loading`, `pod.ready`, `pod.draining`, `pod.terminated`). |
| Memory tiers (GPU, Host RAM, Local SSD, Remote Store) | `blis-vllm/vllmengine/vllmengine.go` + `core/vllm/offload.go` (`OffloadingConnector` -> `cpu_dram` tier), `engine.Batch.TransfersStarted` (`TransferLoad`/`TransferStore` with `Tier` & `Blocks`) | **GPU HBM** and **Host RAM (`cpu_dram`)** are modelled in vLLM `0.32.0` (`OffloadingConnector`). **Secondary tiers (`nvme_gen4`, `sata_ssd`, `s3`/remote object store) are explicitly refused** by `blis-vllm` `v0.32.0` (`"only one cpu_dram tier... is modelled; secondary tiers (TieringOffloadingSpec's) are not"`). Tier view will animate GPU and Host RAM and render Local SSD / Remote Store greyed out with an explanation. |
| Roofline inputs (GPU peak FLOPs/BW, per-step FLOPs, bytes moved, step duration) | `blis-substrate/catalog/hardware/*.yaml` (`TFlopsPeak`, `TFlopsFP8`, `BwPeakTBs`), `catalog/models/*/graph.yaml`, `kernel.Kernel.StepTime()` -> `StepEstimate{Overlap, NoOverlap, Bottleneck, PerResource}` | `StepEstimate` exposes per-resource durations (`sm`, `hbm`, etc.) and `Bottleneck`, not raw FLOPs or bytes moved. **Resolution:** export `PerResource` and `Bottleneck` from `Kernel.StepTime` plus analytical step FLOPs and HBM bytes computed from the model graph + batch shape (`Scheduled`, `Computed`, `TP`), clearly labelled as derived from BLIS's model graph and batch shape. |
| "No batching" mode (Scenario 2) | `blis-vllm/core/sched/scheduler.go` (`max_num_seqs`) | `max_num_seqs: 1` is accepted by BLIS and forces single-request execution (no continuous batching across requests). |
| Pod failure / crash injection | Audited `sim/cluster/` | **Not modelled in BLIS.** Listed as not modelled on the Accuracy page and in ADR 0001; Scenario 9 shows autoscaling only. |

## Decision

1. **Use BLIS at commit `c79c7456` as the sole simulation engine.** No simulation logic will exist in the TypeScript frontend.
2. **Keep patches minimal and confined to `engine/` (`inference-sim` fork), without forking `blis-vllm` or `blis-substrate`.** All required per-request, per-step, routing, KV block, tier transfer, lifecycle, and derived roofline data can be observed cleanly through a read-only `EventSink` wired into `sim/`, `sim/cluster/`, `sim/llmd/`, and `cmd/`.
3. **Document unmodelled features transparently:** Local SSD / Remote Store KV offload tiers (in v0.32.0 `vllmengine`) and pod failure injection are not modelled by BLIS and will be clearly surfaced in the UI and on the Accuracy page.

## Consequences

- Upstream BLIS simulation outputs (`stdout` `Result` JSON) remain byte-identical with or without `--events-output` (verified by automated tests in Step 3).
- No multi-repo fork coordination is required (`blis-vllm` and `blis-substrate` remain pinned upstream modules).
- All 36 facts remain achievable, with BLIS's unmodelled tiers and pod failure explicitly handled per the Accuracy & Tier-view facts.
