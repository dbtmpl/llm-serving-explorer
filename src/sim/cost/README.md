# Cost model

How long an engine step takes and how much memory there is for KV. Closed-form quantities, each tied to a source and checked against worked numbers.

## Supported approaches

<!-- generated:approaches:start -->
| Concept | Approach | What it does | Fidelity | Verified against | Sources |
|---|---|---|---|---|---|
| Cost model | Roofline step time | A step takes the longer of FLOPs over peak compute and bytes over memory bandwidth. | Exact | BLIS: 20 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Williams et al., CACM 2009](https://doi.org/10.1145/1498765.1498785) |
| Cost model | FLOPs per token | 2N per token through the weights, plus an attention term linear in context length. | Exact | BLIS: 20 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kaplan et al., 2020](https://arxiv.org/abs/2001.08361); [Vaswani et al., NeurIPS 2017](https://arxiv.org/abs/1706.03762) |
| Cost model | KV bytes per token and memory budget | Two vectors per layer and KV head per token; the KV pool is what weights, activations, CUDA graphs and headroom leave of the memory the driver reports. | Exact | BLIS: `kv-budget-8b-h100`, `kv-budget-70b-h200-tp4`; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [Kwon et al., SOSP 2023](https://arxiv.org/abs/2309.06180); [vLLM docs, engine arguments](https://docs.vllm.ai/en/latest/configuration/engine_args.html); [vLLM source, worker memory profiling](https://github.com/vllm-project/vllm/blob/main/vllm/v1/worker/gpu_worker.py); [BLIS substrate registry, cost-model-memory](https://github.com/inference-sim/blis-substrate/blob/main/registry/coefficients/cost-model-memory.yaml) |
| Cost model | Tensor parallelism | Weights and KV are split evenly over the GPUs of a pod; compute and bandwidth add up. | Simplified | BLIS: 7 scenarios | [Shoeybi et al., 2019](https://arxiv.org/abs/1909.08053) |
| Cost model | Host time per step | A fixed plus per-sequence CPU cost that adds to, or overlaps with, GPU time. | Simplified | BLIS: 20 scenarios; Measured vLLM: `measured-8b-rtx-pro-6000`, `measured-8b-rtx-4090` | [vLLM docs, optimization](https://docs.vllm.ai/en/latest/configuration/optimization.html) |
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
