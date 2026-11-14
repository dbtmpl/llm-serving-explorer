# Design choices, and where sources disagree

The simulation (`src/sim/`) is a teaching model. This page records, per topic, what the sources say, where they differ, and which reading the model takes. Checked on 2026-11-14 against the vLLM docs, the llm-d dev docs, NVIDIA Dynamo's KVBM docs and the papers named below. Version-dependent facts are marked.

## Engine

| Topic | What sources say | What the model does |
|---|---|---|
| Step scheduling order | vLLM V1 with chunked prefill "prioritizes decode requests" and fills the rest of `max_num_batched_tokens` with prefill chunks. Earlier vLLM and a 2024 survey describe it as prefill-prioritised; Baseten says its runtime prioritises prefill. | Decode first, then prefill chunks under a token budget. |
| KV needed to admit | vLLM allocates blocks for the tokens scheduled this step and preempts when the pool runs out. TensorRT-LLM's example `GuaranteedNoEvictScheduler` reserves to completion and never preempts. The original PagedAttention design allocates the whole prompt at admission. | Selectable: next chunk (default, vLLM), whole prompt, prompt + max_tokens. |
| Preemption | vLLM V1: recompute is the default and swap was removed. Llumnix argues swap or migration wins at long contexts. Victim is the newest running request under FCFS. vLLM admits nothing new in a step that preempted. | Recompute, newest first, no admission in a preempting step. Thrashing under overload is reproduced, not hidden. |
| Prefix cache granularity | vLLM hashes full blocks; a partial last block is not reusable. SGLang uses a radix tree over tokens. | Hits are rounded down to whole 16-token blocks. |
| `gpu_memory_utilization` default | 0.9 in older vLLM and in Ray's docs; current vLLM docs say 1.0 on CUDA and ROCm. | Slider, default 0.9, noted in the UI. |
| `max_num_seqs` | The vLLM default is 128 (`SchedulerConfig.DEFAULT_MAX_NUM_SEQS` in `vllm/config/scheduler.py`). | 12 by default so a batch is visible. Explained in the scale-up text. |
| Host time per step | First-party numbers range from a few ms to tens of ms under load. | A parameter (1.5 ms + 0.05 ms per sequence), with an overlap switch. |
| Speculative decoding | Leviathan et al. (ICML 2023): tokens per target run = (1 − α^(γ+1)) / (1 − α) (eq. 1); speed-up = that ÷ (γc + 1) (theorem 3.8). Measured α 0.53 to 0.89 for neural drafts, c 0.02 to 0.11, speed-ups 1.4 to 3.4×, all at batch 1. | The same capped-geometric rule with sliders for γ, α and c (defaults 4, 0.7, 0.04). A unit test checks tokens per step and speed-up against both formulas. At larger batches the verify pass still costs little here because decode is memory-bound; the paper does not measure that case. |

## KV tiers

| Topic | What sources say | What the model does |
|---|---|---|
| Tier order | llm-d's native path is HBM → CPU RAM → a shared filesystem (or peer-to-peer pulls from other pods' CPU tiers); only the CPU tier talks to the GPU directly. Local SSD appears in CachedAttention, Mooncake's client and Dynamo's G3. | HBM → DRAM → local SSD → shared remote pool. With SSD set to 0 it matches llm-d's native order. |
| Tier names | Dynamo KVBM docs define G1 (device), G2 (host memory), G3 (local or pooled SSD), G4 (remote storage). NVIDIA's BlueField-4 context-memory material and secondary sources add a pod-level "G3.5"; some read it as replacing G3. | HBM, DRAM, SSD, remote pool. G-names mentioned in the dive-in panel; no G3.5. |
| When blocks go down a tier | CachedAttention: on eviction, by a look-ahead over the job queue. vLLM's OffloadingConnector (0.11) and llm-d's `kv-offloader.md`: asynchronously in the background, never blocking inference; the CPU tier evicts by LRU or ARC; the shared filesystem tier never evicts on its own. Mooncake's client writes to DRAM and persists to SSD asynchronously, spilling at a 95% watermark. SGLang HiCache: write-through, selective write-through or write-back. One reading: write-back at end of turn, demote by age. | On eviction only, when room is needed. |
| Eviction unit | Whole session (CachedAttention), 32-token chunks from the leading end (Pensieve), 256-token chunks (LMCache), pages or blocks (vLLM, HiCache, Mooncake). | Whole session, least recently used first. |
| Is a load free? | CachedAttention and HiCache hide loads behind compute layer by layer. LMCache finds loading over 32 Gbps beats prefill only beyond about 256K tokens and says loading should be adaptive. | Adaptive: load only when faster than recompute. No layer-wise overlap, no prefetch at routing time. |
| Transfer rates | Host memory to GPU: PCIe 5 x16 is 64 GB/s per direction at best; measured 10.8 GB/s (SGLang HiCache baseline) to 40 to 49 GB/s (Strata), 26 GB/s on PCIe 4 (CachedAttention); 65 KB copies reach about 12% of the link, 1 to 2 MB copies 75 to 80%. SSD: 1.6 GB/s (FlexGen) to 12 GB/s (ServerlessLLM RAID0). Network: LMCache studies 32 to 128 Gbps. | Sliders with defaults inside those ranges: 20 GB/s, 4 GB/s, 64 Gbps. |
| What survives a lost node | Nothing in a KV tier is durable; the conversation text is the system of record. | Node tiers die with the pod; the remote pool and the conversation store survive. |

