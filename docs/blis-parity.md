# Agreement with BLIS

The TypeScript model in `src/sim/` is compared, scenario by scenario, with [BLIS](https://github.com/inference-sim/inference-sim) (inference-sim), a discrete-event simulator that runs the [llm-d](https://github.com/llm-d/llm-d) router's own code (its Endpoint Picker, in process) in front of a Go translation of [vLLM](https://github.com/vllm-project/vllm)'s scheduler. This page says what that agreement shows, what it does not, how it is produced, and where the two differ. The machinery is in [`conformance/`](../conformance/README.md); the plan it followed is [`blis-conformance-plan.md`](blis-conformance-plan.md).

## What agreement shows, and what it does not

**It is evidence that the model makes the same decisions as llm-d and vLLM 0.32** for routing, flow control, engine scheduling (admission, chunked prefill, preemption) and KV accounting (block budget, prefix reuse), in the situations the scenarios construct. BLIS embeds the router's code and ports the scheduler with references to the vLLM source lines, so an exact check that passes is a check against those implementations as BLIS runs them.

**It is not a measurement on a live cluster.** BLIS is itself a simulator: its router sees scraped metrics that BLIS generates, its engines are modelled and not real GPUs, and its step costs come from fitted coefficients. The scenarios are small and constructed. Nothing here says that a deployment of llm-d and vLLM would produce these numbers.

**Timings are calibrated to BLIS, not measured.** The cost model is a roofline with two achieved-rate factors (MBU, MFU) and a host-time term. For each model and GPU these are fitted to BLIS's step times on calibration scenarios, and the fitted model is then checked on held-out scenarios. That shows the roofline can reproduce BLIS's timings within the stated tolerances where the checks hold, and records where it cannot. It says nothing about how close either is to hardware. The site's defaults for MBU, MFU and host time are not changed by the fit; the table below shows how far the fitted values are from them.

**Directional checks are weaker than exact ones.** Where the two simulators follow different rules by design (the autoscalers), or store different things (BLIS evicts KV chunks, the model whole sessions), only the direction and rough size of an intervention's effect is compared, within a factor band written beside the scenario before it was run.

## How it is produced

- **Shared, neutral scenarios.** One YAML file per scenario in [`conformance/scenarios/`](../conformance/scenarios/) describes the deployment, the request list and the checks, with model and GPU names that neither simulator owns. Every tolerance and its one-line justification is written into the scenario before its first comparison run.
- **Translators.** `conformance/translate/` turns a scenario into the TypeScript model's parameters and trace, and into BLIS's scenario, deployment, router configuration and trace. The router configurations are byte copies of the ones the pinned BLIS ships; the reference script checks that.
- **A pinned BLIS.** `conformance/blis.lock` names one commit. There is no submodule; CI clones that commit and builds it.
- **Committed references.** BLIS's output for each scenario is reduced to one comparable record and committed under `conformance/reference/`, with a hash of everything handed to BLIS. The ordinary test run needs neither Go nor BLIS; it fails if a scenario changed without its reference being regenerated.
- **CI jobs.** `conformance` (every pull request) runs the model on every scenario and compares it with the references. `blis-references` (nightly, and when the pin, a scenario or a translator changes) rebuilds the pinned BLIS, regenerates the references and the fit, and fails if they differ from the committed ones. `blis-upstream` (weekly, allowed to fail) does the same against BLIS's `main`, to see drift before the pin is bumped.
- **The rule on differences.** A check holds as stated, or it carries a `known_difference` with a reason and the exact values that differ, and the test asserts the observed difference equals the recorded one: it fails if the difference disappears or changes. A failing check is fixed in the model only when the model is demonstrably wrong against the vLLM or llm-d source; otherwise it is recorded. A tolerance is never widened to make a test pass, and a scenario is never tuned until it agrees.

Three kinds of check: **exact** (integers and decisions that must be equal), **calibrated** (a timing or rate within a relative tolerance after the fit) and **directional** (the same intervention moves the same metric in the same direction by a similar factor).

## Result

<!-- generated:parity-headline:start -->
**share of checks on mechanisms BLIS also models that agree (exact, within tolerance or directionally): 38 of 46 (82.6 percent), with 8 known differences.** Regenerate with `pnpm conformance:summary`; the figures below are in `conformance/summary.json`, kept in step with the scenarios by a test.

| Kind of check | Checks | Agree | Known difference | Agree means |
|---|---|---|---|---|
| Exact | 14 | 10 | 4 | every key of an integer or decision equal |
| Calibrated | 24 | 22 | 2 | within the scenario's relative tolerance, after the fit |
| Directional | 8 | 6 | 2 | same direction, effect within the scenario's factor band |

Approaches in the registry: 21 of 27 are named by at least one scenario; 6 cannot be verified (below). Being named by a scenario means checked, not agreeing: several approaches appear in a check that is a known difference. Approaches that cannot be verified are not in the figure at all, in either direction.

Scenarios: 36, of which 17 are calibration data (they carry no checks; the fit uses them) and 19 carry the 46 checks. BLIS commit: `c79c7456`.
<!-- generated:parity-headline:end -->

## Calibration

The parameters of `src/sim/core/params.ts` that the fit sets are `mbu`, `mfu`, `hostMsBase` and `hostMsPerSeq`, per (model, GPU, tensor-parallel degree); the draft cost `specCost` and the link rate `linkGbps` are fitted on the pairs that have a speculative or prefill/decode calibration scenario. The method is a deterministic coordinate search in log space on a stated loss ([`conformance/calibration/fit.ts`](../conformance/calibration/fit.ts)); the values and every residual are committed in [`conformance/calibration/fitted.json`](../conformance/calibration/fitted.json) and a test refits from the references and compares.

<!-- generated:parity-calibration:start -->
| Pair | MBU | MFU | Host ms, fixed | Host ms, per sequence | Loss at defaults, at fit | Worst residual, time to first token | Worst residual, time per token |
|---|---|---|---|---|---|---|---|
| `llama-3.1-8b/b200/tp1` | 0.6 (default 0.6) | 0.681818 (default 0.5) | 1.16219 (default 1.5) | 0.00713199 (default 0.05) | 0.0438953, 0.0229969 | -22.4% | +8.7% |
| `llama-3.1-8b/h100/tp1` | 0.6 (default 0.6) | 0.666667 (default 0.5) | 1.44 (default 1.5) | 0.00569372 (default 0.05) | 0.0793852, 0.0228158 | +22.6% | +8.7% |
| `llama-70b/h200/tp4` | 0.980392 (default 0.6) | 0.463636 (default 0.5) | 9.91736 (default 1.5) | 0.0589457 (default 0.05) | 0.149187, 0.0254718 | +34.4% | +1.5% |

- `llama-3.1-8b/h100/tp1`: draft cost `specCost` 0.0001 (default 0.04); time per token +1.7% from BLIS's on `calib-8b-h100-spec`. BLIS prices its n-gram drafter at nothing, so the fit goes to the lower bound.
- `llama-3.1-8b/h100/tp1`: link rate `linkGbps` 323.81 Gbit/s (default 100); hand-over time +0.1% from BLIS's on `calib-8b-h100-pd`. BLIS's fabric is 400 Gbit/s InfiniBand at 0.811 of line rate, which is 324 Gbit/s.
<!-- generated:parity-calibration:end -->

A single MFU cannot bend the way BLIS's prefill cost does (short prompts cost more than the compute alone, long ones less per token), so time to first token is the weaker of the two timings: the fit leaves up to a third on the calibration scenarios, and the burst scenario below misses its tolerance. Time per token, which is memory-bound decoding, is close everywhere.

## Known differences

Each is a check that does not hold as stated. The values are the TypeScript model's, then BLIS's; the scenario file carries the same reason next to the check.

<!-- generated:parity-known:start -->
- **`autoscale-overload` / `wait-falls`** (directional). Mean time to first token, which here is queue wait, is lower with the autoscaler. TypeScript / BLIS: effect: 0.08289 / 0.4021. Both fall, by different amounts, because the two autoscalers react at different times and reach different sizes. The TypeScript rule is concurrency based and acts on the count of requests in flight: it adds a replica at 1.1 s, 2.1 s and 3.1 s (one per second, as the count crosses 8, 16 and 24), so with the 5 s load time the new replicas serve from 6.1, 7.1 and 8.1 s, four replicas in all. BLIS's saturation analyzer (the llm-d workload-variant autoscaler's token-based rule) compares the tokens in the queue and in KV memory with 80 percent of the pool, so it waits until the queue holds enough prompt tokens: its first added replica serves from 11 s, its second from 18 s, and it stops at three. The queue therefore drains later and less in BLIS, and mean time to first token falls to 0.40 of the fixed arm's (8.3 s against 20.7 s) where the TypeScript model's falls to 0.083 (1.7 s against 20.5 s). The rules differ by design; the direction is the same.

