# Decoding

How many tokens a sequence gains per engine step, and at what cost.

## Supported approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against | Sources |
|---|---|---|---|---|---|
| Decoding | Autoregressive | One token per sequence per step. | Exact | BLIS: 20 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| Decoding | Speculative decoding | A draft model proposes several tokens; the target verifies them in one pass. | Exact | BLIS: `spec-decoding`, `calib-8b-h100-spec`; LLMServingSim: `lss-spec-decoding`, `calib-lss-8b-rtx-pro-6000-spec` | [Leviathan et al., ICML 2023](https://arxiv.org/abs/2211.17192) |
<!-- generated:approaches:end -->

Fidelity: **Exact** reproduces a published formula or rule and is tested against it. **Structural** follows the source's mechanism with our own constants, exposed as parameters. **Simplified** is a stand-in whose docstring says what is left out.

## Interface

```ts
interface DecodeStrategy extends ApproachMeta {
  tokensThisStep(draw: () => number, s: DecodeSettings): number;
  positionsEvaluated(s: DecodeSettings): number;
  overheadFactor(s: DecodeSettings): number;
}
```

Selected by the `specDecode` parameter.

## Adding an approach

1. Create one file for the approach in this directory. Implement the interface below and nothing else.
2. Give it a docstring that states the source, the rule or formula in the source's notation, a worked example with numbers, and what is simplified or left out.
3. Add the source to [`../citations.ts`](../citations.ts) if it is not there yet, and list its key in the approach's `citations`.
4. Register the approach in this module's `index.ts`.
5. Add unit tests in `__tests__/` that check the implementation against the source: the worked example from the docstring, the edge cases the source names, and one test of the behaviour inside the engine.
6. Run `pnpm docs:sync` to regenerate the tables, then `pnpm test`.

The general rules are in [`../README.md`](../README.md#rules).

## Not modelled

- Draft-free variants (n-gram or suffix lookup) and tree-structured drafts.
- Acceptance that varies with the token or the context: α is one number.
