# 03 · Automatic Prefix Caching

## What Happens

Eight requests share a **1,024-token system prompt** (`64` block-aligned KV blocks at `block_size=16`) followed by a 64-token user question and 32 output tokens, arriving at `2 req/s`:

1. **Cold Request (`request_0`):** No prefix blocks are cached yet (`cached_tokens: 0`). The pod computes prefill for all `1024 + 64 = 1088` tokens and, on completion, retains the prefix block hashes in the GPU radix/hash cache (`kv.block.cached`).
2. **Warm Prefix Hits (`request_1`..`request_7`):** Each subsequent request matches all **1,024 prefix tokens** (`cached_tokens: 1024` in `request.scheduled`) and only runs prefill compute for the 64 new suffix tokens, dramatically cutting Time to First Token (TTFT).

## What to Watch in the Visualization

- **KV Cache View:** Watch `request_0`'s 64 prefix blocks transition from `active` to `cached`, then notice subsequent requests reusing those exact block IDs instead of recomputing them.
- **Request Timeline:** Compare the wide prefill bar and higher TTFT of `request_0` against the short suffix-only prefill and lower TTFT of `request_1..7`.
- **Compare Mode:** Switch on the `Prefix Caching Disabled` baseline (`enable_prefix_caching: false`) to see mean TTFT jump when every request recomputes all 1,088 tokens from scratch.

## BLIS Configuration

- `llama-3.1-8b-instruct` on `a100-sxm` (`block_size: 16`, ADR 0003).
- `--prefix-tokens 1024 --prompt-tokens 64 --output-tokens 32 --rate 2 --num-requests 8`.
- `scenario.yaml` sets `enable_prefix_caching: true`; `baseline.scenario.yaml` sets `enable_prefix_caching: false`.
