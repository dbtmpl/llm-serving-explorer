# ADR 0008: Step time and the memory budget follow the engine's settings and two measured vLLM runs

## Status

Accepted (2026-11-16). Changes the cost model of [ADR 0006](0006-modular-simulation-with-citations.md) (`src/sim/cost/`) and the calibration of [ADR 0007](0007-calibrated-replay-mode.md) (`conformance/calibration/`). The evidence is in [`docs/parity.md`](../parity.md).

## Context

The conformance suite gained a second reference: two real vLLM runs of Llama 3.1 8B (RTX PRO 6000, RTX 4090; 300 ShareGPT requests, per-request timings, the engine's own settings and KV block counts). Against it, with the site's default parameters, the model was badly wrong:

- time per output token 51 percent (RTX PRO 6000) and 58 percent (RTX 4090) too slow, time to first token +110 to +135 percent, throughput -33 and -45 percent (the engine is saturated, so queueing amplified the decode error);
- a fit pushed MBU to its upper bound of 1.0 on both cards;
- the KV pool was 1.3 percent (RTX PRO 6000) and 12.1 percent (RTX 4090) short.

Against BLIS, the 70B fit on four H200s landed at MBU 0.98 and 9.9 ms of host time: with one tensor-parallel degree in the data the fit cannot tell MBU from a constant, and the model had no term for tensor-parallel communication or for launching a step's kernels.

## Diagnosis

1. **The decode structure was right and the default was wrong.** From the runs' per-second statistics (running sequences, generated tokens per second, KV use), a decode step streamed its weights and the KV cache at 0.83 (RTX 4090) and 0.85 (RTX PRO 6000) of the datasheet bandwidth, regressing step time on bytes per step. At the largest batch of the 4090 run the step moved about 21.5 GB in 24.4 to 25.9 ms. The roofline `bytes / (bandwidth x MBU)` with weights read once per step and each sequence's KV read once is therefore the right shape; the default MBU of 0.6 made the 16 GB weight read alone 26.6 ms. Host time added to the GPU time (1.5 ms + 0.05 ms per sequence, about 3 ms of a 25 ms step), though both engines schedule asynchronously (`async_scheduling` true in `meta.json`), which hides host time behind the GPU.
2. **The activation term was sized for a step the engines did not run.** vLLM sizes the pool after a profiling pass: a forward pass over `max_num_batched_tokens` tokens, then the sampler over `min(max_num_batched_tokens, max_num_seqs)` rows of the vocabulary. The model sized it for 8,192 tokens and 256 rows whatever the settings, and charged a flat 1.16 GB for CUDA graphs, which vLLM computes from the capture list and, before v0.21, did not subtract at all.
3. **The model had no communication or launch term.** BLIS prices a batch-1 decode step of the 70B on four H200s at 17.15 ms, 7.35 ms of which is the weight stream; the rest includes tensor-parallel all-reduces (36 percent of an 8,192-token prefill step) and per-layer launch time that jumps above the CUDA-graph capture size. A roofline that takes `max(compute, memory)` plus one host constant had to put all of it in "host".

## Decision

- **Defaults.** MBU 0.85 (the measured stream, 0.83 and 0.85, rounded to the nearer), MFU 0.7 (the fits to the first 100 requests of both measured runs, 0.748 and 0.755, which see almost no queue, and BLIS's H100 fit, 0.714; rounded down), host time unchanged. The site keeps CPU/GPU overlap off by default, because the overlap switch is one of the architecture levers; the measured-run scenarios turn it on, as those engines ran (`async_scheduling`).
- **Step time.** `t_gpu = max(t_mem, t_compute) + t_comm + t_launch`. Memory and arithmetic overlap inside a GPU and take a maximum; the all-reduces and the launch gaps do not overlap them, so they add. `t_comm = 2 n_layers (alpha + tokens d 2 B 2(tp-1)/tp / (link eta))` for `tp > 1`: two all-reduces per layer (Shoeybi et al., 2019), a ring moving `2(n-1)/n` of the message per GPU (NCCL tests' bus-bandwidth definition), the NVLink or PCIe rate of the GPU from its datasheet (`link` in the catalogue), an efficiency and a fixed time per all-reduce as parameters. `t_launch = n_layers x (launchUs | launchEagerUs)`, the larger figure for a step above vLLM's largest captured size (`graphCaptureSizes`, from `_set_cudagraph_sizes`). The recompute cost used to price a reload against a recompute includes the same communication.
- **Memory.** `activations = max(forward pass over max_num_batched_tokens, sampler rows)` and `graphs = pool of the largest captured batch + 1 MiB per further graph`, from `profile_run`, `_dummy_sampler_run` and `profile_cudagraph_memory` of vLLM v0.31.0 (cited with lines in `src/sim/cost/memory.ts`). `ReplicaSpec` carries `maxNumBatchedTokens` and `maxNumSeqs`.
- **RTX PRO 6000 peak compute.** 503.8 TFLOP/s (BF16 tensor, FP32 accumulate, dense), from table 4 of NVIDIA's RTX Blackwell GPU architecture whitepaper (1007.6 with sparsity); the Server Edition's "1 PFLOP" is the sparse figure. The catalogue's 500e12 was right to within 1 percent; the suspicion that it was double the dense figure was not borne out.
- **Calibration.** One parameter set per (model, GPU), shared by all its tensor-parallel degrees; calibration scenarios for the 70B on H200 at TP 2 and TP 8 next to TP 4; bounds decided before the refit (MBU [0.4, 0.95], MFU [0.2, 0.9], justified in `conformance/calibration/fit.ts` from the two measured runs and BLIS's range); a report of any parameter at a bound; a loss profile of MBU and MFU (the loss with the parameter held at three values and the others refitted) that marks a parameter the data does not identify. A new reading of the measured runs: parameters fitted on the other card, over all 300 requests (`crossfit-*`), a held-out check that needs no split of one run.

## What the numbers say now

Default parameters against the two measured runs, before and after (each is a recorded check in `conformance/scenarios/measured-8b-rtx-*.yaml`):

| | RTX PRO 6000 before | after | RTX 4090 before | after | measured (PRO 6000 / 4090) |
|---|---|---|---|---|---|
| time per token | 47.5 ms | 29.5 ms | 51.4 ms | 39.5 ms | 31.4 / 32.4 ms |
| mean time to first token | 14.6 s | 5.6 s | 135.1 s | 70.9 s | 6.5 / 65.5 s |
| throughput | 2,067 tok/s | 3,187 tok/s | 590 tok/s | 979 tok/s | 3,068 / 1,066 tok/s |
| KV blocks | 36,174 | 36,956 | 2,274 | 2,953 | 36,649 / 2,588 |

Every default check on the RTX PRO 6000 now holds. On the RTX 4090 the time to first token, end-to-end time and throughput hold and the time per token is +22 percent.

Fits to BLIS and to the measured runs, before and after:

| | before | after |
|---|---|---|
| 70B on H200 (tp 4 alone; now tp 2, 4, 8 together): MBU | 0.98 | 0.52, flat (loss at 0.5, 0.7, 0.9: 0.0319, 0.0291, 0.0335) |
| host time | 9.9 ms | 0.12 ms |
| all-reduce efficiency, fixed time | none | 0.34, 2.8 microseconds |
| 8B on H100: MBU, MFU, host | 0.6, 0.667, 1.44 ms | 0.85, 0.714, 3.0 ms |

## What remains inexact

- **The KV pool is not exact.** The model sets aside 0.25 GB (RTX PRO 6000) and 0.47 GB (RTX 4090) for activations and graphs; the engines set aside 0.90 and 1.24 GB. The 0.65 and 0.77 GB left are memory the engine's profile counted outside torch's allocator and the real size of its graphs; no closed form derives them and no constant was fitted. The pool is 0.8 percent too large on the RTX PRO 6000 and 14.1 percent on the RTX 4090 (whose vLLM 0.19.0 does not subtract a graph estimate at all). Against BLIS, which charges a flat 1.16 GB for graphs, the pools differ by 2.2 percent (8B on H100) and 1.3 percent (70B on four H200s); BLIS's own overhead is also larger than either measured run's.
- **Recompute after a preemption.** The model recomputes a preempted request from zero. In vLLM its freed blocks stay in the prefix cache until reused. On the RTX 4090 the model recomputes 169,000 tokens (66 percent of the prompt tokens) and this, not the cost of a step, is the largest remaining error of that run (time per token +22 percent; +16 percent with the pool set to the engine's). It is an engine mechanism, not a cost; it was not changed here.
- **MBU of the 70B is not identified** by BLIS's data even with three tensor-parallel degrees: the loss is flat from 0.5 to 0.9. The fit reports it and stays inside the bounds.
- **The launch times per layer are BLIS's, and BLIS assumes them.** Its registry states that they come from conventional launch costs and one eager anchor, not from a measurement of vLLM. No public measurement was found.
- **The roofline takes a maximum where BLIS adds its resources.** Prefill time to first token on BLIS's calibration scenarios stays within +18 and -20 percent, and up to +67 percent for one long-prompt TP 8 scenario; the burst scenario still misses by +34 percent (it was +39).
- **MI300X** has no measured or BLIS data; its link rate is from AMD's product page and was not re-read.

## Consequences

- Visitors see, for a burst of 12 requests at the defaults, time per token on the default H100 and 8B fall from 15.5 to 12.6 ms (time to first token 2.88 to 2.66 s) and the KV pool of one H100 grow from 27,928 to 28,539 blocks; for the 70B on four H200s time per token goes from 22.6 to 21.7 ms and the pool from 74,790 to 75,768 blocks because the activation and graph terms are smaller (the default 12-sequence engine keeps 0.61 GB for them instead of 1.90); the preemption preset needed a smaller pool (0.28 instead of 0.3) to preempt.
- The activation term now depends on `max_num_batched_tokens`: the "static batching" architecture, with a budget of 65,536, keeps 4.8 GB for the pass, as vLLM would.
- Any later change to a cost term re-runs `pnpm conformance:calibrate` (minutes) and the known differences of the measured scenarios, which are recorded with the numbers at the time.

## Update, 2026-11-17

Two of the inexact points above were acted on.

- **Memory outside the derived terms.** `RUNTIME_OVERHEAD_BYTES` (src/sim/cost/memory.ts) subtracts 0.7 GB per GPU, the rounded midpoint of the 0.64 and 0.77 GB the two measured runs left unexplained. It is empirical and stated as such. The KV pool is now -0.07 percent on the RTX PRO 6000 and +1.2 percent on the RTX 4090; against BLIS, +1.0 percent (8B, H100) and +0.6 percent (70B, four H200s), because BLIS charges an assumed 1.16 GB median for graphs. The preemption-overflow decision agrees with BLIS again (one preemption). On one H100, 70B in FP8 now holds 3.9 average requests and is flagged as a very small pool.
- **Recompute after a preemption.** With prefix caching on, a preempted request's full blocks stay as an idle cached entry that the pool trims from the tail before evicting anything whole, as vLLM's free queue does (src/sim/kvcache/pool.ts). On the RTX 4090 the default time per token went from +22 to +10.6 percent and holds; the median end-to-end time is +16.4 percent against 15. The fit to that run still reaches its MBU bound, so what remains is not identified.

