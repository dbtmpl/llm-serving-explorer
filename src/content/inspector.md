# Dive-in panel

The notes in the "dive in" panel, which opens at the bottom of the left menu when the visitor clicks a node of the graph (a session, the gateway, the conversation store, a pod, the remote pool or the output stream). Each note sits under the live numbers of its component. Values in braces are filled in by the code from the simulation.

## `session.note` Session
_Where:_ Dive-in panel of a session, below its status rows.

### text
Token i cannot be computed before token i−1, so a call is a chain of dependent steps. The cache keeps {kib} KiB per token for the life of the request and turns a quadratic loop into a linear one. The output length limit (max_tokens) is the only bound on how much memory a request can take.

## `session.pruned` Session no longer tracked
_Where:_ Dive-in panel of a session that the simulation has dropped from its records because it ended long ago.

### text
This session has been pruned.

## `tokenizer.note` Gateway and prompt assembly
_Where:_ Dive-in panel of the gateway and prompt assembler, below the cost rows.

### text
Hop 1: the gateway authenticates the caller, counts the prompt in tokens and applies rate limits. Providers limit tokens per minute as well as requests per minute because cost follows tokens ([OpenAI][@openaiRateLimits], [Envoy AI Gateway][@envoyAiGatewayRateLimit]). It attaches a request id and a deadline: how long the request may wait in the router's queue before it is rejected rather than answered late, which is called load shedding ([@llmdFlowControl]; the slider "shed requests waiting longer than"). Hop 2: the prompt assembler reads the history from the conversation store and builds system prompt + history + new message. Their order decides what the prefix cache (the saved work of earlier tokens) can reuse, and the router uses the prompt's identity to find a pod that already holds it ([@llmdKvCacheIndexer]). The site draws gateway and assembler as one node; real deployments differ in where counting happens. The request still travels to the pod as text; the engine's own server there applies the model's chat template and tokenises again, giving the token ids the model consumes ([@vllmOpenAiServer]). From here on the unit of work is the token. Prefill cost is 2N per token plus an attention term that grows with the square of the prompt, which equals 2N at {crossover} tokens of context for this model.

## `gateway.note` Router
_Where:_ Dive-in panel of the router, below the table of the last routing decision.

### text
A request is pinned to its pod from admission until it finishes, because its saved work (its KV cache) lives in that pod's memory. The prefix-aware router gives every ready pod $p$ a score and picks the highest:

$$\text{score}(p) = [[wCache]]\,c_p + [[wKv]]\,m_p + [[wQueue]]\,q_p$$

