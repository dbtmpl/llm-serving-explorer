# 01 · Single Request Lifecycle

## What Happens

A single 256-token prompt arrives at a single colocated pod running **Llama 3.1 8B** (`bf16`) on one **NVIDIA A100 80GB SXM** GPU (`tp=1`, `block_size=16`).

1. **Arrival, Admission & Routing:** The gateway admits `request_0` and routes it to `instance_0`.
2. **Prefill (`request.prefill`):** All 256 prompt tokens are processed together in one compute-heavy prefill step, allocating 16 KV cache blocks (`256 / 16 = 16`).
3. **Decode (`request.decode_step`):** The engine generates 64 output tokens one step at a time, allocating 4 additional KV blocks as the sequence grows and reading the entire KV cache from HBM on every step (memory-bandwidth bound).
4. **Completion:** When the 64th token is emitted (`request.finished`), the request's KV blocks transition to `cached` (`kv.block.cached`) for future prefix reuse.

## What to Watch in the Visualization

- **Request Timeline:** Compare the single wide **prefill** bar against the 64 narrow **decode** steps. Notice that total decode time dominates end-to-end latency (`e2e_us`) even for 64 tokens.
- **KV Cache View:** Watch 16 prompt blocks allocate at prefill, 4 more blocks allocate incrementally during decode, and all prefix blocks turn into cached blocks at finish.
- **Batch & Roofline:** Contrast the high arithmetic intensity of the prefill step (`batch.step` with `tokens=256`) against the low arithmetic intensity of each single-token decode step (`tokens=1`, HBM-bandwidth bound).

## BLIS Configuration

- Model & GPU preset (ADR 0003): `llama-3.1-8b-instruct` on `a100-sxm` (`Llama 3.1 8B · A100 80GB`, closest calibrated A100; 40GB is absent from the BLIS hardware catalog).
- Explicit `block_size: 16` and `max_model_len: 8192` in `scenario.yaml`, with `--num-requests 1 --prompt-tokens 256 --output-tokens 64`.