## Routing, disaggregation, autoscaling (llm-d)

| Topic | What sources say | What the model does |
|---|---|---|
| Scoring profile | llm-d `docs/architecture/router/configuration.md` (main, 2026-11-12) lists `prefix-cache-scorer` 3.0, `kv-cache-utilization-scorer` 2.0 and `queue-scorer` 2.0 as *recommended, not in the default profile*; scores are 0 to 1, weighted and summed, and `max-score-picker` takes the best. Red Hat's product docs present prefix 3 and queue 2 as defaults. The prefix index is approximate by default and precise (KV-event driven) when configured. A `no-hit-lru-scorer` spreads cold requests. | 3 × prefix match + 2 × free KV share + 2 × free load share, best score wins. The load term counts running as well as queued requests. The router sees pod state exactly, like the precise index with no lag. Cold-request spreading is not modelled. |
| Offloaded prefixes in the score | Ray's docs: with LMCache the router scores an offloaded prefix as not cached. llm-d's precise index tracks engine KV events. | Own choice: DRAM 0.7, SSD 0.4, remote 0.25 of an HBM match. |
| P/D request flow | llm-d (`disaggregation/pd-disaggregation.md`): `disagg-profile-handler` picks the decode pod first, a decider is given the number of uncached tokens on it, and only for a large uncached suffix picks a prefill pod. (`router/scheduling.md` words it as both endpoints "picked at the same time"; the decider's name and threshold are not in the docs.) A sidecar in front of the decoder calls the prefiller with `max_tokens=1`; KV moves by NIXL; the decoder streams the tokens. SGLang fires prefill and decode together and coordinates over a bootstrap room. (`pd-profile-handler` is the deprecated name.) | llm-d's decision logic with a token threshold (default 512). Drawn as router → prefill pod → KV → decode pod; the sidecar is not drawn. |
| Transfer link | llm-d: RDMA is required in practice; TCP is "extremely slow". | A link-speed slider (default 100 Gbps). |
| Prefill : decode ratio | llm-d: tune to the input/output ratio, often more prefill replicas with less parallelism (example: 8 TP=1 prefill pods and 2 TP=4 decode pods). | A fixed share (about one prefill pod in three), same GPUs per pod for both roles. |
| When it pays off | llm-d: long prompts with short answers, medium to large models. One guide puts the break-even at several GPUs per model. Together's cache-aware variant sends warm requests straight to decode. | Stated in the architecture note; the threshold reproduces the warm-request shortcut. |
| Autoscaling | llm-d's Workload Variant Autoscaler is deprecated; the current path is KEDA on EPP metrics (running requests, queue size, saturation), with scale from zero made possible by the EPP queueing requests. | Instant target-concurrency rule: requests in flight ÷ `max_num_seqs`. Requests wait at the router while a pod starts. |
| Where tokenising happens | The gateway counts tokens for rate limits; the engine's front end tokenises on the replica; a router may tokenise to hash prefixes. | Drawn once, at the gateway. |

## Not modelled

Quantised KV (FP8), mixture-of-experts and wide expert parallelism, LoRA adapters, model cascades, structured output, pipeline parallelism, predicted-latency scoring, router lag behind engine state, tenant fairness, pod failure, cross-datacenter prefill.

## What "verified" means here

- **Checked by a test against a source's printed numbers or formulas:** the cost-model quantities (KV bytes per token, memory budgets, ridge points, step floor, throughput curve), speculative decoding (Leviathan eq. 1 and theorem 3.8), and that TPOT equals the roofline step time (8.0 ms for Llama-3.1-8B at batch 1 on an H100 at MBU 0.6).
- **Inside a measured range, value chosen by us:** tier copy rates, α, γ, c, host time per step, MBU and MFU. All are sliders.
- **Structure taken from a source, numbers ours:** routing weights for copies in lower tiers, the P/D threshold default (512 tokens), the prefill share of pods, cold-start time, hop times.
- **Checked against vLLM source (commit `5e51c0ca10`):** the `max_num_seqs` default of 128 (`vllm/config/scheduler.py`), and the rule of admitting nothing in a step that preempted (`vllm/v1/core/sched/scheduler.py` schedules the waiting queue only `if not preempted_reqs`).