Here $c_p$ is the share of the prompt that pod $p$ already has cached (scaled down by the memory tier it sits in), $m_p$ the share of its KV memory that is free and $q_p$ the share of its request capacity that is free; each is between 0 and 1. The weights are [llm-d's recommended profile][@llmdScheduling] on the [Gateway API Inference Extension][@gatewayInferenceExtension]; how much a copy in HBM, DRAM, SSD or the remote pool counts (HBM most) is this model's own choice. So a pod holding the cache wins unless it is too busy (the other pods lead on $m$ and $q$ together by more than the cache term $[[wCache]]\,c_p$ is worth), and a pod at capacity (`max_num_seqs` plus a short queue allowance) is not a candidate. Least-loaded sends the request to the pod with the fewest requests, like [Envoy's least-request balancer][@envoyLoadBalancing]; round-robin takes the pods in turn, so returning sessions land on cold pods and prefill again.

### stale-state
With multiple active-active router replicas ([@llmdIssue3440], [@llmdPr4077], [@goren2020]), each replica knows its own exact in-flight count $L_{\text{own}}(p)$ immediately while peer counts $L_{\text{peer}}(p)$ lag by the sync window $\Delta t$. The observed load $L_{\text{own}} + L_{\text{peer}}$ can therefore fall far below the pod's true load during a burst, causing replicas to herd onto the same warm pod.

### bounded-load
Bounded-load affinity adds a [Mirrokni et al. (SODA 2018)][@mirrokni2018] overload cap on top of the prefix-aware score:

$$\text{capLoad} = (1 + \varepsilon)\,\max(\bar{L},\, 1)$$

Any pod whose observed load exceeds $\text{capLoad}$ loses an overload penalty larger than the score range, shedding excess traffic to cooler pods.

### age-discounted
Age-discounted routing applies [Dahlin (IEEE TPDS 2000)][@dahlin2000] exponential decay to stale peer load while keeping exact local load:

$$L_{\text{eff}}(p) = L_{\text{own}}(p) + L_{\text{peer}}(p)\,e^{-\Delta t / \tau}$$

When peer snapshots age out ($\Delta t \gg \tau$), stale peer reports stop blocking warm-pod affinity on sequential turns.

## `store.note` Conversation store
_Where:_ Dive-in panel of the conversation store, below its counters.

### text
Each model call is stateless, so the product keeps the conversation: an append-only log of turns, replayed in full on every call. It is the system of record. The KV cache in HBM, DRAM, SSD or a remote pool is derived from it and is valid only for the exact token sequence and model version it was computed with. Losing a KV tier costs a prefill and nothing else; editing or truncating stored history invalidates every cached prefix after the edit.

## `remote.note` Remote KV pool
_Where:_ Dive-in panel of the remote KV pool, below its counters.

### text
A KV pool on other machines' DRAM and SSD, reachable from every pod over the network ([Mooncake][@qin2024], [SGLang HiCache][@sglangRepo]'s third level and [LMCache][@lmcache2025]'s remote stores work this way). It is the only tier that survives a pod being scaled down and the only one a different pod can load from. Loading is adaptive: over a 32 to 128 Gbps link it beats a prefill only for long contexts or large models, so short sessions are recomputed instead.

## `stream.note` Output stream
_Where:_ Dive-in panel of the output stream.

### text
Hop 6. Every engine step produces one token for each decoding sequence. The token is detokenised on the host, checked against stop conditions, and sent to the client as a streaming event. A person reads about 5 tokens per second, so tokens delivered faster than that build a buffer; what a reader feels is the wait for the first token and any stall longer than that buffer.

## `pod.terminated` Pod terminated
_Where:_ Dive-in panel of a pod that the autoscaler has removed since it was selected.

### text
This pod has been terminated.

## `pod.gpu.note` GPU memory and KV blocks
_Where:_ Dive-in panel of a pod, group "GPU memory and KV blocks", below the memory rows. The tensor-parallel sentence is added when a pod spans more than one GPU.

### text
The KV pool is what remains of the share the engine may use, after the weights and the activations and CUDA graphs; the headroom, the part above `gpu_memory_utilization`, lies outside that share and is never used. The engine budgets {utilisation} of the memory the driver reports, which is more than the name of the GPU suggests: {nominal} for {reported} reported [@vllmMemoryProfiling]. The pool is split into fixed blocks that need not be contiguous; a per-sequence block table maps logical to physical blocks, so a sequence holds what it uses and waste is confined to its last block. Each coloured cell in the graph stands for {cellBlocks} blocks; pale cells are cached but idle.

### tensor-parallel
With tensor parallelism every GPU holds a slice of every sequence's KV heads, so the {tp} grids fill together.

## `pod.roofline.note` Roofline and throughput
_Where:_ Dive-in panel of a pod, group "Roofline and throughput", below the throughput rows.

### text
A step cannot run faster than its arithmetic allows or than its data can arrive [@williams2009]:

$$t_{\text{GPU}} = \max\!\left(\frac{\text{FLOPs}}{\text{peak FLOP/s} \cdot \text{MFU}},\ \frac{\text{bytes read}}{\text{bandwidth} \cdot \text{MBU}}\right) + t_{\text{all-reduce}} + t_{\text{launch}}$$

Memory and arithmetic overlap inside a GPU, so they take the larger. What a roofline leaves out is added: on several GPUs the all-reduces of tensor parallelism (two per layer, they do not overlap the matrix products), and the time to launch each layer's kernels, which is much larger for a step too big to be replayed from a captured CUDA graph [@shoeybi2019]. Host time then adds to this or, with overlap, hides behind it.

The ridge is the arithmetic intensity (FLOPs per byte read) where the two terms are equal, $\text{peak FLOP/s} \div \text{bandwidth}$. Decode reads {weights} of weights to make one token per sequence, so it sits left of the ridge at any batch: throughput is set by bandwidth and context length, not FLOPs. Prefill does thousands of FLOPs per byte and runs at the flat roof.

## `pod.tiers.note` Memory tiers and eviction
_Where:_ Dive-in panel of a pod, group "Memory tiers and eviction", below the table of tiers.

### text
When a new block is needed and HBM is full, the least recently used idle sequence leaves first: to DRAM, which pushes its own oldest down to SSD, which drops its oldest. The cache is derived state, so a drop loses nothing but time. If no idle sequence is left, a running one is preempted and recomputed. Below SSD a shared remote pool can take the overflow, and below that only the conversation's text remains. Loading back is adaptive: it is used only when the copy is faster than a fresh prefill, which favours long contexts and large models. [NVIDIA Dynamo][@dynamoKvbm] names these tiers G1 (GPU memory), G2 (host memory), G3 (local or pooled SSD) and G4 (remote storage). [vLLM][@vllmOptimization] recomputes a preempted sequence, and since release 0.11 can offload idle prefix blocks through its [OffloadingConnector][@vllmRepo] (host memory, optional filesystem tier) or through [LMCache][@lmcache2025], [Mooncake][@qin2024] or Dynamo's block manager. Those systems copy blocks down asynchronously while the request runs, overlap loads with compute layer by layer, and prefetch at routing time; this model moves a session only when room is needed and leaves the rest out. The copy rates are sliders under Memory tiers; their defaults sit inside measured ranges (host memory over PCIe: about 11 to 49 GB/s; SSD: 1.6 to 12 GB/s; network: 32 to 128 Gbps).

## `pod.engine.note` Engine loop
_Where:_ Dive-in panel of a pod, group "Engine loop", below the running sequences.

### text
The engine is one loop that advances every admitted request by one step, sharing each forward pass. Decodes go first (one token each); the rest of the token budget is filled with prefill chunks, which bounds how long a big prompt can stall everyone else. A request is admitted when the KV it needs under the admission rule fits: its whole prompt fits in the free blocks, though only its next chunk is allocated at first ([vLLM][@vllmScheduler], which then preempts the newest sequence if the pool runs out; a preempted request waits until all of its context fits), its whole prompt, or prompt plus max_tokens (never preempts, admits far fewer). Everything but the forward pass is host code on the critical path of every token: every sequence's TPOT is the step time.