- **`kv-budget-70b-h200-tp4` / `kv-blocks-per-replica`** (exact). One tensor-parallel replica holds the same number of KV blocks in both simulators. TypeScript / BLIS: value: 74790 / 74760. The same accounting as kv-budget-8b-h100, per GPU, and the same device memory (an H200's 150,109,880,320 bytes, 139.80 GiB) and CUDA-graph estimate (1,159,725,056 bytes). Two terms remain. The activation peak: BLIS charges 5 bf16 hidden-state rows per token for four-way tensor parallelism (671,088,640 bytes), the TypeScript model keeps the residual stream whole and splits only the feed-forward width over four GPUs (634,650,624 bytes): 36.4 MB more per GPU in BLIS. And the weights: 35,276,193,792 bytes per GPU in BLIS (it sizes them from the model's graph, including normalisation weights and the rounding of each shard), 35,275,000,000 in the TypeScript model (70.55e9 parameters from the architecture, in BF16, over four). Together 37.6 MB per GPU, over 1,310,720 bytes per GPU-block, 29 blocks, plus one of rounding: 30 blocks (0.04%).

- **`kv-budget-8b-h100` / `kv-blocks-per-replica`** (exact). One replica holds the same number of KV blocks in both simulators. TypeScript / BLIS: value: 27928 / 27926. Both now follow vLLM's start-up sizing: pool = (ceil(device memory x utilisation) - weights - activation peak - CUDA-graph estimate) / block size (vllm/v1/worker/utils.py request_memory; vllm/v1/worker/gpu_worker.py determine_available_memory). Both use the memory the CUDA driver reports for an H100 80GB (85,029,158,912 bytes, 79.19 GiB), the same 1,159,725,056-byte graph estimate (the median of 22 vLLM start-up logs, from the BLIS registry), and weights of 16.06 GB and blocks of 2,097,152 bytes. What is left is the activation peak: BLIS charges 11 bf16 hidden-state rows per token of a full 8,192-token step (738,197,504 bytes, from NVIDIA's memory model through its registry), the TypeScript model sums the residual stream, the feed-forward buffers and the sampling logits (735,313,920 bytes). The 2.9 MB difference is 1.4 blocks, and with the rounding of 16,059,990,016 bytes of real weights against 16.06 GB it makes 2 blocks (0.007%). BLIS's pool, 27,926 blocks, is the figure its own run reports; its KV budget routine returns 27,927 before the engine builds the pool.

