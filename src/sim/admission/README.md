# KV admission

How much KV memory must be secured before a request may start.

## Supported approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against BLIS | Sources |
|---|---|---|---|---|---|
| KV admission | On-demand (paged) | Allocate blocks for the tokens scheduled this step; grow as the sequence grows. | Structural | Yes: `preemption-overflow`, `queue-deadline-shedding` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py) |
| KV admission | Whole prompt | Allocate blocks for the full prompt at admission; outputs grow on demand. | Structural | Not verifiable | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| KV admission | Reserve to completion | Reserve prompt plus max_tokens up front; admitted requests are never preempted. | Structural | Not verifiable | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [TensorRT-LLM docs](https://nvidia.github.io/TensorRT-LLM/); [Yu et al., OSDI 2022](https://www.usenix.org/conference/osdi22/presentation/yu) |
<!-- generated:approaches:end -->

Fidelity: **Exact** reproduces a published formula or rule and is tested against it. **Structural** follows the source's mechanism with our own constants, exposed as parameters. **Simplified** is a stand-in whose docstring says what is left out.

## Interface

```ts
interface AdmissionRule extends ApproachMeta {
  outputReservation(r): number;      // output tokens to budget for when checking the request can ever fit
  tokensToSecure(r): number;         // tokens of KV to allocate before joining the batch
  tokensToFit(r): number;            // tokens that must fit beside the other running sequences before it may start
  allocatesPrefillPerChunk: boolean; // whether a running prefill can find the pool empty
}
```

Selected by the `admission` parameter.

## Adding an approach

1. Create one file for the approach in this directory. Implement the interface below and nothing else.
2. Give it a docstring that states the source, the rule or formula in the source's notation, a worked example with numbers, and what is simplified or left out.
3. Add the source to [`../citations.ts`](../citations.ts) if it is not there yet, and list its key in the approach's `citations`.
4. Register the approach in this module's `index.ts`.
5. Add unit tests in `__tests__/` that check the implementation against the source: the worked example from the docstring, the edge cases the source names, and one test of the behaviour inside the engine.
6. Run `pnpm docs:sync` to regenerate the tables, then `pnpm test`.

The general rules are in [`../README.md`](../README.md#rules).

## Not modelled

- Watermarks that keep a share of the pool free (vLLM's `watermark`, default 0).
- Output-length prediction to reserve less than `max_tokens`.
