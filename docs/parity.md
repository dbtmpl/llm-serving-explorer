# Agreement with references

The TypeScript model in `src/sim/` is compared, scenario by scenario, with external references. Each reference is a different kind of evidence, and each has its own section here with its own figure.

| Reference | Id | What it is | Evidence for |
|---|---|---|---|
| [BLIS](https://github.com/inference-sim/inference-sim) (inference-sim) | `blis` | A discrete-event simulator that runs the [llm-d](https://github.com/llm-d/llm-d) router's own code (its Endpoint Picker, in process) in front of a Go translation of [vLLM](https://github.com/vllm-project/vllm)'s scheduler | Decisions of llm-d and vLLM as simulated |

This page says what agreement shows, what it does not, how it is produced, and where the model and each reference differ. The machinery is in [`conformance/`](../conformance/README.md); the plan it followed is [`blis-conformance-plan.md`](blis-conformance-plan.md).

## How it is produced

- **Shared, neutral scenarios.** One YAML file per scenario in [`conformance/scenarios/`](../conformance/scenarios/) describes the deployment, the request list and the checks, with model and GPU names that neither the model nor any reference owns. Every tolerance and its one-line justification is written into the scenario before its first comparison run.
- **One adapter per reference.** `conformance/refs/<id>/` implements the `Reference` interface (`conformance/refs/reference.ts`): what it supports (models, GPUs, mechanisms, quantities), how a scenario becomes its native input, how that is run or loaded, and how the raw output is reduced to the one comparable record. A reference may be a simulator that is run or measured data that is reduced; either produces the committed file for a scenario. `conformance/translate/` holds the TypeScript model's own translation.
- **Pinned, committed references.** Each reference pins what it was made from in a lock file (BLIS: `conformance/refs/blis/lock`, a commit; there is no submodule, CI clones and builds it). Its output for each scenario is reduced and committed under `conformance/reference/<id>/`, with a hash of everything the reference was given. The ordinary test run needs no external tool; it fails if a scenario changed without its reference being regenerated.
- **Which references apply.** A check applies to every reference that supports the scenario's model, GPU and mechanisms and can state what the check compares, unless the check names its references. Each reference has its own `known_difference` records.
- **When two references cover a check.** They are first compared with each other by the check's own rule. If they agree, the model is held against each. If they disagree, the gap between them is recorded and explained in the scenario (`reference_gap`, asserted exactly), and the model is held against the span they leave: a check never passes merely by matching the more convenient reference. Cross-reference standings are in the last section.
- **CI jobs.** `conformance` (every pull request) runs the model on every scenario and compares it with the references. `blis-references` (nightly, and when the pin, a scenario or a translator changes; it regenerates only BLIS's references) rebuilds the pinned BLIS, regenerates the references and the fit, and fails if they differ from the committed ones. `blis-upstream` (weekly, allowed to fail) does the same against BLIS's `main`, to see drift before the pin is bumped.
- **The rule on differences.** A check holds as stated, or it carries a `known_difference` with a reason and the exact values that differ, and the test asserts the observed difference equals the recorded one: it fails if the difference disappears or changes. A failing check is fixed in the model only when the model is demonstrably wrong against the vLLM or llm-d source; otherwise it is recorded. A tolerance is never widened to make a test pass, and a scenario is never tuned until it agrees.

Three kinds of check: **exact** (integers and decisions that must be equal), **calibrated** (a timing or rate within a relative tolerance after the fit) and **directional** (the same intervention moves the same metric in the same direction by a similar factor).


## BLIS

### What agreement with BLIS shows, and what it does not

**It is evidence that the model makes the same decisions as llm-d and vLLM 0.32** for routing, flow control, engine scheduling (admission, chunked prefill, preemption) and KV accounting (block budget, prefix reuse), in the situations the scenarios construct. BLIS embeds the router's code and ports the scheduler with references to the vLLM source lines, so an exact check that passes is a check against those implementations as BLIS runs them.

**It is not a measurement on a live cluster.** BLIS is itself a simulator: its router sees scraped metrics that BLIS generates, its engines are modelled and not real GPUs, and its step costs come from fitted coefficients. The scenarios are small and constructed. Nothing here says that a deployment of llm-d and vLLM would produce these numbers.

**Timings are calibrated to BLIS, not measured.** The cost model is a roofline with two achieved-rate factors (MBU, MFU) and a host-time term. For each model and GPU these are fitted to BLIS's step times on calibration scenarios, and the fitted model is then checked on held-out scenarios. That shows the roofline can reproduce BLIS's timings within the stated tolerances where the checks hold, and records where it cannot. It says nothing about how close either is to hardware. The site's defaults for MBU, MFU and host time are not changed by the fit; the table below shows how far the fitted values are from them.

**Directional checks are weaker than exact ones.** Where the two simulators follow different rules by design (the autoscalers), or store different things (BLIS evicts KV chunks, the model whole sessions), only the direction and rough size of an intervention's effect is compared, within a factor band written beside the scenario before it was run.

### Decisions on tolerances

A tolerance may be set or changed only by a dated, recorded decision with a reason that does not depend on the observed result. The decisions so far:

- **2026-11-16, repository owner: KV blocks per replica are a capacity, checked within 0.1%, not for integer equality.** Both simulators derive the pool from estimates (the activation peak, the rounding of the weights), so equality of the integer is not the meaningful criterion. The tolerance is 0.1% because the terms that remain are estimates on both sides, and a difference below one part in a thousand changes no admission decision in any scenario. The old values, kept for the record: 27,928 against 27,926 blocks for Llama 3.1 8B on one H100 (0.007%) and 74,790 against 74,760 for Llama 70B on four H200s (0.04%); the term-by-term explanation of each stays in the scenario file as a note. *Verification of the claim:* the model's pool was changed by minus and plus 0.1%, 1%, and 30 blocks, and all 36 scenarios were run again. Every decision (placements, cached tokens, preemptions, request fates) is unchanged in every scenario. 35 scenarios are bit-for-bit identical; the one that is built to sit at the edge of its pool (`preemption-overflow`, 3,601 blocks) keeps its one preemption and both completions and changes only times. Nothing else was relaxed: the round-robin, burst time-to-first-token and throughput, host-tier hit-rate and autoscaling-wait differences stay recorded.

### Result

<!-- generated:parity-headline-blis:start -->
**How far the model is from BLIS: median deviation 3.1% over 46 comparisons, 28 of them within 5%.** One deviation per check the reference covers: |model - reference| / reference for a quantity or metric, the share of individual decisions that differ for exact checks, |effect ratio - 1| for directional checks. Medians and maxima are over those numbers; 'within x%' counts the checks at or below x%. Regenerate with `pnpm conformance:summary`; the figures are in `conformance/summary.json` with the deviation of every check, kept in step with the scenarios by a test.

| Group | Comparisons | Median deviation | Largest deviation | Within 1% | Within 5% | Within 10% | Within 25% |
|---|---|---|---|---|---|---|---|
| Capacity and KV accounting | 2 | 0.02% | 0.04% | 2 | 2 | 2 | 2 |
| Decisions | 12 | 0% | 75.0% | 10 | 10 | 10 | 10 |
| Timings and rates | 24 | 4.0% | 39.1% | 8 | 15 | 19 | 23 |
| Directional effects | 8 | 15.8% | unbounded | 1 | 1 | 3 | 5 |
| **All** | 46 | 3.1% | unbounded | 21 | 28 | 34 | 40 |

Groups: **Capacity and KV accounting**: KV blocks per replica, and the prefix-cache and host-tier hit rates; deviation is the relative difference. **Decisions**: every exact check (pod chosen, requests shed or preempted, cached tokens, requests per pod, discrete counts) and the counts of replicas used, requests completed and preemptions; deviation is the share of the individual values that differ. **Timings and rates**: time to first token, time per token, end-to-end time, throughput, KV hand-over time and tokens per speculative step; deviation is the relative difference. **Directional effects**: the directional checks (an intervention's effect on a metric); deviation is |model effect / reference effect - 1|. 1 comparison(s) have no finite deviation (the reference value is zero) and are in no "within" column.

The count of checks is secondary, because a tolerance is a line the suite drew: **40 of 46 checks hold as written (87.0 percent), with 6 known differences.**

| Kind of check | Checks | Agree | Known difference | Agree means |
|---|---|---|---|---|
| Exact | 12 | 10 | 2 | every key of an integer or decision equal |
| Capacity | 2 | 2 | 0 | a size derived from estimates within a relative tolerance set on principle |
| Calibrated | 24 | 22 | 2 | within the scenario's relative tolerance |
| Directional | 8 | 6 | 2 | same direction, effect within the scenario's factor band |

Approaches in the registry: 21 of 27 are named by at least one scenario this reference covers; 6 are named by none and say why (below). Being named by a scenario means checked, not agreeing: several approaches appear in a check that is a known difference. Approaches that cannot be verified are not in the figure at all, in either direction.

Scenarios this reference covers: 36, of which 17 are calibration data (they carry no checks; the fit uses them) and 19 carry the 46 checks. BLIS commit: `c79c7456`.
<!-- generated:parity-headline-blis:end -->

### Calibration

The parameters of `src/sim/core/params.ts` that the fit sets are `mbu`, `mfu`, `hostMsBase` and `hostMsPerSeq`, per (model, GPU, tensor-parallel degree); the draft cost `specCost` and the link rate `linkGbps` are fitted on the pairs that have a speculative or prefill/decode calibration scenario. The method is a deterministic coordinate search in log space on a stated loss ([`conformance/calibration/fit.ts`](../conformance/calibration/fit.ts)); the values and every residual are committed in [`conformance/calibration/fitted.json`](../conformance/calibration/fitted.json) and a test refits from the references and compares.

<!-- generated:parity-calibration-blis:start -->
| Pair | MBU | MFU | Host ms, fixed | Host ms, per sequence | Loss at defaults, at fit | Worst residual, time to first token | Worst residual, time per token |
|---|---|---|---|---|---|---|---|
| `llama-3.1-8b/b200/tp1` | 0.6 (default 0.6) | 0.681818 (default 0.5) | 1.16219 (default 1.5) | 0.00713199 (default 0.05) | 0.0438953, 0.0229969 | -22.4% | +8.7% |
| `llama-3.1-8b/h100/tp1` | 0.6 (default 0.6) | 0.666667 (default 0.5) | 1.44 (default 1.5) | 0.00569372 (default 0.05) | 0.0793852, 0.0228158 | +22.6% | +8.7% |
| `llama-70b/h200/tp4` | 0.980392 (default 0.6) | 0.463636 (default 0.5) | 9.91736 (default 1.5) | 0.0589457 (default 0.05) | 0.149187, 0.0254718 | +34.4% | +1.5% |

- `llama-3.1-8b/h100/tp1`: draft cost `specCost` 0.0001 (default 0.04); time per token +1.7% from BLIS's on `calib-8b-h100-spec`. BLIS prices its n-gram drafter at nothing, so the fit goes to the lower bound.
- `llama-3.1-8b/h100/tp1`: link rate `linkGbps` 323.81 Gbit/s (default 100); hand-over time +0.1% from BLIS's on `calib-8b-h100-pd`. BLIS's fabric is 400 Gbit/s InfiniBand at 0.811 of line rate, which is 324 Gbit/s.
<!-- generated:parity-calibration-blis:end -->

A single MFU cannot bend the way BLIS's prefill cost does (short prompts cost more than the compute alone, long ones less per token), so time to first token is the weaker of the two timings: the fit leaves up to a third on the calibration scenarios, and the burst scenario below misses its tolerance. Time per token, which is memory-bound decoding, is close everywhere.

### Known differences

Each is a check that does not hold as stated. The values are the TypeScript model's, then BLIS's; the scenario file carries the same reason next to the check.

<!-- generated:parity-known-blis:start -->
- **`autoscale-overload` / `wait-falls`** (directional). Mean time to first token, which here is queue wait, is lower with the autoscaler. TypeScript / BLIS: effect: 0.08289 / 0.4021. Both fall, by different amounts, because the two autoscalers react at different times and reach different sizes. The TypeScript rule is concurrency based and acts on the count of requests in flight: it adds a replica at 1.1 s, 2.1 s and 3.1 s (one per second, as the count crosses 8, 16 and 24), so with the 5 s load time the new replicas serve from 6.1, 7.1 and 8.1 s, four replicas in all. BLIS's saturation analyzer (the llm-d workload-variant autoscaler's token-based rule) compares the tokens in the queue and in KV memory with 80 percent of the pool, so it waits until the queue holds enough prompt tokens: its first added replica serves from 11 s, its second from 18 s, and it stops at three. The queue therefore drains later and less in BLIS, and mean time to first token falls to 0.40 of the fixed arm's (8.3 s against 20.7 s) where the TypeScript model's falls to 0.083 (1.7 s against 20.5 s). The rules differ by design; the direction is the same.

- **`routing-round-robin` / `pod-sequence`** (exact). Request i goes to the replica after the one request i-1 went to, wrapping after four (replicas are named by first use, since which replica starts is arbitrary). TypeScript / BLIS: 8 values differ, for example s2/r0: 1 / 0; s3/r0: 2 / 1; s4/r0: 3 / 0. The TypeScript model rotates strictly through the replicas (Envoy's round robin), so request i goes to replica i mod 4. The llm-d router has no such policy. The closest configuration, which BLIS ships as reference-configs/round-robin.yaml and runs here, is the max-score picker with no scorers: every replica ties and the picker rotates the tied candidates by a counter, but the scheduler first puts the candidates in a seeded random order before every pick (scheduler_profile.go:363-370 in the router fork, added by the fork's hosting change; outside hosting the order is Go map order, which is not fixed either), so the choice is uniformly random among the tied replicas, not a cycle. The fork's reference-configs README says so: "it does not rotate". BLIS's draw for this trace is deterministic for the pinned build and seed. There is no llm-d behaviour for the TypeScript policy to be consistent with; it models Envoy, not llm-d.

- **`routing-round-robin` / `requests-per-pod`** (exact). Twelve requests over four replicas is three each. TypeScript / BLIS: rank0: 3 / 4; rank1: 3 / 4; rank3: 3 / 1. Same cause as pod-sequence. A strict rotation gives 3, 3, 3, 3; llm-d's random choice among tied replicas gave 4, 4, 3, 1 for this trace (counts sorted from the busiest replica; deterministic for the pinned build and seed). The llm-d configuration is balanced only on average.

- **`tiers-offload` / `host-tier-hit-rate`** (directional). With the tier, a share of prompt tokens is served from host memory; without it, none is. TypeScript / BLIS: effect: 0.4984 / 0. BLIS reports a host-tier hit rate of zero in this run (`cpu_tier_hit_rate` in its Result; the per-request rows carry no external-token count either) although the run shows the tier working: a follow-up's scheduling delay is 56.6 ms with the tier against 41.1 ms without (the 15.5 ms is the copy of about 3,050 tokens of KV, 400 MB at about 26 GB/s), and the step that prefills it takes 12.6 ms against 63.1 ms, because the history is no longer recomputed. The TypeScript model reports that 49.8 percent of all prompt tokens came from host memory. I did not find why BLIS leaves the counter at zero for a reload that completes before the request is first scheduled (its lookup is recorded at first admission, and a request whose load has landed is scheduled without a new prefix lookup, blis-vllm batch_formation.go); the timing check below shows the effect on time to first token, which both report.

- **`timing-8b-h100-burst` / `ttft-mean`** (calibrated). Mean time to first token agrees with BLIS after calibration. TypeScript / BLIS: value: 0.7586 / 0.5452. The prefill cost curve is the main cause; the arrival handling is a minor one. A full 8,192-token prefill step takes about 139 ms in BLIS (steps between the groups of prompts it batches: 362 ms less 223 ms) and about 206 ms in the TypeScript model (448 ms less 242 ms): the fitted MFU of 0.667 is a compromise between BLIS's short prompts (the TypeScript model is faster than BLIS on 128 tokens: 41 against 52 ms) and its long ones (slower on 8,000: 284 against 214 ms, calibration scenario calib-8b-h100-isolated), because a single efficiency factor cannot bend like BLIS's size-dependent prefill cost. A burst is a queue of full prefill steps, so it sits on the steep end. The minor cause: BLIS passes each request through an admission queue (a tokeniser pool with a per-token service time and a fixed delay, docs/guide/latency-models.md in inference-sim), so requests that arrive together reach its engine one after another (its first request is prefilled alone and sees its first token after 75 ms), where the TypeScript model's front end tokenises all 32 at once and its first step already carries 5 prompts and ends after 242 ms. Measured on 2026-11-16 by running the same trace through the pinned BLIS with `--renderer-num-workers 0`, which removes that serialisation, BLIS's mean time to first token moves only from 545 to 529 ms (and its first request's from 75 to 179 ms, because the whole admission time becomes an uncontended delay for every request), so the serialisation explains about 3 percent of BLIS's own value and little of the gap. The result is 39 percent more mean time to first token. Decoding agrees (time per token +6.3 percent, end to end +11.6 percent, both inside tolerance).

- **`timing-8b-h100-burst` / `throughput`** (calibrated). Output tokens per second over the run agree with BLIS after calibration. TypeScript / BLIS: value: 1678 / 1870. The same cause as in ttft-mean, seen from the other side: the burst's 32 prompts take longer to prefill in the TypeScript model (full 8,192-token prefill steps of 206 ms against BLIS's 139 ms), so the 6,400 generated tokens are spread over a longer span (the run ends later), and throughput is 10.3 percent lower, just outside the 10 percent tolerance. Decoding itself is within tolerance (time per token +6.3 percent).
<!-- generated:parity-known-blis:end -->

Changes made to the model because the first comparison showed it wrong against the vLLM source (not recorded as differences): a finished request caches `prompt + output - 1` tokens, and a waiting request is admitted only when its whole input sequence fits in the free blocks. Both are in the model's history, with their sources in `src/sim/engine/`.

## Between references

<!-- generated:parity-cross:start -->
No check is covered by more than one reference yet (BLIS): the references cover different GPUs and models. The comparison between references is implemented and tested on synthetic records (`conformance/__tests__/references.test.ts`).
<!-- generated:parity-cross:end -->

## What is not verifiable

These approaches have no check, and are not counted as agreement in either direction:

<!-- generated:parity-notverifiable:start -->
- **`admission/prompt`.** vLLM allocates KV memory as tokens are written and BLIS translates vLLM, so neither has a policy that reserves a whole prompt before admitting it; there is no counterpart to compare.
- **`admission/reserve`.** vLLM does not reserve KV memory for a request's whole output at admission, and BLIS follows vLLM, so there is no counterpart to compare.
- **`batching/static`.** vLLM does no static batching (it schedules continuously) and BLIS translates vLLM, so there is no counterpart to compare.
- **`kvcache/adaptive`.** BLIS reloads whenever its host-memory tier holds the prefix; it has no decision between copying and recomputing to compare. The scenario that exercises the tier (tiers-offload) is a check of the tiers, not of this rule.
- **`workload/closed-loop-sessions`.** BLIS replays traces and generates open-loop streams; it has no counterpart to the closed-loop sessions (users who wait, think and return) that the site generates, so the scenarios feed both simulators a trace instead.
- **`workload/trace-replay`.** It is how both simulators are given the same requests, not a mechanism BLIS models: every scenario uses it, and the conformance machinery fails when the two row sets differ, but there is nothing in BLIS to compare it with.
<!-- generated:parity-notverifiable:end -->

Also not covered, because BLIS or this suite does not compare it: AMD MI300X (not in BLIS's catalogue, so the model's MI300X entry has no counterpart); the SSD and shared-pool KV tiers (only the host-memory tier is compared); the router's scraped-metric delay (the model's router sees exact pod state; scenarios keep routing decisions unambiguous so this does not matter); and anything the site does that is not a mechanism, such as the animation.