- **`routing-round-robin` / `pod-sequence`** (exact). Request i goes to the replica after the one request i-1 went to, wrapping after four (replicas are named by first use, since which replica starts is arbitrary). TypeScript / BLIS: 8 values differ, for example s2/r0: 1 / 0; s3/r0: 2 / 1; s4/r0: 3 / 0. The TypeScript model rotates strictly through the replicas (Envoy's round robin), so request i goes to replica i mod 4. The llm-d router has no such policy. The closest configuration, which BLIS ships as reference-configs/round-robin.yaml and runs here, is the max-score picker with no scorers: every replica ties and the picker rotates the tied candidates by a counter, but the scheduler first puts the candidates in a seeded random order before every pick (scheduler_profile.go:363-370 in the router fork, added by the fork's hosting change; outside hosting the order is Go map order, which is not fixed either), so the choice is uniformly random among the tied replicas, not a cycle. The fork's reference-configs README says so: "it does not rotate". BLIS's draw for this trace is deterministic for the pinned build and seed. There is no llm-d behaviour for the TypeScript policy to be consistent with; it models Envoy, not llm-d.

- **`routing-round-robin` / `requests-per-pod`** (exact). Twelve requests over four replicas is three each. TypeScript / BLIS: rank0: 3 / 4; rank1: 3 / 4; rank3: 3 / 1. Same cause as pod-sequence. A strict rotation gives 3, 3, 3, 3; llm-d's random choice among tied replicas gave 4, 4, 3, 1 for this trace (counts sorted from the busiest replica; deterministic for the pinned build and seed). The llm-d configuration is balanced only on average.

