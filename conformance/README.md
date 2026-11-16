# Conformance with references

Tests that compare the TypeScript model in `src/sim/` with external references. A reference is a simulator that is run or measured data that is reduced; each is one module under `refs/<id>/` that implements the `Reference` interface (`refs/reference.ts`). There are two: [BLIS](https://github.com/inference-sim/inference-sim), a discrete-event simulator that runs the real llm-d router (its Endpoint Picker, in process) in front of a Go translation of vLLM's scheduler. and measured vLLM (`vllm-measured`: real per-request timings, engine settings and KV block counts from two published vLLM runs, one RTX PRO 6000 and one RTX 4090). The aim is to show, scenario by scenario, where the model is consistent with llm-d and vLLM behaviour and with real hardware, and to record exactly where it is not.

**What agreement shows, and what it does not.** BLIS embeds the llm-d router's own code and ports vLLM 0.32's scheduler with references to the vLLM source lines, so a check that passes is strong evidence that the TypeScript model makes the same decision as those systems for that situation. It is not proof against a live cluster: BLIS is itself a simulator (its router sees scraped metrics that BLIS generates, its engines are modelled, not real), the scenarios are small and constructed, and timings are calibrated to BLIS, not measured. [`docs/parity.md`](../docs/parity.md) says what the agreement does and does not show, how it is produced, and lists every known difference with its reason. A difference is equally informative: each one in [`scenarios/`](scenarios/) is investigated, explained in the scenario file, and pinned so that it cannot change silently.

## Running it

```bash
pnpm test:conformance                         # the suite; Node only, needs neither Go nor BLIS
pnpm conformance:report [<id>]                # print every check's outcome (and differences) without asserting
BLIS_BIN=/path/to/blis pnpm conformance:reference [--ref <id>] [--only <id>] [--keep <dir>]   # regenerate the references
pnpm conformance:calibrate                    # refit the timing parameters to the committed references; writes calibration/fitted.json
pnpm conformance:summary                      # write summary.json and print the headline figure
pnpm docs:sync                                # regenerate the README tables and the generated parts of docs/parity.md
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
- **The rule on tolerances.** A tolerance may be set or changed only by a dated, recorded decision with a reason that does not depend on the observed result (the decision of 2026-11-16 on capacities is in [`docs/parity.md`](../docs/parity.md)). Never loosen a tolerance, or change a scenario's parameters, to make a check pass.
- **Deviations.** Every check also has a deviation, computed by the suite (`deviation.ts`) whether or not it holds: the signed relative difference for a quantity or metric, the share of individual decisions that differ for an exact check, the ratio of the two effects for a directional one. `pnpm conformance:report` prints it with both values and the tolerance; `summary.json` carries every check's row and the distribution per group, and the parity page and README lead with it. The count of checks that hold is the secondary figure.
- **The rule on differences.** A check passes as stated, or it carries a `known_difference`: a `reference` (which one it is a difference with), a `cause` (a few words, for the table of failing checks), optionally `by_design: true`, a `reason` (what each side does and why they differ; at least a paragraph's worth, enforced by length) and `differences`, the exact keys that differ with both values. Known differences are per reference. Where two references cover a check and disagree with each other, the check carries a `reference_gap` (reason and the exact values) and the model is held against the span of the references, a `known_difference` with `reference: span` recording a miss; a check never passes merely by matching the more convenient reference. The test asserts the observed difference equals the recorded one. It therefore fails if the difference disappears (the model was fixed: delete the record) and if it grows or changes (a new divergence). Never loosen a check or change a scenario's parameters to make it pass.
- **References** (`reference/<id>/*.json`). The reduced BLIS record plus `inputHash` (a hash of everything handed to BLIS: scenario file, router configuration, trace, arguments), the BLIS commit, and the catalogue and registry hashes from the BLIS Result. The suite fails when `inputHash` no longer matches the scenario (regenerate) or the commit differs from `refs/blis/lock`.
- **`refs/blis/lock`** pins the inference-sim commit (no submodule). The router configurations in `refs/blis/epp/` are byte copies of the ones that BLIS build ships (`blis router-configs --file ...`); the reference script checks that.

## Measured data as a reference

`refs/vllm-measured/` is a reference that runs nothing. Its data (`data/<gpu>-<model>.json`) is a reduction of the `vllm/` files of [LLMServingSim](https://github.com/casys-kaist/LLMServingSim)'s `bench/examples` at the commit in `refs/vllm-measured/lock` (MIT licence, kept as `LICENSE-LLMServingSim`): per request the client send time, token counts and first and last token times, the engine's settings and KV block count, and totals of the per-second statistics, with the SHA-256 of each source file. `LLMSERVINGSIM_DIR=<clone> pnpm conformance:extract` remakes it; `pnpm conformance:reference --ref vllm-measured` turns it into the records the tests read. `translate` refuses a scenario whose requests (arrival, input and output tokens) or engine settings differ from the run. Its scenarios (`measured-*`) carry two readings of timing side by side: `default-*` checks run the model with the site's default parameters over all requests (`params: defaults`), and `fitted-*` checks run it with parameters fitted to the first `split.calibration_requests` requests (`pnpm conformance:calibrate`) and are computed on the rest (`subset: held-out`). Never pool the two.

## Calibration

The cost model is a roofline (`src/sim/cost/`) with two achieved-rate factors and a host-time term; BLIS prices a step with a kernel model fitted to vendor kernel sweeps. `pnpm conformance:calibrate` fits `mbu`, `mfu`, `hostMsBase` and `hostMsPerSeq` per (model, GPU, tensor-parallel degree) to the BLIS references of the scenarios with `role: calibration` (they carry no checks), and `specCost` and `linkGbps` on the speculative and prefill/decode ones. The method (a deterministic coordinate search in log space, the loss, the bounds) is documented in [`calibration/fit.ts`](calibration/fit.ts); the committed result, with residuals and the site's defaults beside it, is [`calibration/fitted.json`](calibration/fitted.json). The fit never changes the defaults in `src/sim/core/params.ts`. A scenario with a calibrated or directional check needs a fit for its model and GPU, or the test says which one is missing.

Held-out scenarios (`timing-*`, `spec-decoding`, `pd-disaggregation`) use different load, prompt lengths and batch sizes than the calibration ones. When a fitted model misses a tolerance, the miss is a known difference with the numbers, not a retuned scenario.

## Scenario fields beyond the basics

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

## Results at the pinned commit (c79c7456)

The full list, with numbers and reasons, is in [`docs/parity.md`](../docs/parity.md); the machine-readable form is [`summary.json`](summary.json) (`pnpm conformance:summary`). Its headline is one figure: the share of checks on mechanisms BLIS also models that agree (exact, within tolerance or directionally), with the count of known differences beside it. Approaches that cannot be verified are not in it.

The first comparison also found two differences that the model was changed to remove: vLLM caches `prompt + output - 1` tokens after a turn (the last sampled token is never fed to the model), and vLLM 0.32 lets a waiting request in only when its whole input sequence fits in the free blocks (`scheduler_reserve_full_isl`), which stops a preempted request from being re-admitted on its first chunk and preempted again. The remaining differences, in short (the scenario files carry the full reasons):

- **KV block budget.** Both size the pool as vLLM does: `ceil(driver-reported memory x utilisation)` less weights, activation peak and a CUDA-graph estimate. A first comparison found the TypeScript model 6 to 8 percent short, because it used the datasheet memory (80 GB for an H100; the driver reports 85.03 GB) and left out the graphs; both are now in the model. What remains, 2 and 30 blocks, is the activation estimate (BLIS takes 11 or 5 hidden-state rows per token from NVIDIA's memory model, the TypeScript model sums the buffers) and rounding of the weights.
- **Round robin.** The llm-d router has no strict rotation: BLIS's `round-robin` configuration picks at random among tied replicas. The TypeScript policy models Envoy.

Scenarios where the queue-deadline check agrees rely on one translation assumption, stated in `refs/blis/translate.ts`: llm-d's flow control only holds requests when a saturation detector says the pool is full, and BLIS configures none by default, so the translator gives the router a `concurrency-detector` limit equal to the TypeScript router's own (`max_num_seqs + POD_QUEUE_SLACK` requests in flight per replica). The check shows that, given the same gate, the two shed the same requests; it does not show that the gate itself is the one llm-d deployments use.

## Not covered

Prefill/decode transfer contention, the SSD and shared-pool KV tiers, MI300X (not in BLIS's catalogue, and no measurement), and step-level comparison (BLIS has no event stream; see the plan). The approaches that cannot be verified, with the reason for each, are in the parity page.
