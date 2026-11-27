# Serving architectures

The prose of the "Serving architecture" menu at the top left. Choosing an architecture from the dropdown shows its name and what it adds, followed by a line with its sources; the parameter values it sets stay in `src/sim/presets/architectures.ts`. The entries are in the order of the dropdown, and each id is an architecture id.

## `static` Static batching
_Where:_ Left menu, "Serving architecture" panel, shown under "What this step adds" while this architecture is selected.

### name
Static batching, reserved memory

### adds
The baseline. A batch is formed, runs until its longest answer ends, and only then does the next batch start. Every request reserves KV memory for its prompt plus the maximum output it might produce. Watch finished slots sit idle, late arrivals wait for the whole batch, and most reserved memory stay empty.

### source
Request-level batching as in general model servers ([TF Serving][@tfServing], [Triton dynamic batching][@tritonBatcher]).

## `orca` Continuous batching
_Where:_ Left menu, "Serving architecture" panel, shown under "What this step adds" while this architecture is selected.

### name
Continuous batching

### adds
The batch is re-decided at every engine step: a finished sequence leaves at once and a waiting one takes its slot. Removes both waits of static batching. Memory is still reserved for the maximum length.

### source
[Orca (Yu et al., OSDI 2022)][@yu2022] called it iteration-level scheduling. Now universal: [vLLM][@vllmRepo], [TGI][@tgiRepo], [TensorRT-LLM][@tensorrtLlm] (in-flight batching), [SGLang][@sglangRepo].

## `paged` PagedAttention
_Where:_ Left menu, "Serving architecture" panel, shown under "What this step adds" while this architecture is selected.

### name
PagedAttention: KV in blocks, on demand

### adds
KV memory is cut into fixed blocks handed out as tokens are actually written, like virtual memory pages. A sequence holds what it uses, so several times more sequences fit. The price: the pool can run out mid-decode, and then the newest sequence is preempted and recomputed.

### source
[vLLM (Kwon et al., SOSP 2023)][@kwon2023]. [TensorRT-LLM][@tensorrtLlm] and [SGLang][@sglangRepo] use paged KV pools too.

## `prefix` Chunked prefill + prefix cache
_Where:_ Left menu, "Serving architecture" panel, shown under "What this step adds" while this architecture is selected.

### name
Chunked prefill, prefix cache, cache-aware routing

### adds
Three fixes that arrived together. A long prompt is prefilled in chunks under a per-step token budget, so it no longer stalls every running stream for its whole length. Finished sequences keep their blocks, so a follow-up turn only prefills its new tokens. And the router sends a session back to the pod that holds its cache.

### source
[Sarathi-Serve (Agrawal et al., OSDI 2024)][@agrawal2024] for chunked prefill; [SGLang RadixAttention][@zheng2023] and [vLLM automatic prefix caching][@vllmPrefixCaching]; prefix-aware routing in [llm-d][@llmdScheduling], [SGLang router][@sglangRepo], [Dynamo][@dynamoRepo].

## `tiers` Tiered KV cache
_Where:_ Left menu, "Serving architecture" panel, shown under "What this step adds" while this architecture is selected.

### name
Tiered KV cache below the GPU

### adds
Idle sessions no longer hold GPU memory or get thrown away. Their KV moves to host DRAM, local SSD and a pool shared by all pods, and is loaded back when that beats recomputing. Fixes the choice between wasting HBM on absent users and paying a full prefill when they return.

### source
[CachedAttention (Gao et al., USENIX ATC 2024)][@gao2024], [Mooncake (Qin et al., FAST 2025)][@qin2024], [LMCache][@lmcache2025], [SGLang HiCache][@sglangRepo], [NVIDIA Dynamo's KV block manager][@dynamoKvbm] (tiers G1 to G4), [vLLM's OffloadingConnector][@vllmRepo] (0.11, late 2025).

## `disagg` Prefill/decode split
_Where:_ Left menu, "Serving architecture" panel, shown under "What this step adds" while this architecture is selected.

### name
Prefill / decode disaggregation

### adds
Prefill and decode run on separate pools. A prefill pod computes the prompt's KV and ships it over the network to a decode pod. Compute-bound and memory-bound work stop sharing steps, so each pool can be sized and tuned for its own latency target. Follow-ups whose history is already cached skip the prefill pool.

### source
[DistServe (Zhong et al., OSDI 2024)][@zhong2024] and [Splitwise (Patel et al., ISCA 2024)][@patel2023]; in production at Moonshot ([Mooncake][@qin2024]); shipped in [llm-d][@llmdDisaggregation], [NVIDIA Dynamo][@dynamoRepo], [vLLM][@vllmRepo] and [SGLang][@sglangRepo]. Pays off most for long prompts with short answers and medium to large models, and needs a fast (RDMA) link for the transfer.

## `full` Today's full stack
_Where:_ Left menu, "Serving architecture" panel, shown under "What this step adds" while this architecture is selected.

### name
Today's full stack

### adds
Adds the remaining common levers. Speculative decoding emits several tokens per step. Host work overlaps the GPU step instead of adding to it. The gateway sheds requests that have waited past their deadline instead of answering late.

### source
Speculative decoding ([Leviathan et al., ICML 2023][@leviathan2023]), now built into [vLLM][@vllmRepo], [SGLang][@sglangRepo] and [TensorRT-LLM][@tensorrtLlm]; asynchronous scheduling in [SGLang][@sglangRepo] and [vLLM][@vllmRepo]; flow control in [llm-d][@llmdFlowControl] and [Dynamo][@dynamoRepo].

## `active-active` Active-active routers (stale state)
_Where:_ Left menu, "Serving architecture" panel, shown under "What this step adds" while this architecture is selected.

### name
Active-active routers with stale peer state

### adds
Four independent router replicas sit behind a round-robin gateway, each seeing its own exact in-flight counts while peer load snapshots sync every 200 ms. When requests share a 1,536-token system prompt, naive prefix-aware routing herds concurrent bursts onto one warm pod during the blind window. Switch to Bounded-load affinity or Age-discounted (or tighten the sync lag to 20 ms) to watch the stampede break.

### source
[llm-d-router Issue #3440][@llmdIssue3440] and [PR #4077][@llmdPr4077]; bounded-load consistent hashing ([Mirrokni et al., SODA 2018][@mirrokni2018]); stale load discounting ([Dahlin, IEEE TPDS 2000][@dahlin2000]); multi-dispatcher load balancing ([Goren et al., 2020][@goren2020]).
