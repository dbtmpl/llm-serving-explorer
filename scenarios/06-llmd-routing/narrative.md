# 06 · llm-d Gateway Routing

## What Happens

Four replicas (`--num-instances 4`) of **Llama 3.1 8B · A100 80GB** sit behind BLIS's embedded **llm-d Endpoint Picker (EPP)** gateway serving 48 requests: 30% sharing system prompt `sys-a` (512 tokens), 30% sharing `sys-b` (512 tokens), and 40% unique prompts.

- **Prefix-Cache-Aware Routing (`router.yaml`):** Combines `approx-prefix-cache-producer` + `prefix-cache-scorer` (weight 3) with `queue-scorer` (weight 1) and `kv-cache-utilization-scorer` (weight 1). Once `sys-a` warms one pod and `sys-b` warms another, the router steers matching requests back to those warm pods while spreading unique requests across the remaining capacity.
- **Load-Only Baseline (`baseline.router.yaml`):** Drops the prefix scorer and spreads requests solely by queue depth and KV utilization, forfeiting cross-request prefix locality.

## What to Watch in the Visualization

- **Routing & Gateway View:** Inspect `request.routed` candidate tables (`candidates.length === 4`) to see how `prefix-cache-scorer` elevates the warm pod's score (`~4.67` vs `~2.00` for cold pods).
- **Cluster Topology:** Watch all 4 pods stay active while `sys-a` and `sys-b` stick to their sticky warm replicas.
- **Compare Mode:** Toggle `Load-Only Routing` to see `prefix_cache_hit_rate` and mean TTFT improve under prefix-aware scoring.

## BLIS Configuration

- `llama-3.1-8b-instruct` on `a100-sxm` (`block_size: 16`, ADR 0003), `--num-instances 4`, `EndpointPickerConfig` via `router.endpoint_picker_config`.
