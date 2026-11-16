# Prefill/decode disaggregation

Which requests are prefilled on a separate pool, and what the hand-over costs.

## Supported approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against | Sources |
|---|---|---|---|---|---|
| Prefill/decode disaggregation | Decode-first with token threshold | Pick the decode pod first; use the prefill pool only when enough of the prompt is uncached there. | Structural | BLIS: `pd-disaggregation`, `calib-8b-h100-pd` | [llm-d docs, P/D disaggregation](https://github.com/llm-d/llm-d/blob/main/docs/architecture/disaggregation/pd-disaggregation.md); [Zhong et al., OSDI 2024](https://arxiv.org/abs/2401.09670); [Patel et al., ISCA 2024](https://arxiv.org/abs/2311.18677) |
<!-- generated:approaches:end -->

Fidelity: **Exact** reproduces a published formula or rule and is tested against it. **Structural** follows the source's mechanism with our own constants, exposed as parameters. **Simplified** is a stand-in whose docstring says what is left out.

## Interface

```ts
interface DisaggregationDecider extends ApproachMeta {
  usePrefillPool(uncachedPromptTokens: number, thresholdTokens: number): boolean;
}
```

Plus the pure helpers `nextPodRole`, `linkBytesPerSecond` and `transferSeconds`. Enabled by the `disagg` parameter.

## Adding an approach

1. Create one file for the approach in this directory. Implement the interface below and nothing else.
2. Give it a docstring that states the source, the rule or formula in the source's notation, a worked example with numbers, and what is simplified or left out.
3. Add the source to [`../citations.ts`](../citations.ts) if it is not there yet, and list its key in the approach's `citations`.
4. Register the approach in this module's `index.ts`.
5. Add unit tests in `__tests__/` that check the implementation against the source: the worked example from the docstring, the edge cases the source names, and one test of the behaviour inside the engine.
6. Run `pnpm docs:sync` to regenerate the tables, then `pnpm test`.

The general rules are in [`../README.md`](../README.md#rules).

## Not modelled

- Separate hardware or parallelism per pool, and per-pool autoscaling.
- Contention between concurrent transfers on one link.
- Layer-wise transfer overlapped with prefill.
