# Routing

Which pod gets the next request.

## Supported approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against BLIS | Sources |
|---|---|---|---|---|---|
| Routing | Round robin | Rotate through pods regardless of load or cache. | Exact | Yes: `routing-round-robin`, `routing-prefix-vs-round-robin` | [Envoy docs, load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) |
| Routing | Least loaded | Send to the pod with the fewest requests in flight. | Simplified | Yes: `routing-least-loaded` | [Envoy docs, load balancers](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers) |
| Routing | Prefix-cache aware | Weighted score of cached prefix, KV utilisation and queue depth, as in llm-d. | Structural | Yes: 4 scenarios | [llm-d docs, router scheduling](https://github.com/llm-d/llm-d/blob/main/docs/architecture/router/scheduling.md); [Gateway API Inference Extension](https://github.com/kubernetes-sigs/gateway-api-inference-extension) |
<!-- generated:approaches:end -->

Fidelity: **Exact** reproduces a published formula or rule and is tested against it. **Structural** follows the source's mechanism with our own constants, exposed as parameters. **Simplified** is a stand-in whose docstring says what is left out.

## Interface

```ts
interface RoutingPolicy extends ApproachMeta {
  score(c: CandidateFacts): number;
  pick(scores: readonly number[], cursor: number): { index: number; cursor: number };
}
```

Selected by the `routing` parameter. A policy sees only `CandidateFacts`: cached share, cache tier, KV utilisation, load and capacity.

## Adding an approach

1. Create one file for the approach in this directory. Implement the interface below and nothing else.
2. Give it a docstring that states the source, the rule or formula in the source's notation, a worked example with numbers, and what is simplified or left out.
3. Add the source to [`../citations.ts`](../citations.ts) if it is not there yet, and list its key in the approach's `citations`.
4. Register the approach in this module's `index.ts`.
5. Add unit tests in `__tests__/` that check the implementation against the source: the worked example from the docstring, the edge cases the source names, and one test of the behaviour inside the engine.
6. Run `pnpm docs:sync` to regenerate the tables, then `pnpm test`.

The general rules are in [`../README.md`](../README.md#rules).

## Not modelled

- Predicted-latency scoring, LoRA affinity and session stickiness.
- Scrape lag: the facts are exact and current.
- Approximate prefix indexes: the router knows exactly what each pod holds.
