# 05 · Memory Tiers (GPU HBM ↔ CPU DRAM)

## What Happens

Using `gpu_memory_utilization: 0.25` (1,935 GPU KV blocks) together with BLIS's `offload:` block (`OffloadingConnector`, `TieringOffloadingSpec`, `4 GiB` `cpu_dram` tier = `2,048` CPU KV blocks), 45 requests sharing two 512-token system prompts arrive in a 2-second burst (`25 req/s`) followed by a `5 req/s` tail:

1. **Offload (`direction: "offload"`):** As GPU HBM fills up, cached KV blocks evicted from GPU HBM are copied over PCIe into `cpu_dram` (`kv.block.moved` with `from_tier: "gpu"`, `to_tier: "cpu_dram"`) rather than being discarded.
2. **Reload (`direction: "load"`):** When a later request shares a prefix whose blocks were evicted from GPU HBM but still reside in `cpu_dram`, vLLM reloads those blocks back into GPU HBM (`kv.block.moved` with `from_tier: "cpu_dram"`, `to_tier: "gpu"`), avoiding full prefill recomputation (`cpu_hit_tokens > 0`).

> **Scope note:** BLIS v0.32.0 (`blis-vllm`) models **GPU HBM** and **Host CPU DRAM (`cpu_dram`)** via `OffloadingConnector`. Secondary NVMe SSD and remote S3/object storage tiers are **not modelled** in BLIS v0.32.0 (`local_ssd_modelled: false`, `remote_store_modelled: false` in the stream header).

## What to Watch in the Visualization

- **Memory Tiers View:** Watch CPU DRAM occupancy climb as GPU HBM overflows (`offload` moves), and watch `load` arcs fire back into GPU HBM on subsequent shared-prefix arrivals.
- **KV Cache View:** Compare `kvUsedBlocks` on GPU against `cpuUsedBlocks` on host memory.

## BLIS Configuration

- `llama-3.1-8b-instruct` on `a100-sxm`, `block_size: 16`, `gpu_memory_utilization: 0.25`, `cost-model-offload-tiers` coefficient set, and top-level `offload: { connector: OffloadingConnector, spec: TieringOffloadingSpec, eviction_policy: lru, tiers: [{ tier: cpu_dram, bytes: 4294967296 }] }`.
