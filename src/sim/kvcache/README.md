# KV cache

How the KV cache is laid out, reused, evicted, tiered, reloaded and reclaimed. This module owns several decisions; each has its own interface.

## Supported approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against BLIS | Sources |
|---|---|---|---|---|---|
| KV cache layout | Paged KV blocks (PagedAttention) | KV memory is handed out in fixed 16-token blocks as tokens are written, like virtual-memory pages. | Structural | Yes: 4 scenarios | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| Prefix reuse | Block-hash prefix cache | Reuse whole KV blocks whose entire token prefix matches; always compute the last token. | Exact | Yes: 4 scenarios | [vLLM docs, prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html); [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
| Eviction order | LRU, whole session | Evict the idle session that was used longest ago. | Simplified | Yes: `eviction-pressure`, `tiers-offload` | [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708); [vLLM docs, prefix caching](https://docs.vllm.ai/en/latest/design/prefix_caching.html) |
| KV tiers | HBM → DRAM → SSD → shared pool | Idle sessions move down a memory hierarchy instead of being dropped, and are loaded back on return. | Structural | Yes: `tiers-offload` | [Gao et al., USENIX ATC 2024](https://arxiv.org/abs/2403.19708); [Qin et al., FAST 2025](https://arxiv.org/abs/2407.00079); [Liu et al., 2025 (LMCache)](https://arxiv.org/abs/2510.09665); [llm-d docs, KV offloader](https://github.com/llm-d/llm-d/blob/main/docs/architecture/kv-management/kv-offloader.md); [NVIDIA Dynamo docs](https://docs.nvidia.com/dynamo/latest/) |
| Reload decision | Adaptive load-or-recompute | Load KV from a lower tier only when copying is faster than prefilling again. | Simplified | Not verifiable | [Liu et al., 2025 (LMCache)](https://arxiv.org/abs/2510.09665); [Liu et al., SIGCOMM 2024](https://arxiv.org/abs/2310.07240) |
| Preemption | Preempt newest, recompute | Free the most recently admitted sequence and prefill it again later. | Exact | Yes: `preemption-overflow` | [vLLM source, scheduler.py](https://github.com/vllm-project/vllm/blob/main/vllm/v1/core/sched/scheduler.py); [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html); [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180) |
<!-- generated:approaches:end -->

Fidelity: **Exact** reproduces a published formula or rule and is tested against it. **Structural** follows the source's mechanism with our own constants, exposed as parameters. **Simplified** is a stand-in whose docstring says what is left out.

## Interface

| Decision | Interface | File |
|---|---|---|
| Layout | constants and `blocksFor` | [`blocks.ts`](blocks.ts) |
| Prefix reuse | `PrefixMatcher.reusableTokens(cached, context)` | [`prefix.ts`](prefix.ts) |
| Eviction order | `EvictionPolicy.pickVictim(candidates)` | [`eviction.ts`](eviction.ts) |
| Reload decision | `ReloadPolicy.shouldLoad(loadSeconds, recomputeSeconds)` | [`reload.ts`](reload.ts) |
| Preemption | `PreemptionPolicy.pickVictim(running, requester)` | [`preemption.ts`](preemption.ts) |
| Tier mechanics | functions on pod state | [`hbm.ts`](hbm.ts), [`tiers.ts`](tiers.ts), [`pool.ts`](pool.ts) |
| Forced eviction | `evictIdleNow(w, sid, podId?)`, called only by the step-through walkthrough; it runs the same `demote` as a real eviction | [`forced.ts`](forced.ts) |

Each decision currently has one approach, bound to a constant (`PREFIX_MATCHER`, `EVICTION`, `RELOAD`, `PREEMPTION`). A second approach turns that constant into a parameter.

## Adding an approach

1. Create one file for the approach in this directory. Implement the interface below and nothing else.
2. Give it a docstring that states the source, the rule or formula in the source's notation, a worked example with numbers, and what is simplified or left out.
3. Add the source to [`../citations.ts`](../citations.ts) if it is not there yet, and list its key in the approach's `citations`.
4. Register the approach in this module's `index.ts`.
5. Add unit tests in `__tests__/` that check the implementation against the source: the worked example from the docstring, the edge cases the source names, and one test of the behaviour inside the engine.
6. Run `pnpm docs:sync` to regenerate the tables, then `pnpm test`.

The general rules are in [`../README.md`](../README.md#rules).

## Not modelled

- Token-granular prefix matching (SGLang RadixAttention).
- Chunk-level eviction (Pensieve) and queue-aware eviction (CachedAttention look-ahead).
- Swap-based preemption and live migration (Llumnix).
- KV compression (CacheGen), write-through at the end of a turn, prefetch at routing time, and overlap of loading with compute.