- **`tiers-offload` / `host-tier-hit-rate`** (directional). With the tier, a share of prompt tokens is served from host memory; without it, none is. TypeScript / BLIS: effect: 0.4984 / 0. BLIS reports a host-tier hit rate of zero in this run (`cpu_tier_hit_rate` in its Result; the per-request rows carry no external-token count either) although the run shows the tier working: a follow-up's scheduling delay is 56.6 ms with the tier against 41.1 ms without (the 15.5 ms is the copy of about 3,050 tokens of KV, 400 MB at about 26 GB/s), and the step that prefills it takes 12.6 ms against 63.1 ms, because the history is no longer recomputed. The TypeScript model reports that 49.8 percent of all prompt tokens came from host memory. I did not find why BLIS leaves the counter at zero for a reload that completes before the request is first scheduled (its lookup is recorded at first admission, and a request whose load has landed is scheduled without a new prefix lookup, blis-vllm batch_formation.go); the timing check below shows the effect on time to first token, which both report.

- **`timing-8b-h100-burst` / `ttft-mean`** (calibrated). Mean time to first token agrees with BLIS after calibration. TypeScript / BLIS: value: 0.7586 / 0.5452. Two things differ and both are visible in the per-request times (run `pnpm conformance:report timing-8b-h100-burst`; BLIS rows are in the reference). First, BLIS passes each request through an admission queue (a tokeniser pool with a per-token service time and a fixed delay, docs/guide/latency-models.md in inference-sim), so requests that arrive together reach its engine one after another: its first request is prefilled alone and sees its first token after 75 ms, where the TypeScript model's front end tokenises all 32 at once and its first step already carries 5 prompts (8,192 tokens) and ends after 242 ms. Second, a full 8,192-token prefill step takes about 139 ms in BLIS (steps between the groups of prompts it batches: 362 ms less 223 ms) and about 206 ms in the TypeScript model (448 ms less 242 ms): the fitted MFU of 0.667 is a compromise between BLIS's short prompts (the TypeScript model is faster than BLIS on 128 tokens: 41 against 52 ms) and its long ones (slower on 8,000: 284 against 214 ms, calibration scenario calib-8b-h100-isolated), because a single efficiency factor cannot bend like BLIS's size-dependent prefill cost. A burst is a queue of full prefill steps, so it sits on the steep end. The result is 39 percent more mean time to first token. Decoding agrees (time per token +6.3 percent, end to end +11.6 percent, both inside tolerance).

- **`timing-8b-h100-burst` / `throughput`** (calibrated). Output tokens per second over the run agree with BLIS after calibration. TypeScript / BLIS: value: 1678 / 1870. The same cause as in ttft-mean, seen from the other side: the burst's 32 prompts take longer to prefill in the TypeScript model (full 8,192-token prefill steps of 206 ms against BLIS's 139 ms), so the 6,400 generated tokens are spread over a longer span (the run ends later), and throughput is 10.3 percent lower, just outside the 10 percent tolerance. Decoding itself is within tolerance (time per token +6.3 percent).
<!-- generated:parity-known:end -->

Changes made to the model because the first comparison showed it wrong against the vLLM source (not recorded as differences): a finished request caches `prompt + output - 1` tokens, and a waiting request is admitted only when its whole input sequence fits in the free blocks. Both are in the model's history, with their sources in `src/sim/engine/`.

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
