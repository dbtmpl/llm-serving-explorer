# Conformance with BLIS

Tests that compare the TypeScript model in `src/sim/` with [BLIS](https://github.com/inference-sim/inference-sim), a discrete-event simulator that runs the real llm-d router (its Endpoint Picker, in process) in front of a Go translation of vLLM's scheduler. The aim is to show, scenario by scenario, where the model is consistent with llm-d and vLLM behaviour, and to record exactly where it is not.

**What agreement shows, and what it does not.** BLIS embeds the llm-d router's own code and ports vLLM 0.32's scheduler with references to the vLLM source lines, so a check that passes is strong evidence that the TypeScript model makes the same decision as those systems for that situation. It is not proof against a live cluster: BLIS is itself a simulator (its router sees scraped metrics that BLIS generates, its engines are modelled, not real), the scenarios are small and constructed, and nothing here compares timing yet. A difference is equally informative: each one in [`scenarios/`](scenarios/) is investigated, explained in the scenario file, and pinned so that it cannot change silently.

## Running it

```bash
pnpm test:conformance                         # the suite; Node only, needs neither Go nor BLIS
pnpm conformance:report [<id>]                # print every check's outcome (and differences) without asserting
BLIS_BIN=/path/to/blis pnpm conformance:reference [--only <id>] [--keep <dir>]   # regenerate the references
```

`pnpm test` runs the conformance suite too. `pnpm test:conformance` exists so CI can show it as its own check and so that you can run it alone.

## How it works

```
conformance/scenarios/<id>.yaml   one neutral scenario: deployment, request list, checks, tolerances
        |                 \
translate/toTypescript.ts   translate/toBlis.ts      scenario -> Params + trace  |  scenario -> BLIS Scenario/Deployment YAML,
        |                          |                                              llm-d router config, trace (header + CSV)
run/typescript.ts           run/blis.ts              run headless; reduce to one record (record.ts)
        |                          |
        |                  reference/<id>.json       committed: reduced BLIS record + BLIS commit + catalogue/registry hashes
        \________ compare.ts ______/                 check by check: agree, or differ exactly as recorded
```

- **Scenario** (`scenarios/*.yaml`). Neutral names (`llama-3.1-8b`, `h100`) that `translate/names.ts` maps to each simulator's catalogue; engine settings; replica count; routing policy; optional `queue_deadline_s`; the requests as conversations (`session`, `at`, `gap_s`, `turns: [[newTokens, outputTokens], ...]`); and `checks`. YAML, because every tolerance and every explanation sits next to the thing it justifies and a reviewer needs no TypeScript to read it.
- **Request list.** Both simulators are given the same open-loop trace, so nothing is random. In the TypeScript model that is the `trace-replay` workload (`src/sim/workload/trace.ts`). In BLIS it is a trace with `session_context_growth: accumulate`, replayed with `--session-mode fixed-accumulate`: a follow-up round stores only the tokens it adds, and BLIS rebuilds `previous prompt + previous output + added tokens`, which is what the TypeScript model does too. Space rounds of a conversation further apart than any answer takes: the runner refuses a follow-up sent before the previous answer finished.
- **Checks.** Phase 1 has one kind, `exact`: integers and decisions that must be equal. A check names a `quantity` (`kv_blocks_per_replica`, `prefix_cached_tokens`, `routed_pod`, `requests_per_pod`, `session_pod_changes`, `preemptions`, `request_fate`), states its `claim`, and gives a one-line `tolerance` saying why equality is the right standard. Replicas are interchangeable, so `routed_pod` names them in order of first use.
- **The rule on differences.** A check passes as stated, or it carries a `known_difference`: a `reason` (what each simulator does and why they differ; at least a paragraph's worth, enforced by length) and `differences`, the exact keys that differ with both values. The test asserts the observed difference equals the recorded one. It therefore fails if the difference disappears (the model was fixed: delete the record) and if it grows or changes (a new divergence). Never loosen a check or change a scenario's parameters to make it pass.
- **References** (`reference/*.json`). The reduced BLIS record plus `inputHash` (a hash of everything handed to BLIS: scenario file, router configuration, trace, arguments), the BLIS commit, and the catalogue and registry hashes from the BLIS Result. The suite fails when `inputHash` no longer matches the scenario (regenerate) or the commit differs from `blis.lock`.
- **`blis.lock`** pins the inference-sim commit (no submodule). The router configurations in `translate/epp/` are byte copies of the ones that BLIS build ships (`blis router-configs --file ...`); the reference script checks that.

## Adding a scenario

1. Write `scenarios/<id>.yaml` (copy a similar one). Use only model/GPU pairs that both catalogues have and that BLIS has coefficients for; BLIS refuses others and says why.
2. Regenerate its reference: `BLIS_BIN=... pnpm conformance:reference --only <id>`.
3. `pnpm conformance:report <id>` shows each check. Where they agree, nothing more. Where they differ, find out why before writing anything: read the BLIS source (the Go module cache of the pinned build holds it) and the TypeScript code, and test the explanation. Then add `known_difference` with the reason and the printed `differences`.
4. `pnpm test:conformance`.

Pitfalls found so far: make decisions unambiguous (the TypeScript router sees exact pod state at once, llm-d scores from scraped metrics and an approximate prefix index, so close calls differ for reasons unrelated to the policies); space requests more than a metrics scrape (50 ms) apart when the router must see load; and BLIS refuses a pool that cannot hold one `max_model_len` sequence, so set `engine.max_model_len` when you shrink the pool.

## Bumping the pin

1. Check out the new inference-sim commit, build it with the Go version its `stack.json` names (`toolchain`), put the full commit hash in `blis.lock`.
2. `BLIS_BIN=<binary> BLIS_SRC=<checkout> pnpm conformance:reference` (with `BLIS_SRC` the script refuses a checkout that is not at the locked commit).
3. Read the diff of `reference/`. Anything that changed is BLIS changing behaviour: explain it or update the affected `known_difference`, then `pnpm test:conformance`.

The workflow `.github/workflows/blis-references.yml` does steps 1 and 2 on every change to `blis.lock`, the scenarios or the translators, and nightly, and fails if the regenerated references differ from the committed ones. The ordinary CI job (`conformance`) only reads them.

## Results at the pinned commit (c79c7456)

Numbers are the TypeScript model's, then BLIS's.

| Scenario | Check | Result | TypeScript / BLIS |
|---|---|---|---|
| kv-budget-8b-h100 | KV blocks per replica | known difference (2 blocks) | 27,928 / 27,926 |
| kv-budget-70b-h200-tp4 | KV blocks per replica | known difference (30 blocks) | 74,790 / 74,760 |
| prefix-cache | cached prefix tokens, 8 follow-ups on one replica | known difference (1 of 8) | s2/r2: 880 / 864 |
| routing-round-robin | pod sequence; requests per pod | known difference | 3,3,3,3 / 4,4,3,1 |
| routing-least-loaded | pod choice; requests per pod | agrees | |
| routing-prefix-aware | conversation stays on its replica; pod choice | agrees | |
| routing-prefix-aware | cached prefix tokens | known difference (4 of 8 follow-ups) | 2,480 / 2,464 |
| preemption-overflow | preemption count | known difference | 799 / 1 |
| preemption-overflow | both requests complete | agrees | |
| queue-deadline-shedding | which requests are shed | agrees | requests 9 to 14 shed in both |

The differences, in short (the scenario files carry the full reasons):

- **KV block budget.** Both size the pool as vLLM does: `ceil(driver-reported memory x utilisation)` less weights, activation peak and a CUDA-graph estimate. A first comparison found the TypeScript model 6 to 8 percent short, because it used the datasheet memory (80 GB for an H100; the driver reports 85.03 GB) and left out the graphs; both are now in the model. What remains, 2 and 30 blocks, is the activation estimate (BLIS takes 11 or 5 hidden-state rows per token from NVIDIA's memory model, the TypeScript model sums the buffers) and rounding of the weights.
- **Last generated token.** vLLM never stores the KV of the last token it samples, so a follow-up whose history is an exact multiple of 16 tokens reuses one block less than the TypeScript model does.
- **Round robin.** The llm-d router has no strict rotation: BLIS's `round-robin` configuration picks at random among tied replicas. The TypeScript policy models Envoy.
- **Full-prompt admission gate.** vLLM 0.32 admits a waiting request only if its whole prompt fits (`scheduler_reserve_full_isl`, default on). The TypeScript model admits on the first chunk and, in a constructed overflow, preempts the same request over a thousand times where vLLM waits.

Scenarios where the queue-deadline check agrees rely on one translation assumption, stated in `translate/toBlis.ts`: llm-d's flow control only holds requests when a saturation detector says the pool is full, and BLIS configures none by default, so the translator gives the router a `concurrency-detector` limit equal to the TypeScript router's own (`max_num_seqs + POD_QUEUE_SLACK` requests in flight per replica). The check shows that, given the same gate, the two shed the same requests; it does not show that the gate itself is the one llm-d deployments use.

## Not in phase 1

Tolerance-based checks (timing, throughput, ratios), a `verification` field on the approach registry, a scenario generator with a seed, and scenarios with several tiers, prefill/decode splits or autoscaling.
