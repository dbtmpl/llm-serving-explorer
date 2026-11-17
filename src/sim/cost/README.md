# Cost model

How long an engine step takes and how much memory there is for KV. Closed-form quantities, each tied to a source and checked against worked numbers.

## Supported approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against | Sources |
|---|---|---|---|---|---|
| Cost model | Roofline step time | A step takes the longer of FLOPs over achieved compute and bytes over achieved memory bandwidth (MBU 0.85, MFU 0.7 by default), plus communication and launch time. | Exact | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Williams et al., CACM 2009](https://doi.org/10.1145/1498765.1498785); [NVIDIA RTX Blackwell GPU architecture whitepaper](https://www.nvidia.com/content/dam/en-zz/Solutions/design-visualization/quadro-product-literature/pdf/NVIDIA-RTX-Blackwell-PRO-GPU-Architecture-v1_1.pdf); [LLMServingSim, measured vLLM runs](https://github.com/casys-kaist/LLMServingSim/tree/49df63f2af61230da63dd2136044a2dbf9bd4161/bench/examples) |
| Cost model | FLOPs per token | 2N per token through the weights, plus an attention term linear in context length. | Exact | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kaplan et al., 2020](https://arxiv.org/abs/2001.08361); [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| Cost model | KV bytes per token and memory budget | Two vectors per layer and KV head per token; the KV pool is what weights, the start-up profiling pass (sized by max_num_batched_tokens and max_num_seqs), CUDA graphs and headroom leave of the memory the driver reports. | Exact | BLIS: `kv-budget-8b-h100`, `kv-budget-70b-h200-tp4`; LLMServingSim: `lss-kv-budget-8b-rtx-pro-6000`, `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090`; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM docs, engine arguments](https://docs.vllm.ai/en/latest/configuration/engine_args.html); [vLLM source, worker memory profiling](https://github.com/vllm-project/vllm/blob/main/vllm/v1/worker/gpu_worker.py); [vLLM v0.19.0 source, worker memory profiling](https://github.com/vllm-project/vllm/blob/v0.19.0/vllm/v1/worker/gpu_worker.py); [vLLM v0.31.0 source, start-up profiling pass and sampler](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/v1/worker/gpu_model_runner.py#L6409-L6440); [vLLM v0.31.0 source, CUDA graph capture sizes](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/config/vllm.py#L2388-L2420); [BLIS substrate registry, cost-model-memory](https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-memory.yaml) |
| Cost model | Tensor parallelism | Weights and KV are split evenly over the GPUs of a pod; compute and bandwidth add up, and two all-reduces per layer add communication time. | Simplified | BLIS: 17 scenarios | [Shoeybi et al., 2019](https://arxiv.org/abs/1909.08053); [Pope et al., 2022](https://arxiv.org/abs/2211.05102); [NCCL tests, performance notes](https://github.com/NVIDIA/nccl-tests/blob/master/doc/PERFORMANCE.md) |
| Cost model | Kernel launch time per layer | A fixed time per layer to launch a step's kernels, higher for a step too large for a captured CUDA graph. | Simplified | BLIS: 24 scenarios | [vLLM docs, CUDA graphs](https://docs.vllm.ai/en/latest/design/cuda_graphs/); [vLLM v0.31.0 source, CUDA graph capture sizes](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/config/vllm.py#L2388-L2420); [BLIS substrate registry, host overheads](https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-host-overheads.yaml) |
| Cost model | Host time per step | A fixed plus per-sequence CPU cost that adds to, or overlaps with, GPU time. | Simplified | BLIS: 30 scenarios; LLMServingSim: 10 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html) |
<!-- generated:approaches:end -->

Fidelity: **Exact** reproduces a published formula or rule and is tested against it. **Structural** follows the source's mechanism with our own constants, exposed as parameters. **Simplified** is a stand-in whose docstring says what is left out.

## Contents

| File | Contents |
|---|---|
| [`flops.ts`](flops.ts) | FLOPs per token, the attention term, the load of one sequence in a step |
| [`memory.ts`](memory.ts) | Weight bytes, KV bytes per token, the four memory pools of a GPU, the largest batch |
| [`roofline.ts`](roofline.ts) | Ridge point and step time under the roofline |
| [`throughput.ts`](throughput.ts) | The saturating decode-throughput curve |
| [`host.ts`](host.ts) | Host time per step and how it combines with GPU time |

## Extending

These are formulas, not interchangeable policies, so there is no interface to implement. A new quantity gets its own exported function with the same kind of docstring and a test of its worked example. A competing model of step time (for example one fitted to measurements) would be introduced as an interface here, with the roofline as its first implementation.

The general rules are in [`../README.md`](../README.md#rules).

## Not modelled

- Quantised KV caches, mixture-of-experts models and pipeline parallelism.
- Communication cost of tensor parallelism: rates simply add up across GPUs.
- Kernel-level effects such as CUDA graph capture or attention backend choice; they are folded into MBU and MFU.
