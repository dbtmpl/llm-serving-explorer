# Conformance with references

Tests that compare the TypeScript model in `src/sim/` with three references, each a module under `refs/<id>/` implementing `Reference` (`refs/reference.ts`):

- **[BLIS](https://github.com/inference-sim/inference-sim)** (`blis`): a discrete-event simulator running the llm-d router's code (its Endpoint Picker, in process) in front of a Go translation of vLLM 0.34's scheduler. Evidence for llm-d's and vLLM's decisions: routing, queueing, admission, preemption, KV accounting.
- **Measured vLLM** (`vllm-measured`): per-request timings, engine settings and KV block counts from two published vLLM runs (0.31.0 and 0.19.0) of 300 ShareGPT requests, on one RTX PRO 6000 and one RTX 4090. Evidence for timings and KV pool size on real hardware, for one model and one workload.
- **[LLMServingSim](https://github.com/casys-kaist/LLMServingSim)** (`llmservingsim`): a second, independent Python port of vLLM's scheduler and block pool, with step times from kernels profiled on those two GPUs. Its authors validate it against the measured runs, so there its agreement with them is not independent evidence.

[`conformance/parity.md`](parity.md) explains every known difference with its numbers.

## Parity with BLIS, llm-d and vLLM

Each reference is reported on its own; agreement is never pooled. Where the model is fitted, the readings before and after the fit are kept apart.

<!-- generated:parity-readme:start -->
**BLIS** (commit `e7597a8c`): median deviation 2.8% over 76 comparisons, 44 of them within 5%.

| Group | Comparisons | Median deviation | Largest deviation | Within 1% | Within 5% | Within 10% | Within 25% |
|---|---|---|---|---|---|---|---|
| Capacity and KV accounting | 2 | 0.8% | 1.0% | 2 | 2 | 2 | 2 |
| Decisions | 12 | 0% | 75.0% | 10 | 10 | 10 | 10 |
| Timings and rates (fitted, held out) | 54 | 3.1% | 44.6% | 13 | 30 | 44 | 51 |
| Directional effects | 8 | 9.5% | 79.0% | 1 | 2 | 4 | 6 |
| **All** | 76 | 2.8% | 79.0% | 26 | 44 | 60 | 69 |

Counting checks instead: 68 of 76 checks agree (89.5 percent), 8 known differences; 22 of the 28 approaches in the [approach table](../src/sim/README.md#all-approaches) are covered by at least one of its scenarios.

| Kind of check | What must hold | Checks | Agree | Known difference |
|---|---|---|---|---|
| Exact | Decisions and discrete counts are equal (the pod chosen, cached prefix tokens, which requests are shed or preempted) | 12 | 10 | 2 |
| Capacity | KV blocks per replica within 0.1%: both sides derive them from estimates | 2 | 0 | 2 |
| Calibrated | A timing or rate is within the tolerance written in the scenario | 54 | 51 | 3 |
| Directional | The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling) | 8 | 7 | 1 |
| **All** | | **76** | **68** | **8** |

Comparison with the previous BLIS commit (`c79c7456` vs `e7597a8c`):

| Metric | `c79c7456` | `e7597a8c` |
|---|---|---|
| Scenarios (with checks / calibration) | 19 / 27 | 19 / 27 |
| Checks agreeing | 39 of 46 (84.8 percent) | 68 of 76 (89.5 percent) |
| Known differences | 7 | 8 |
| Overall median deviation | 2.2% | 2.8% |
| Overall largest deviation | unbounded | 79.0% |
| Within 1% / 5% / 10% / 25% | 17 / 30 / 35 / 40 (of 46) | 26 / 44 / 60 / 69 (of 76) |
| Capacity and KV accounting | 2, median 0.8%, max 1.0%, within 5%: 2 | 2, median 0.8%, max 1.0%, within 5%: 2 |
| Decisions | 12, median 0%, max 75.0%, within 5%: 10 | 12, median 0%, max 75.0%, within 5%: 10 |
| Timings and rates (fitted, held out) | 24, median 2.7%, max 33.6%, within 5%: 17 | 54, median 3.1%, max 44.6%, within 5%: 30 |
| Directional effects | 8, median 14.0%, max unbounded, within 5%: 1 | 8, median 9.5%, max 79.0%, within 5%: 2 |
| Exact checks (agree / total) | 10 / 12 | 10 / 12 |
| Capacity checks (agree / total) | 0 / 2 | 0 / 2 |
| Calibrated checks (agree / total) | 23 / 24 | 51 / 54 |
| Directional checks (agree / total) | 6 / 8 | 7 / 8 |

Every check that does not hold as written (the scenario files carry the full reasons, [the parity page](parity.md) the numbers):

| Compared | Ours | `c79c7456` | `e7597a8c` | Deviation (`e7597a8c`) | Missed | Cause |
|---|---|---|---|---|---|---|
| `autoscale-overload`: mean time to first token, fixed to autoscaled | 8.4% of baseline | 40% of baseline | 40% of baseline | ratio 0.21 | effect ratio 0.33 to 3 (different by design) | The autoscalers follow different rules and reach different sizes |
| `kv-budget-70b-h200-tp4`: KV blocks per replica | 75,234 blocks | 74,760 blocks | 74,761 blocks | +0.6% | 0.1% | BLIS's flat graph median is above what measured engines set aside; the model follows the measurements |
| `kv-budget-8b-h100`: KV blocks per replica | 28,205 blocks | 27,926 blocks | 27,927 blocks | +1.0% | 0.1% | BLIS's flat graph median is above what measured engines set aside; the model follows the measurements |
| `routing-round-robin`: pod chosen per request | per request | per request | per request | 8 of 12 differ (67%) | different by design | llm-d picks at random among tied pods; the model rotates strictly, as Envoy does |
| `routing-round-robin`: requests per pod | 3/3/3/3 | 4/4/3/1 | 4/4/3/1 | 3 of 4 differ (75%); largest 200% | different by design | Same cause: random choice among tied pods against strict rotation |
| `tiers-offload`: host-tier hit rate, gpu-only to with-dram | 49.8% | 0.0% | 49.1% | ratio 1.02 | holds (resolved) | Resolved (was: The reference reports a zero host-tier hit counter although the tier works (its counter, not the behaviour)) |
| `timing-8b-h100-burst`: mean time to first token | 728 ms | 545 ms | 545 ms | +33.5% | 30% | One compute-efficiency factor cannot follow the reference's prefill cost curve |
| `timing-8b-h100-burst`: median time to first token | 726 ms | — | 502 ms | +44.6% | 30% | One compute-efficiency factor cannot follow the reference's prefill cost curve |
| `timing-8b-h100-burst`: 99th percentile time to first token | 1,190 ms | — | 884 ms | +35.2% | 30% | One compute-efficiency factor cannot follow the reference's prefill cost curve |

**Measured vLLM** (revision `49df63f2`): median timing deviation 10.8% over 20 comparisons with the site's default parameters, 2.7% over 28 comparisons on held-out requests after fitting.

| Group | Comparisons | Median deviation | Largest deviation | Within 1% | Within 5% | Within 10% | Within 25% |
|---|---|---|---|---|---|---|---|
| Capacity and KV accounting | 2 | 50.6% | 100.0% | 0 | 1 | 1 | 1 |
| Decisions | 1 | 0% | 0% | 1 | 1 | 1 | 1 |
| Timings, default parameters (no fit) | 20 | 10.8% | 16.4% | 0 | 1 | 9 | 20 |
| Timings and rates (fitted, held out) | 28 | 2.7% | 41.3% | 2 | 22 | 24 | 27 |

Counting checks instead: 44 of 51 checks agree (86.3 percent), 7 known differences; 8 of the 28 approaches in the [approach table](../src/sim/README.md#all-approaches) are covered by at least one of its scenarios.

| Kind of check | What must hold | Checks | Agree | Known difference |
|---|---|---|---|---|
| Exact | Decisions and discrete counts are equal (the pod chosen, cached prefix tokens, which requests are shed or preempted) | 1 | 1 | 0 |
| Capacity | KV blocks per replica within 0.1%: both sides derive them from estimates | 1 | 0 | 1 |
| Calibrated | A timing or rate is within the tolerance written in the scenario | 49 | 43 | 6 |
| Directional | The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling) | 0 | 0 | 0 |
| **All** | | **51** | **44** | **7** |

Every check that does not hold as written (the scenario files carry the full reasons, [the parity page](parity.md) the numbers):

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

Counting checks instead: 72 of 89 checks agree (80.9 percent), 17 known differences; 15 of the 28 approaches in the [approach table](../src/sim/README.md#all-approaches) are covered by at least one of its scenarios.

| Kind of check | What must hold | Checks | Agree | Known difference |
|---|---|---|---|---|
| Exact | Decisions and discrete counts are equal (the pod chosen, cached prefix tokens, which requests are shed or preempted) | 7 | 6 | 1 |
| Capacity | KV blocks per replica within 0.1%: both sides derive them from estimates | 1 | 0 | 1 |
| Calibrated | A timing or rate is within the tolerance written in the scenario | 75 | 62 | 13 |
| Directional | The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling) | 6 | 4 | 2 |
| **All** | | **89** | **72** | **17** |

Every check that does not hold as written (the scenario files carry the full reasons, [the parity page](parity.md) the numbers):

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

**In short**

- **BLIS.** Eight checks do not hold as written: round robin (Envoy's strict rotation against llm-d's random choice among tied pods, two checks); time to first token when 32 requests arrive at once (mean, median and 99th percentile: one compute-efficiency factor cannot follow BLIS's prefill cost); the drop in queue wait under autoscaling (different autoscaler rules); and one replica's KV pool, which the model sizes 1.0 percent (8B, H100) and 0.6 percent (70B, four H200s) larger, because BLIS charges a flat 1.16 GB median for CUDA graphs where the model follows what measured engines set aside. (BLIS's host-tier hit counter, which read zero at `c79c7456`, now reports 49.1% and holds.)
- **Measured vLLM, default parameters** (MBU 0.85, MFU 0.7). Every timing check on the RTX PRO 6000 holds; on the RTX 4090 all but the median end-to-end time (+16.4 percent against a 15 percent tolerance), with time per token +10.6 percent. The KV pool is within 0.07 percent of the RTX PRO 6000's and 1.2 percent above the RTX 4090's, using an empirical 0.7 GB per GPU for memory outside PyTorch fitted to these two runs.
- **Measured vLLM, fitted.** Parameters fitted on the RTX PRO 6000 hold all four checks on the RTX 4090; those fitted on the RTX 4090 hold none on the RTX PRO 6000, because that fit ends at its MBU bound. The prefix-cache check (a 7.6 percent hit rate) is out of reach: the model's prefix cache is per conversation, and the trace gives token counts, not the prefixes separate conversations share.
- **LLMServingSim.** Decisions agree on 6 of 7 exact checks (cached prefix tokens per follow-up, round-robin placement, `max_num_seqs`, preemptions); the miss is the RTX 4090's preemption count over a long saturated run, 204 against 191. Its KV pool (37,090 blocks on the RTX PRO 6000, against 36,649 measured) sets nothing aside for activations, CUDA graphs or memory outside PyTorch. At small batches, the model's front-end tokenisation (30 ms plus 4 µs per token), which LLMServingSim lacks, is most of the gap in time to first token. In a prefill/decode split its time to first token ends at the prefill replica, before the hand-over, so that effect differs by definition.

**History.** The 4090's time per token was +22 percent until the model kept a preempted request's full KV blocks in the prefix cache, as vLLM does (2026-11-17). Before the cost model changed (2026-11-16) the decode step was 50 to 60 percent slow and throughput 33 to 45 percent low. The first BLIS comparison found two errors that were fixed: vLLM caches `prompt + output - 1` tokens after a turn, and vLLM 0.32 admits a waiting request only when its whole input fits in the free blocks (`scheduler_reserve_full_isl`).

**What it does not show.** No check runs on a GPU cluster. BLIS is a simulator, the scenarios are small and constructed, and a timing that agrees after a fit says the cost model can follow the reference, not that it matches hardware. Mechanisms no reference has (static batching, admission rules that reserve memory for a whole prompt or answer) cannot be checked, and no reference has an MI300X.

**One translation assumption.** llm-d's flow control holds requests only when a saturation detector reports the pool full, and BLIS configures none by default. The translator gives the router a `concurrency-detector` limit equal to the model's own (`max_num_seqs + POD_QUEUE_SLACK` requests in flight per replica; `refs/blis/translate.ts`). The shedding check therefore shows that, given the same gate, both shed the same requests, not that llm-d deployments use that gate.

## Running it

```bash
pnpm test:conformance                         # the suite; Node only, needs neither Go nor BLIS
pnpm conformance:report [<id>]                # print every check's outcome (and differences) without asserting
BLIS_BIN=/path/to/blis pnpm conformance:reference [--ref <id>] [--only <id>] [--keep <dir>]   # regenerate the references
LLMSERVINGSIM_DIR=<built checkout> LLMSERVINGSIM_PYTHON=<python> pnpm conformance:reference --ref llmservingsim   # see "LLMServingSim as a reference"
pnpm conformance:calibrate                    # refit the timing parameters to the committed references; writes calibration/fitted.json
pnpm conformance:summary                      # write summary.json and print the headline figure
pnpm docs:sync                                # regenerate the README tables and the generated parts of conformance/parity.md
```

`pnpm test` runs the conformance suite too. `pnpm test:conformance` exists so CI can show it as its own check and so that you can run it alone.

## How it works

```
conformance/scenarios/<id>.yaml   one neutral scenario: deployment, request list, checks, tolerances
        |                 \
translate/toTypescript.ts   refs/<id>/translate.ts   scenario -> Params + trace  |  scenario -> the reference's native input
        |                          |
run/typescript.ts           refs/<id>/run.ts         run headless  |  run the simulator, or load the measurements
        |                          |                reduce both to one record (record.ts)
        |                  reference/<id>/<scenario>.json   committed: the reference's reduced record + what it was made from
        \________ compare.ts ______/                 check by check, per reference: agree, or differ exactly as recorded;
                                                      references with each other: agree, or the gap is recorded
```

A reference implements `Reference` (`refs/reference.ts`): `id`, `evidence`, `supports` (models, GPUs, mechanisms, quantities, metrics), `translate`, `run`, `reduce`, `generate` (produce the committed file) and `lock`. Generating is running a simulator or reducing committed or downloaded measurements; nothing else writes a committed file. A check applies to every reference that supports the scenario's model, GPU and mechanisms and can state what the check compares (a check may name `references:` to narrow that). Registered references are listed in `refs/index.ts`.

- **Scenario** (`scenarios/*.yaml`). Neutral names (`llama-3.1-8b`, `h100`) that `translate/names.ts` (the model) and `refs/<id>/names.ts` (each reference) map to their catalogues; engine settings; replica count; routing policy; optional `queue_deadline_s`; the requests as conversations (`session`, `at`, `gap_s`, `turns: [[newTokens, outputTokens], ...]`); and `checks`. YAML, because every tolerance and every explanation sits next to the thing it justifies and a reviewer needs no TypeScript to read it.
- **Request list.** Both simulators are given the same open-loop trace, so nothing is random. In the TypeScript model that is the `trace-replay` workload (`src/sim/workload/trace.ts`). In BLIS it is a trace with `session_context_growth: accumulate`, replayed with `--session-mode fixed-accumulate`: a follow-up round stores only the tokens it adds, and BLIS rebuilds `previous prompt + previous output + added tokens`, which is what the TypeScript model does too. Space rounds of a conversation further apart than any answer takes: the runner refuses a follow-up sent before the previous answer finished.
- **Checks.** Four kinds, strictest first, each with a one-line `tolerance` saying why that standard is the right one (written before the first comparison run).
  - `capacity`: a size both sides derive from estimates (`kv_blocks_per_replica`) within a relative `rel_tol`, set on principle (see the rule on tolerances).
  - `exact`: integers and decisions that must be equal. A check names a `quantity` (`kv_blocks_per_replica`, `prefix_cached_tokens`, `routed_pod`, `requests_per_pod`, `session_pod_changes`, `preemptions`, `request_fate`, `prefill_pool_requests`). Replicas are interchangeable, so `routed_pod` names them in order of first use.
  - `calibrated`: a `metric` (time to first token, time per token, end to end, throughput, KV hand-over time, tokens per speculative step) within a relative `rel_tol`. The TypeScript run of such a scenario uses the fitted timing parameters (see Calibration). Metrics are computed from the per-request rows, the same way for both simulators (`record.ts`, `metricOf`). The TypeScript front end's three illustrative network hops are excluded from its times (`run/typescript.ts`), because BLIS's default has none; its tokenisation stays, as BLIS has an admission delay that stands for it.
  - `directional`: the scenario has `arms` (the scenario with a few fields replaced); the check names a `metric`, a `baseline` and an `intervention` arm, an `effect` (`ratio` or `difference`), the expected `direction`, and a `band` the two simulators' effects must lie within of each other. Two zero effects, for a hit rate that falls to nothing in both, agree.
- **The rule on tolerances.** A tolerance may be set or changed only by a dated, recorded decision with a reason that does not depend on the observed result (the decision of 2026-11-16 on capacities is in [`conformance/parity.md`](parity.md)). Never loosen a tolerance, or change a scenario's parameters, to make a check pass.
- **Deviations.** Every check also has a deviation, computed by the suite (`deviation.ts`) whether or not it holds: the signed relative difference for a quantity or metric, the share of individual decisions that differ for an exact check, the ratio of the two effects for a directional one. `pnpm conformance:report` prints it with both values and the tolerance; `summary.json` carries every check's row and the distribution per group, and the parity page and README lead with it. The count of checks that hold is the secondary figure.
- **The rule on differences.** A check passes as stated, or it carries a `known_difference`: a `reference` (which one it is a difference with), a `cause` (a few words, for the table of failing checks), optionally `by_design: true`, a `reason` (what each side does and why they differ; at least a paragraph's worth, enforced by length) and `differences`, the exact keys that differ with both values. Known differences are per reference. Where two references cover a check and disagree with each other, the check carries a `reference_gap` (reason and the exact values) and the model is held against the span of the references, a `known_difference` with `reference: span` recording a miss; a check never passes merely by matching the more convenient reference. The test asserts the observed difference equals the recorded one. It therefore fails if the difference disappears (the model was fixed: delete the record) and if it grows or changes (a new divergence).
- **References** (`reference/<id>/*.json`). The reduced BLIS record plus `inputHash` (a hash of everything handed to BLIS: scenario file, router configuration, trace, arguments), the BLIS commit, and the catalogue and registry hashes from the BLIS Result. The suite fails when `inputHash` no longer matches the scenario (regenerate) or the commit differs from `refs/blis/lock`.
- **`refs/blis/lock`** pins the inference-sim commit (no submodule). The router configurations in `refs/blis/epp/` are byte copies of the ones that BLIS build ships (`blis router-configs --file ...`); the reference script checks that.

## Measured data as a reference

`refs/vllm-measured/` is a reference that runs nothing. Its data (`data/<gpu>-<model>.json`) is a reduction of the `vllm/` files of [LLMServingSim](https://github.com/casys-kaist/LLMServingSim)'s `bench/examples` at the commit in `refs/vllm-measured/lock` (MIT licence, kept as `LICENSE-LLMServingSim`): per request the client send time, token counts and first and last token times, the engine's settings and KV block count, and totals of the per-second statistics, with the SHA-256 of each source file. `LLMSERVINGSIM_DIR=<clone> pnpm conformance:extract` remakes it; `pnpm conformance:reference --ref vllm-measured` turns it into the records the tests read. `translate` refuses a scenario whose requests (arrival, input and output tokens) or engine settings differ from the run. Its scenarios (`measured-*`) carry two readings of timing side by side: `default-*` checks run the model with the site's default parameters over all requests (`params: defaults`), `fitted-*` checks run it with parameters fitted to the first `split.calibration_requests` requests (`pnpm conformance:calibrate`) and are computed on the rest (`subset: held-out`), and `crossfit-*` checks run it with the parameters fitted to the other card's run (`params: fitted-on:<gpu>`) over all requests. Never pool the three.

## LLMServingSim as a reference

`refs/llmservingsim/` runs a pinned checkout of LLMServingSim (`refs/llmservingsim/lock`; MIT licence, text kept as `LICENSE-LLMServingSim`) as a subprocess. It is not part of the repository and is not a submodule: build it with `refs/llmservingsim/build.sh <dir>` (clones the pinned commit, initialises only the ASTRA-Sim sub-submodules the analytical build needs, generates the protobuf files, builds the congestion-unaware analytical backend and makes the Chakra shim; about five minutes), then

```bash
python3.10 -m venv venv && venv/bin/pip install -r conformance/refs/llmservingsim/requirements.txt
LLMSERVINGSIM_DIR=<dir> LLMSERVINGSIM_PYTHONPATH=<dir>/.chakra-shim LLMSERVINGSIM_PYTHON=$PWD/venv/bin/python pnpm conformance:reference --ref llmservingsim
```

Local build on macOS (arm64), as verified: Homebrew `cmake` and `protobuf` (`brew install cmake protobuf`), a Python 3.10 environment with `requirements.txt` (a uv venv is fine), and nothing else; no Docker, GPU, `sudo` or ns-3. `build.sh` passes `-D_LIBCPP_ENABLE_CXX17_REMOVED_UNARY_BINARY_FUNCTION` (libc++ dropped `std::unary_function`, which ASTRA-Sim's dependencies use) and links Homebrew's abseil on Darwin, and it bypasses the upstream `scripts/compile.sh` (which needs `nproc` and `pip install`s Chakra). The result reproduces the committed `bench/examples/RTXPRO6000/Llama-3.1-8B/outputs/sim.csv` byte for byte (`cmp`), which is the first thing to check after any rebuild. It is untrusted third-party code: read `build.sh` before running it. On Linux the nightly job uses the same script (`.github/workflows/llmservingsim-references.yml`); that route is untested outside macOS until the job has run once.

- **What it supports.** Llama 3.1 8B on the RTX PRO 6000 and RTX 4090 (the GPUs it has profiles for that the model's catalogue has too); one or several replicas with round robin or least-loaded routing; multi-turn conversations; a CPU KV tier; prefill/decode instances; speculative decoding by acceptance rate. Not: llm-d routing, shedding, autoscaling, other GPUs or models, tensor parallelism above 1 (the adapter refuses them, saying which).
- **Inputs.** A JSONL trace, one request per line with `input_toks`, `output_toks`, `arrival_time_ns` and token ids (its prefix cache hashes real ids, so the translator invents ids that share exactly what the conversation shares; follow-ups are ordinary requests at their own arrival times), and a cluster configuration JSON built from the example configuration of its own bench example (`refs/llmservingsim/data/`), with the scenario's memory utilisation, replicas, tiers and instance roles.
- **Outputs, scraped from its stdout and CSV at the default log level; nothing is patched.** Per request: arrival, end, queuing delay, time to first token (all nanoseconds), tokens. From the log: KV blocks per instance, the preemption count (the line is absent when it is zero), total requested and prefix-hit prompt tokens, and the cumulative hit counters it prints every simulated second. A request's cached tokens are the increase of its instance's counter in the second it was admitted; the adapter returns them only where that is unambiguous (at most one admission per second that hit the cache, no host tier, no prefill/decode split) and checks that they add up to the total, otherwise `null`. It fails loudly on any line or column it cannot find: the adapter is pinned to the commit, and the upstream repository changes quickly. Not reported at all, so not stated: prefill/decode transfer times, tokens per speculative step, the running and waiting series (the log prints them, they are not in the record).
- **KV capacity** is `(memory x utilisation - weights) / bytes per block`, arithmetic on its input; it is compared as that (see `conformance/parity.md`) and never taken as a measurement of vLLM's start-up sizing.
- **Scenario-level `references:`.** A scenario may name the references allowed to answer it (the measured scenarios name `vllm-measured` and `llmservingsim`; the `lss-*`, `calib-lss-*` and `timing-lss-*` scenarios name `llmservingsim`), so a reference that supports the model and GPU is not asked to answer a scenario built from another's inputs.
- **Determinism.** A run takes 5 to 50 seconds and is deterministic: the committed CSV of its example is byte-identical across macOS and Linux.
- **Bumping the pin.** Put the new full commit in `refs/llmservingsim/lock`, rebuild, check that the example's committed CSV is still reproduced (if the authors changed their profiles or scheduler it will not be, and that is the news), `pnpm conformance:extract-llmservingsim` (the prefix data and its hashes), `pnpm conformance:reference --ref llmservingsim`, read the diff of `reference/llmservingsim/`, update the known differences it moves, `pnpm conformance:calibrate`, `pnpm conformance:summary && pnpm docs:sync`.

## Calibration

The cost model is a roofline (`src/sim/cost/`) with two achieved-rate factors, a tensor-parallel all-reduce term, a per-layer launch time and a host-time term; BLIS prices a step with a kernel model fitted to vendor kernel sweeps. `pnpm conformance:calibrate` fits `mbu`, `mfu`, `hostMsBase` and `hostMsPerSeq` per (model, GPU), one set shared by every tensor-parallel degree in the calibration data, plus `commEff` and `commLatencyUs` where there are several degrees (the 70B on H200 at TP 2, 4 and 8), to the references of the scenarios with `role: calibration` (they carry no checks), and `specCost` and `linkGbps` on the speculative and prefill/decode ones. The method (a deterministic coordinate search in log space, the loss, the bounds, decided on 2026-11-16 before the refit) is documented in [`calibration/fit.ts`](calibration/fit.ts); the committed result, with residuals, any parameter that ended on a bound, a loss profile of MBU and MFU that shows which parameter the data does not identify, and the site's defaults beside it, is [`calibration/fitted.json`](calibration/fitted.json). The fit never changes the defaults in `src/sim/core/params.ts`. A scenario with a calibrated or directional check needs a fit for its model and GPU, or the test says which one is missing; a check may also use the fit of another GPU (`params: fitted-on:<gpu>`).

Held-out scenarios (`timing-*`, `spec-decoding`, `pd-disaggregation`) use different load, prompt lengths and batch sizes than the calibration ones. When a fitted model misses a tolerance, the miss is a known difference with the numbers, not a retuned scenario.

## Scenario fields beyond the basics

`references: [<id>, ...]` (scenario level) restricts which references may answer the scenario; unstated, every reference whose `supports` covers it does.

`role: calibration`, `arms:`, `speculative: {k, acceptance_length}` (BLIS's own input is the mean tokens per step; the TypeScript translator finds the per-token acceptance that gives it), `disagg: {prefill_replicas, decode_replicas, threshold_tokens}`, `offload: {cpu_gb}` (a host-memory tier per replica), `autoscale: {min_replicas, max_replicas}` and `stream: {rate_per_s, count, prompt_tokens, output_tokens}`. A stream and an autoscaler run through `blis run` (the autoscaler does not run in `blis replay`), with a constant-rate workload whose arrivals fall at exactly the instants the trace gets.

## Adding a scenario

1. Write `scenarios/<id>.yaml` (copy a similar one). Use only model/GPU pairs that both catalogues have and that BLIS has coefficients for; BLIS refuses others and says why.
2. Regenerate its reference: `BLIS_BIN=... pnpm conformance:reference --ref blis --only <id>`.
3. `pnpm conformance:report <id>` shows each check. Where they agree, nothing more. Where they differ, find out why before writing anything: read the BLIS source (the Go module cache of the pinned build holds it) and the TypeScript code, and test the explanation. Then add `known_difference` with the reason and the printed `differences`.
4. `pnpm test:conformance`.

Pitfalls found so far: make decisions unambiguous (the TypeScript router sees exact pod state at once, llm-d scores from scraped metrics and an approximate prefix index, so close calls differ for reasons unrelated to the policies); space requests more than a metrics scrape (50 ms) apart when the router must see load; and BLIS refuses a pool that cannot hold one `max_model_len` sequence, so set `engine.max_model_len` when you shrink the pool.

## Bumping the pin

1. Check out the new inference-sim commit, build it with the Go version its `stack.json` names (`toolchain`), put the full commit hash in `refs/blis/lock`.
2. `BLIS_BIN=<binary> BLIS_SRC=<checkout> pnpm conformance:reference` (with `BLIS_SRC` the script refuses a checkout that is not at the locked commit).
3. Read the diff of `reference/`. Anything that changed is BLIS changing behaviour: explain it or update the affected `known_difference`, then `pnpm test:conformance`.

The workflow `.github/workflows/blis-references.yml` does steps 1 and 2 on every change to `refs/blis/lock`, the scenarios or the translators, and nightly, and fails if the regenerated references differ from the committed ones. The ordinary CI job (`conformance`) only reads them.

## Not covered

Prefill/decode transfer contention, the SSD and shared-pool KV tiers, MI300X (not in BLIS's catalogue, and no measurement), and step-level comparison (BLIS has no event stream). The approaches that cannot be verified, with the reason for each, are in the parity page.
