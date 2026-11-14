# ADR 0003: Default Model and GPU Presets

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

Fact `presets` states:
> The default setup is Llama 3.1 8B on one A100 40GB per pod, with Llama 3.1 70B on H100 80GB as a second preset, provided BLIS ships calibrated data for them; otherwise the closest calibrated model and GPU are used and named.

We audited `blis-substrate@v0.14.0/catalog/` (`models/` and `hardware/`) and `registry/coefficients/` and ran trial simulations for both configurations.

## Catalog Findings

1. **Models in catalog:**
   - `llama-3.1-8b-instruct` (present, dense GQA 32Q/8KV heads, 32 layers, `hidden_size: 4096`, `bf16`)
   - `llama-3.1-70b-instruct` (present, dense GQA 64Q/8KV heads, 80 layers, `hidden_size: 8192`, `bf16`)
2. **GPUs in catalog (`catalog/hardware/`):**
   - `a100-sxm.yaml` / `a100-80.yaml`: **80.0 GiB**, `312 TFlopsPeak`, `2.039 TB/s` HBM bandwidth. (**No 40 GB A100 entry exists in BLIS's catalog.**)
   - `h100.yaml`: **79.1896 GiB** (CUDA-reported 80 GB HBM3), `989.5 TFlopsPeak` (`1979.0 TFlopsFP8`), `3.35 TB/s` HBM bandwidth.
   - Other catalog GPUs: `h200`, `l40s` (48 GiB), `b200`, `b300`, `gb200-nvl72`, `gb300`.
3. **Trial runs:**
   - `llama-3.1-8b-instruct` on `a100-sxm` (TP1, `block_size: 16`): **Succeeded** (`94/135` evidenced coefficients: 79 measured, 15 vendor_spec). Requires explicit `block_size: 16` in the scenario because compute capability `8.0` with `kv_cache_dtype: auto` does not resolve an implicit default block size in `blis-vllm`.
   - `llama-3.1-70b-instruct` on `h100` (FP8, TP2, `block_size: 16`, matching `testdata/kernel/aisimulate/llama-3.1-70b-instruct-h100-fp8-vllm-tp2.yaml`): **Succeeded** (`119/162` evidenced coefficients: 105 measured, 14 vendor_spec). Note: BF16 70B weights (~140 GB) exceed a single 80 GB H100, so TP=2 FP8 (2× H100 80 GB per pod) is the closest calibrated H100 configuration for Llama 3.1 70B (and also naturally exercises multi-GPU tensor parallelism!).

## Decision

1. **Default Preset (`llama-3.1-8b-a100`):**
   - Model: `llama-3.1-8b-instruct`
   - GPU: `a100-sxm` (**NVIDIA A100-SXM4-80GB**, 1 GPU / TP=1 per pod, `block_size: 16`)
   - Display label: **`Llama 3.1 8B · A100 80GB (closest calibrated A100; 40GB not in BLIS catalog)`**
   - Note: For scenarios that demonstrate KV cache pressure, eviction, and preemption (e.g. Scenarios 4 & 5), `gpu_memory_utilization` is set explicitly in the scenario YAML (e.g. `0.25–0.35`, yielding a tight KV block budget equivalent to a smaller memory partition) rather than editing BLIS's hardware catalog.
2. **Second Preset (`llama-3.1-70b-h100`):**
   - Model: `llama-3.1-70b-instruct` (FP8 quantization)
   - GPU: `h100` (**NVIDIA H100 SXM5 80GB**, TP=2 per pod, `block_size: 16`, directly matching BLIS's AISimulate calibrated scenario)
   - Display label: **`Llama 3.1 70B (FP8, TP=2) · H100 80GB`**

## Consequences

- Both presets use 100% calibrated, embedded BLIS catalog entries with zero catalog modifications.
- The absence of A100 40GB and the TP=2 requirement for 70B on 80GB H100 are transparently surfaced in preset labels and on the Accuracy page.
