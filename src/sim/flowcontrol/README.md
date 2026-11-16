# Flow control

What happens to requests the fleet cannot serve in time.

## Supported approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against | Sources |
|---|---|---|---|---|---|
| Flow control | Deadline shedding | Reject requests that have waited at the router longer than a time-to-live. | Simplified | BLIS: `queue-deadline-shedding` | [llm-d docs, flow control](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/flow-control.md) |
<!-- generated:approaches:end -->

Fidelity: **Exact** reproduces a published formula or rule and is tested against it. **Structural** follows the source's mechanism with our own constants, exposed as parameters. **Simplified** is a stand-in whose docstring says what is left out.

## Interface

```ts
interface SheddingPolicy extends ApproachMeta {
  shouldShed(waitedSeconds: number, deadlineSeconds: number): boolean;
}
```

Controlled by the `shedAfterS` parameter.

## Adding an approach

1. Create one file for the approach in this directory. Implement the interface below and nothing else.
2. Give it a docstring that states the source, the rule or formula in the source's notation, a worked example with numbers, and what is simplified or left out.
3. Add the source to [`../citations.ts`](../citations.ts) if it is not there yet, and list its key in the approach's `citations`.
4. Register the approach in this module's `index.ts`.
5. Add unit tests in `__tests__/` that check the implementation against the source: the worked example from the docstring, the edge cases the source names, and one test of the behaviour inside the engine.
6. Run `pnpm docs:sync` to regenerate the tables, then `pnpm test`.

The general rules are in [`../README.md`](../README.md#rules).

## Not modelled

- Priority bands, tenant fairness and queue capacity limits.
- Eviction of requests already running.
