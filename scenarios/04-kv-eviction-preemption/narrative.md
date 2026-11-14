# 04 · KV Cache Eviction & Preemption

## What Happens

Per ADR 0003, BLIS's calibrated A100 catalog entry is an 80 GB SXM GPU (`a100-sxm`), so we tighten the available KV cache budget using `gpu_memory_utilization: 0.22` in `scenario.yaml`, yielding **706 KV blocks** (`705` usable after vLLM's null guard block, or ~11,280 tokens).

Then 24 requests of `768` prompt + `128` output tokens (`56` blocks each at peak, `1,344` blocks total if all active) burst in at `40 req/s`:

1. **LRU Prefix Cache Eviction (`kv.block.evicted`):** As earlier requests finish, their KV blocks stay in the free-but-cached LRU pool. Incoming requests evict these cached blocks first (`destination: "dropped"`, `reason: "lru_eviction"`) to make room for new allocations.
2. **Running Request Preemption (`request.preempted`):** Once zero evictable cached blocks remain and active decode sequences keep growing, the scheduler runs out of free blocks and preempts tail-of-batch running requests—freeing their KV blocks and re-queuing them to recompute later (`request.scheduled` again).

## What to Watch in the Visualization

- **KV Cache View:** Watch `kvUsedBlocks` hit the `705`-block ceiling, cached blocks turn evicted (`kv.block.evicted`), and preempted requests suddenly release all their blocks (`freed_blocks`).
- **Request Timeline:** Spot preempted requests with a **preempted** gap followed by a second **prefill** recomputation before finishing.
- **Scheduler & Queue:** Observe requests moving back into the pod waiting queue when preempted.

## BLIS Configuration

- `llama-3.1-8b-instruct` on `a100-sxm`, `block_size: 16`, `max_model_len: 4096`, `gpu_memory_utilization: 0.22` (ADR 0003 note on simulating smaller KV memory partitions without editing the hardware catalog).
- `--num-requests 24 --rate 40 --prompt-tokens 768 --output-tokens 128`.
