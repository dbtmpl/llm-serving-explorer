# Engine

The loop that ties the modules together: admission, the step plan, the fleet, the router and the clock. It contains mechanics and no policy of its own; every decision is delegated to the module that owns it.

## Supported approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against BLIS | Sources |
|---|---|---|---|---|---|
| Step scheduling | Chunked prefill under a token budget | A long prompt is prefilled in chunks sharing each step with decodes, bounded by a per-step token budget. | Structural | Yes: `timing-8b-h100-burst`, `timing-8b-h100-heavy`, `preemption-overflow` | [Agrawal et al., OSDI 2024](https://arxiv.org/abs/2403.02310); [Agrawal et al., 2023](https://arxiv.org/abs/2308.16369); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py); [vLLM source, config/scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/config/scheduler.py) |
<!-- generated:approaches:end -->

Fidelity: **Exact** reproduces a published formula or rule and is tested against it. **Structural** follows the source's mechanism with our own constants, exposed as parameters. **Simplified** is a stand-in whose docstring says what is left out.

## Contents

| File | Contents |
|---|---|
| [`step.ts`](step.ts) | Plans a pod's next forward pass (decodes, prefill chunks, admissions), prices it and applies it |
| [`admit.ts`](admit.ts) | Takes a request from waiting to running, including reloads from lower tiers |
| [`fleet.ts`](fleet.ts) | Pod creation, lifecycle and scaling |
| [`router.ts`](router.ts) | Routing decisions and prefill-to-decode hand-over |
| [`tick.ts`](tick.ts) | The clock: arrivals, front-end hops, dispatch, telemetry |
| [`selectors.ts`](selectors.ts) | Read-only summaries |
| [`constants.ts`](constants.ts) | Numbers that belong to the loop itself |

## Extending

The order of work inside a step is the one piece of policy that lives here, because it is the loop. It follows vLLM's scheduler and Sarathi-Serve's chunked prefill and is listed below. `__tests__/behaviour.test.ts` holds a fingerprint of the full event stream for ten scenarios: a refactor must leave it untouched, and a deliberate change to the model updates it with `pnpm test -u` and says why in the commit.

The general rules are in [`../README.md`](../README.md#rules).

## Not modelled

- Encoder or multimodal inputs, LoRA adapters, structured output.
- Priority scheduling: requests are served first come, first served.
- Router lag: the router sees exact pod state.
