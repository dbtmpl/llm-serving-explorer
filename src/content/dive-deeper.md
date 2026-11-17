# Dive deeper

The theory behind each step of the step-through. Every step lists, in its `### dive` field in `step-through.md`, the concepts below that it connects to, in order; the step box shows them as collapsed drop-downs under the heading "Dive deeper" (step-through mode only, never in the floating callouts). The step text itself stays the applied explanation; each concept here is the general idea behind it: a definition, the governing formula where there is one, why the design exists and where it shows up in real systems. One entry per concept, written once however many steps show it.

## `stateless` Stateless calls and the conversation as the system of record
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.new`, `req.followup`, `store.read`, `store.append`, `walk.end`.

### title
Stateless calls and the conversation as the system of record

### body
A service is stateless when each request carries everything needed to handle it, so no memory of earlier requests is needed on the server [@fielding2000]. A model call is stateless in this sense: the chat-completions format takes the whole list of messages every time [@openaiChatCompletions]. The consequence is that someone outside the model must keep the conversation. Here that is the conversation store, an append-only log of turns, the pattern called event sourcing: the log is the record, and anything computed from it, such as a KV cache, is derived and can be rebuilt [@fowlerEventSourcing]. The price of statelessness is that input grows with the conversation. If every turn adds about $L$ tokens, turn $k$ sends $kL$ tokens, so $n$ turns send $L\,n(n+1)/2$ tokens in all: quadratic in the length. A prefix cache exists to avoid paying that sum in computation.

### formula
$$\sum_{k=1}^{n} kL = L\,\frac{n(n+1)}{2}$$

## `token` The token as the unit of work
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.new`, `req.tokenized`, `walk.cost`, `walk.arrive`.

### title
The token as the unit of work

### body
A token is a piece of text, often a word fragment, that the model reads and writes as one id. Work, memory and price all follow tokens, not requests. A forward pass costs about $2N$ floating-point operations per token for a model with $N$ parameters (plus an attention term that grows with the context) [@kaplan2020]; each token in context also keeps keys and values in memory (see the KV bytes per token below); and each output token needs a pass of its own. So two requests can differ by orders of magnitude in work: for Llama 3.1 8B, with $N = 8.03\times 10^{9}$, a single token costs about 16 GFLOP, and a 100,000-token prompt about 1.6 PFLOP before attention. A request rate alone therefore says little about load; it has to be described by the distributions of prompt length and output length. This is why gateways, limits and prices count tokens.

### formula
$$\text{FLOPs per token} \approx 2N$$

## `tokenizer` Tokenisation and chat templates
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.tokenized`, `walk.arrive`.

### title
Tokenisation and chat templates

### body
A tokenizer turns text into ids. Modern ones learn a vocabulary of frequent pieces, so rare words split into several tokens: byte-pair encoding merges the most frequent pairs of symbols [@sennrich2016], and SentencePiece applies such methods directly to raw text [@kudo2018]. A model only works with the tokenizer it was trained with, so the count of tokens for the same text differs between model families, and a count made at the gateway is exact only if it uses the model's own tokenizer. A chat template is the second step: a model-specific recipe that turns the list of messages, with roles, into one string with the model's special tokens [@hfChatTemplates]. A wrong template does not fail loudly; the model simply sees a prompt shaped differently from its training data. That is why the engine, which knows its model, repeats both steps on arrival and its result is the input that counts.

## `tokenlimits` Rate limits counted in tokens
_Where:_ Dive deeper drop-down in the step-through box, under the steps `walk.cost`.

### title
Rate limits counted in tokens

### body
A limit in requests per minute protects nothing when one request can be a hundred times the work of another, so providers also limit tokens per minute [@openaiRateLimits]. A classic mechanism is the token bucket: a bucket of capacity $B$ refills at a rate $r$, a request takes what it costs, and it is refused when the bucket is empty [@wikiTokenBucket]. The hard part is that the cost of the output is unknown when the request arrives. A limiter can charge an estimate in advance: OpenAI counts the larger of the request's `max_tokens` and an estimate from its size [@openaiRateLimits]. Or it can charge the tokens a response actually produced once it ends, so a request can overshoot the limit and later requests are refused until usage expires; usage-based limiting in the Envoy AI Gateway works this way [@envoyAiGatewayRateLimit]. Either way the unit is the one the GPU pays in. Limits also protect other customers: a gateway that counts tokens before spending GPU time stops one caller's long prompts from using the capacity of all.

### formula
$$b(t) = \min\bigl(B,\ b(t_0) + r\,(t - t_0)\bigr)$$

## `deadline` Deadlines and load shedding
_Where:_ Dive deeper drop-down in the step-through box, under the steps `walk.deadline`, `req.failed`.

### title
Deadlines and load shedding

### body
A deadline is the time by which an answer is still useful, set by the caller and carried along the call chain so every layer can stop work that no longer matters [@grpcDeadlines]. When a system receives more work than it can finish in time, queues grow without limit and every request eventually arrives late. Load shedding refuses some work early, so that the work still accepted meets its deadline; failing fast also lets the client retry elsewhere or tell its user [@sreHandlingOverload], [@awsLoadShedding]. In a router it takes the form of a time limit in the queue: llm-d calls it the request time-to-live and rejects a queued request with an error once it passes [@llmdFlowControl]. For a model call the output length is chosen by the model, so the only bound the caller controls is the output cap. From $E = T_{\text{first}} + (L - 1)\,T_{\text{tok}}$ a deadline $D$ allows at most the length below.

### formula
$$L_{\max} = 1 + \left\lfloor \frac{D - T_{\text{first}}}{T_{\text{tok}}} \right\rfloor$$

## `goodput` Goodput: throughput that counts
_Where:_ Dive deeper drop-down in the step-through box, under the steps `walk.deadline`, `walk.reply`, `req.failed`.

### title
Goodput: throughput that counts

### body
Throughput is easy to raise: a bigger batch serves more tokens per second while every user waits longer. Goodput counts only the work that met its service-level objectives. DistServe defines it as the highest request rate that a system can serve while a chosen share of requests (for example 90%) meets both the first-token and the per-token bound, and states it per GPU, because the goal is to lower the cost of each query [@zhong2024]. Write $A(\lambda)$ for the share of requests that meet the bounds at arrival rate $\lambda$. Attainment is an estimate from a finite sample: to claim 99% one needs many requests with almost no misses, which is why benchmarks such as MLPerf measure it against a stated latency bound and a statistical rule [@reddi2019]. Bounds are set on percentiles, not averages, because at scale the rare slow response is what users notice [@dean2013]. A goodput figure without its workload, its bounds and its target is not a number.

### formula
$$\text{goodput} = \frac{1}{n_{\text{GPU}}}\max\{\lambda : A(\lambda) \ge a\}$$

## `coldstart` Cold start and warm pools
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.queued`, `pod.loading`.

### title
Cold start and warm pools

### body
A new pod can serve only when its weights are in GPU memory, so its start-up time has a floor set by moving bytes: the weights divided by the bandwidth of the slowest place they come from. ServerlessLLM measures that loading a model from remote storage takes tens of seconds, and it keeps checkpoints in the server's DRAM and SSD to load from them instead [@fu2024]. During this time requests wait and the wait counts towards the time to first token. Scaling to zero saves GPU-hours, but the first user after a quiet period pays the whole cold start, which is why fleets set a minimum number of replicas that never scales to zero [@knativeScaleBounds]. The site's cold start is short so the animation keeps moving.

### formula
$$t_{\text{start}} \approx t_{\text{schedule}} + \frac{\text{weight bytes}}{\text{load bandwidth}}$$

## `autoscale` Autoscaling signals
_Where:_ Dive deeper drop-down in the step-through box, under the steps `scale.up`.

### title
Autoscaling signals

### body
An autoscaler picks the number of pods from a signal. The simplest signal in the web world is concurrency: requests in flight divided by what one replica handles at once, kept between a minimum and a maximum; Knative's target concurrency works this way [@knativeAutoscaling]. For a model server the per-pod number is its sequence limit, the engine's `max_num_seqs` [@vllmSchedulerConfig], and this site uses exactly that rule. Requests are a rough measure of work, though: a request can be a hundred tokens or a hundred thousand, so production setups also scale on queue depth and cache pressure exposed by the router, for example llm-d with KEDA on the endpoint picker's metrics [@llmdAutoscaling], [@keda]. A good signal leads the problem rather than reports it, because new capacity takes a cold start to arrive. Real autoscalers also smooth and delay their decisions to avoid flapping; this one reacts at once.

### formula
$$n_{\text{pods}} = \min\Bigl(n_{\max},\ \max\Bigl(n_{\min},\ \Bigl\lceil \frac{\text{in flight}}{\text{slots per pod}} \Bigr\rceil\Bigr)\Bigr)$$

## `littles` Little's law in tokens
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.queued`, `scale.up`, `walk.slot`.

### title
Little's law in tokens

### body
Little's law states that in a stable system the average number of items inside equals their arrival rate times the average time each spends there [@little1961]. It needs no assumption about arrival patterns, which is why it applies everywhere. For a model replica the items are sequences resident in the batch: each holds a KV cache and a slot until its last token. With arrival rate $\lambda$ (requests per second), $L_{\text{out}}$ output tokens each and a time per output token $T_{\text{tok}}$, the number resident is $\lambda\,L_{\text{out}}\,T_{\text{tok}}$. Because $T_{\text{tok}}$ grows with the batch, the loop closes on itself: more arrivals mean more residents, a slower step, a longer stay and more residents still. Once memory or slots cap the batch, the excess waits in a queue ahead of the first token. That is why a pod's slot count appears in the autoscaling rule.

### formula
$$N_{\text{resident}} = \lambda\,L_{\text{out}}\,T_{\text{tok}}$$

## `membudget` The GPU memory budget
_Where:_ Dive deeper drop-down in the step-through box, under the steps `pod.loading`, `pod.ready`, `pod.failed`.

### title
The GPU memory budget

### body
Every GPU's memory is shared by a few pools, and the batch an engine can run is whatever the last one allows. The engine requests a fraction `gpu_memory_utilization` of the memory the driver reports [@vllmEngineArgs]; it then measures what the weights, one profiling pass, the captured CUDA graphs and the memory outside PyTorch take, and gives the rest to the KV cache [@vllmMemoryProfiling]; for the last, which no formula gives, the model takes 0.7 GB per GPU, fitted to two measured runs. The profiling pass is one step of `max_num_batched_tokens` tokens followed by the sampler over `max_num_seqs` rows of the whole vocabulary, so a bigger token budget or a longer sequence limit takes memory from the cache; the graphs are one per batch size on vLLM's capture list [@vllmProfileRun]. With tensor parallelism the weights and the KV heads are split over the GPUs of a pod, so each GPU holds a slice of every sequence [@shoeybi2019]. The model is the one in the formula below; the box on the screen draws it to scale.

### formula
$$M_{\text{KV}} = u \cdot M_{\text{device}} - M_{\text{weights}} - M_{\text{activations}}(T_{\max},\ S_{\max}) - M_{\text{graphs}}(S_{\max}) - M_{\text{runtime}}$$

## `kvbytes` KV bytes per token and the batch cap
_Where:_ Dive deeper drop-down in the step-through box, under the steps `walk.cost`, `pod.ready`, `pod.failed`, `walk.kvmap`, `req.preempted`.

### title
KV bytes per token and the batch cap

### body
Attention needs the key and value vectors of every earlier token, so the engine stores them instead of recomputing them. The size per token follows from the model's shape: one key and one value vector, of length $d_{\text{head}}$, for each layer and each key-value head, at $b$ bytes per number [@kwon2023]. Multi-query and grouped-query attention share one set of key-value heads between several query heads, which is why modern models have far fewer key-value heads than query heads and a much smaller cache [@shazeer2019], [@ainslie2023]. Llama 3.1 8B has 32 layers, 8 key-value heads and a head size of 128 (4,096 / 32) [@grattafiori2024]. With 2-byte numbers that is 128 KiB per token, so a 4,096-token context takes about 0.5 GB. The number of sequences a pod can hold is its KV pool divided by what one sequence holds, so a bigger context means a smaller batch, and the memory, not the arithmetic, sets how many users share a GPU.

### formula
$$M_{\text{token}} = 2\, n_{\text{layers}}\, n_{\text{kv heads}}\, d_{\text{head}}\, b \qquad B_{\max} = \left\lfloor \frac{M_{\text{KV}}}{L \cdot M_{\text{token}}} \right\rfloor$$

## `paged` Paged block allocation and block hashing
_Where:_ Dive deeper drop-down in the step-through box, under the steps `pod.ready`, `req.admitted.hit`, `walk.kvmap`.

### title
Paged block allocation and block hashing

### body
Reserving one contiguous region per request wastes memory, because the final length of an answer is unknown, and the waste is batch size the pod could have run. PagedAttention borrows the idea of virtual memory: the cache of each sequence is cut into fixed-size blocks (here 16 tokens), a per-sequence block table maps logical blocks to physical ones, and blocks need not be contiguous, so waste is confined to the last block of each sequence [@kwon2023]. Blocks can be shared by pointing several tables at one block. The same layout gives the prefix cache: a full block is identified by a hash of its tokens chained with the hash of the block before it, so equal hashes mean equal prefixes [@vllmPrefixCaching]. Only full blocks can be matched, so the block size also sets the granularity of reuse.

### formula
$$h_i = H\bigl(h_{i-1},\ \text{tokens in block } i\bigr)$$

## `routing` Routing by cached prefix: affinity against load balance
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.routed`, `walk.picked`.

### title
Routing by cached prefix: affinity against load balance

### body
A request's cost depends on the pod it lands on, because only the tokens that pod has not already cached must be computed. A balancer that ignores this spreads a conversation's turns over the pods. With $k$ pods and requests spread evenly, a returning conversation lands on the pod that holds its cache with probability about $1/k$, so hits become rare as the fleet grows. Sending requests to the pod with the cache raises the hit rate but concentrates load, and a popular prefix becomes a hot key. The rule has to say when load wins. Preble's answer is to exploit the cache when it saves more than it costs and otherwise balance load [@srivatsa2024]; llm-d scores each pod on cache, memory and queue with weights, the score used here [@llmdScheduling], [@gatewayInferenceExtension]. Real routers learn what each pod holds from the pods' reported cache events [@llmdKvCacheIndexer].

### formula
$$P(\text{hit}) = \frac{1}{k} \ \text{(round robin)} \qquad \text{vs.} \qquad P(\text{hit}) \to 1 \ \text{(affinity)}$$

## `kvcache` The KV cache as stored computation: cold but never stale
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.followup`, `store.read`, `req.routed`, `walk.picked`, `req.admitted.hit`, `req.admitted.miss`, `store.append`, `session.idle`, `kv.drop`, `walk.evict.return`.

### title
The KV cache as stored computation: cold but never stale

### body
The cache that carries most of the load stores a computation, not an answer: the keys and values of one exact token sequence under one model. Its key is the sequence itself (in practice a hash of it), so an entry can only be asked for by a request with that same prefix, and it cannot be out of date: if the history, the prompt or the model changes, the key changes and the old entry is simply never used. An entry can be cold, evicted or on a slower tier, but not stale. That is why the conversation's text is the record and the cache is a copy that can be rebuilt by a prefill [@vllmPrefixCaching], [@zheng2023], [@gao2024]. A hit saves the prefill of the matched prefix; the new tokens still attend to all of it, so the saving is less than proportional to the share cached. Anything that edits an earlier turn invalidates every cached block after the edit.

### formula
$$\text{tokens to prefill} = L_{\text{prompt}} - L_{\text{cached}}$$

## `contbatch` Continuous batching and the token budget per step
_Where:_ Dive deeper drop-down in the step-through box, under the steps `walk.slot`, `step.tokens.stream`, `req.done`.

### title
Continuous batching and the token budget per step

### body
With static batching a group of requests runs together until the longest of them finishes, so slots of short requests sit idle and hold memory. Orca schedules per step instead: after every forward pass finished requests leave and waiting ones take their place, and every operation except attention is run over one flat list of tokens from all requests [@yu2022]. If the lengths in a static batch of $B$ are $L_i$, its useful share is the ratio below, which falls as the batch grows, because the maximum of more draws is larger. Continuous batching is also an admission rule: every step has a budget of tokens it can process, set by `max_num_batched_tokens` and the sequence limit [@vllmSchedulerConfig]. Decodes take one token each, and a prompt that is admitted shares the step, so its tokens add to the time every running stream waits for its next token.

### formula
$$u_{\text{static}} = \frac{\sum_i L_i}{B\,\max_i L_i}$$

## `chunked` Chunked prefill and prefill/decode interference
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.admitted.prefill`, `kv.transfer`.

### title
Chunked prefill and prefill/decode interference

### body
Prefill and decode share steps, and they interfere: a long prompt processed in one step makes every running stream wait for it. Chunked prefill cuts the prompt into pieces and fills each step's token budget with all running decodes first, then a chunk of prompt, so the step stays short [@agrawal2023]. Sarathi-Serve shows that this keeps the time between tokens bounded at little cost to throughput, because decode is limited by reading weights and leaves arithmetic capacity unused that a prefill chunk can use [@agrawal2024]. The budget is a trade: a larger one finishes prompts sooner and delays the next token of every stream; a very small one cuts prompts into many chunks, each re-reading the cached keys and values of the earlier chunks and using the GPU less well [@agrawal2024]. In vLLM it is `max_num_batched_tokens`, and chunking is on by default in recent releases [@vllmOptimization].

### formula
$$n_{\text{prefill}} \le \text{budget} - n_{\text{decode}}$$

## `roofline` The roofline and arithmetic intensity
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.admitted.prefill`, `walk.roofline`, `kv.skipload`.

### title
The roofline and arithmetic intensity

### body
The roofline model says that a computation cannot run faster than the machine's arithmetic allows, nor faster than its memory can deliver the data [@williams2009]. Its coordinate is arithmetic intensity $I$: floating-point operations per byte moved from memory. Attainable performance is the lower of two limits, and the ridge is the intensity where they meet. Left of the ridge a step is memory-bound, right of it compute-bound. For a transformer step the weights are read once whatever the number of tokens, so intensity grows with the tokens sharing that read: with 16-bit weights each parameter is 2 bytes and contributes $2n$ operations for $n$ tokens, so $I \approx n$ FLOP per byte. A prompt of thousands of tokens is far right of the ridge; one token per sequence is far left. Datasheets must be read with care: vendors often print sparse rates that are twice the dense ones [@nvidiaH100].

### formula
$$P = \min\bigl(P_{\text{peak}},\ I \cdot BW\bigr) \qquad I_{\text{ridge}} = \frac{P_{\text{peak}}}{BW}$$

## `membound` Memory-bound decode, MBU and MFU
_Where:_ Dive deeper drop-down in the step-through box, under the steps `walk.roofline`, `req.firstToken`.

### title
Memory-bound decode, MBU and MFU

### body
Decode makes one token per sequence per step but must read all the weights and every sequence's KV cache to do it, so each step moves a lot of data for little arithmetic [@pope2022], [@databricksInference]. Its time is then set by bandwidth, and a bigger batch amortises only the weight read, not the KV read of each sequence, which is why throughput saturates with the batch and why context length matters. Two efficiency ratios say how close a stack gets to the hardware: MFU, the share of peak arithmetic achieved, and MBU, the share of peak memory bandwidth achieved [@databricksInference]. Decode is judged by MBU, prefill by MFU. Two real GPUs streamed weights and KV cache in a vLLM decode step at 0.83 to 0.85 of datasheet bandwidth, the default MBU. A step is the larger of its memory and arithmetic times, plus the all-reduces of tensor parallelism and the launch of each layer's kernels. Every sequence waits for the whole step, so the time per output token is the price of the batch.

### formula
$$T_{\text{step}} \approx \frac{M_{\text{weights}} + B\,L\,M_{\text{token}}}{BW \cdot \text{MBU}} + T_{\text{all-reduce}} + T_{\text{launch}}$$

## `ttft` TTFT and TPOT: two phases, two latencies
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.firstToken`, `walk.reply`.

### title
TTFT and TPOT: two phases, two latencies

### body
One response time hides two phases that feel different. The time to first token (TTFT) is the wait in the queue plus the prefill of the prompt; it is compute-bound and grows with the prompt. The time per output token (TPOT) is the mean time of the decode steps that follow; it is memory-bound and shared with the batch. DistServe sets a separate bound for each [@zhong2024]; Sarathi-Serve bounds the time between tokens [@agrawal2024]. The end-to-end time is their combination, and it mostly follows the output length, so a latency is only meaningful next to a token count. The two are not views of one speed: admitting a prompt lowers its TTFT and lengthens the next token of every running stream. If a model reasons before it answers, the reasoning tokens come first, so what matters is the time to the first visible token.

### formula
$$E = \text{TTFT} + (L_{\text{out}} - 1)\cdot\text{TPOT}$$

## `specdec` Speculative decoding
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.firstToken`.

### title
Speculative decoding

### body
Decoding is a chain of dependent steps, each reading all the weights for one new token per sequence, and no amount of hardware shortens the chain. Speculative decoding breaks it: a cheap draft proposes $k$ tokens, the large model checks all of them in one pass and keeps the longest prefix it agrees with, plus one token of its own, so the output has exactly the large model's distribution [@leviathan2023], [@chen2023]. If each draft token is accepted with probability $\alpha$, one iteration yields the expected number of tokens below. Because decode is memory-bound, checking extra positions costs little at small batches. On a busy replica the check turns compute-bound and the gain shrinks, so the benefit depends on the batch and on how well the draft matches. The site models it as a setting under Engine.

### formula
$$\mathbb{E}[\text{tokens per step}] = \frac{1 - \alpha^{k+1}}{1 - \alpha}$$

## `streaming` Streaming and the reader's buffer
_Where:_ Dive deeper drop-down in the step-through box, under the steps `step.tokens.stream`, `walk.reply`.

### title
Streaming and the reader's buffer

### body
A chat-completions call can stream: the server sends each token as an event as soon as it exists, over a long-lived HTTP response in the server-sent events format [@sseSpec], [@vllmOpenAiServer]. The first token appears after the TTFT instead of after the whole answer. A person reads at a speed no engine can change; Andes takes about 4.8 tokens per second [@andes2024]. Tokens delivered ahead of the reader form a buffer, and a pause only hurts once the buffer is spent. So the mean time per token can look healthy while one long stall ruins an answer, and tokens delivered far ahead of the reader are capacity that could have served someone else. Etalon therefore scores a stream against per-token deadlines instead of the average [@etalon2024]. On a stream a status of 200 means the call started, not that it succeeded; an error can still arrive after it.

## `preempt` Preemption: swap or recompute
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.admitted.again`, `req.preempted`.

### title
Preemption: swap or recompute

### body
When the KV pool is full and a running sequence needs one more block, the engine must take memory from a request that is still in use. vLLM gives back all the blocks of a sequence, newest first, and later recomputes it by prefilling prompt plus generated tokens; the alternative is to swap the blocks to host memory and back [@kwon2023], [@vllmOptimization]. Recomputing costs a prefill that every running stream waits behind, and the tokens already sent to the user are kept, so the user sees a stall rather than a restart. vLLM admits a waiting request, preempted or new, only if blocks for all the tokens it must prefill are free, and admits none in a step that preempted [@vllmScheduler]. Preemption is rare while the pool has headroom and becomes thrashing under sustained overload. Reserving the full output length at admission avoids it, at the cost of admitting fewer requests: TensorRT-LLM's GUARANTEED_NO_EVICT policy runs a started request to completion [@tensorrtLlmScheduler].

## `eviction` Eviction policies
_Where:_ Dive deeper drop-down in the step-through box, under the steps `session.idle`, `walk.evict.when`, `walk.evict.force`, `kv.move.dram`, `kv.move.ssd`, `kv.move.remote`.

### title
Eviction policies

### body
A cache that is never full needs no eviction; one that is must choose what leaves. Least recently used (LRU) removes the entry whose last use is oldest, on the guess that what was idle longest is the least likely to return soon. vLLM frees cached blocks in that order, block by block [@vllmPrefixCaching]. The granularity matters for conversations: the cache of a conversation is either all used or none of it is, so CachedAttention evicts whole sessions, using the waiting jobs in the scheduler's queue to decide which [@gao2024]. An eviction does not lose the conversation, only the saved work, so a policy that is occasionally wrong costs a recompute, not an error. Better policies use more than recency, such as expected reuse and the cost to recompute, which depends on context length. Eviction happens only under pressure, when a block is needed and none is free.

## `kvtiers` KV tiers below GPU memory
_Where:_ Dive deeper drop-down in the step-through box, under the steps `walk.evict.when`, `walk.evict.force`, `kv.move.dram`, `kv.move.ssd`, `kv.move.remote`, `kv.drop`, `walk.evict.cases`, `kv.reload`.

### title
KV tiers below GPU memory

### body
GPU memory is the scarcest tier, and an idle conversation holds batch capacity the pod could use. Below it sit host DRAM, local SSD and pools on other machines, each larger and slower to read back. Systems such as LMCache, Mooncake and CachedAttention move blocks down these tiers instead of dropping them [@lmcache2025], [@qin2024], [@gao2024]; llm-d ships a KV offloader for CPU memory and storage [@llmdKvOffloader], and NVIDIA Dynamo names the tiers G1 to G4 [@dynamoKvbm]. A tier shared between pods, such as shared storage or a remote pool, survives a pod being scaled down and can be read by other pods [@llmdKvOffloader]. Moving a block down is cheap when it overlaps with computation. The question each tier answers is whether reading the blocks back beats recomputing them, which depends on its bandwidth, the context length and the model. When nothing has room the blocks are dropped, and the text in the conversation store is what remains.

## `reload` Reload versus recompute
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.admitted.miss`, `walk.evict.cases`, `walk.evict.return`, `kv.reload`, `kv.skipload`.

### title
Reload versus recompute

### body
When a conversation returns, its saved work can be copied back from a lower tier or computed again by a prefill, and either can be faster. Copying takes the bytes divided by the tier's bandwidth; recomputing takes the prefill time of the tokens, which grows faster than linearly with context because of attention. Loading therefore wins for long contexts and large models, where the bytes are small next to the arithmetic, and on fast links; for short contexts, or over a slow network, recomputing wins. LMCache measured it on B200 GPUs: over a 32 Gbps link loading beat prefill only beyond about 256K tokens, while at 64 or 128 Gbps it won at every length, so it concludes that loading should be adaptive [@lmcache2025]; CacheGen shrinks the bytes themselves by compressing the cache [@liu2023]. An engine that compares the two costs for each request never does worse than the better of the two.

### formula
$$\text{load if } \ \frac{L\,M_{\text{token}}}{BW_{\text{tier}}} < t_{\text{prefill}}(L)$$

## `disagg` Prefill/decode disaggregation
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.admitted.again`, `kv.transfer`.

### title
Prefill/decode disaggregation

### body
Prefill is compute-bound and bursty, decode memory-bound and sensitive to delay, and on one pod each prefill delays every decode. Disaggregation gives them separate pools, each sized and configured for its phase, and moves a request's KV from the prefill pod to a decode pod once [@zhong2024], [@patel2023]. Mooncake builds a whole architecture around the cache and its transfer [@qin2024]. The price is the transfer: the bytes of the prompt's keys and values cross a network link, so the link's bandwidth limits how far apart the pools can be, and it competes with other traffic on the same links. It pays when the delay bound on each token is tight, when prompts are long and when the model is large; for a one-token prompt it is pure added latency. llm-d decides per request whether the prefill pool is worth it [@llmdDisaggregation].

### formula
$$t_{\text{transfer}} = \frac{L \cdot M_{\text{token}}}{BW_{\text{link}}}$$

## `cost` Cost per million tokens
_Where:_ Dive deeper drop-down in the step-through box, under the steps `req.done`, `walk.end`.

### title
Cost per million tokens

### body
A price per million tokens is a statement about a whole stack under a load pattern. For a self-hosted model it is the price of the GPU-hours divided by the tokens they produced, so it falls when more tokens are made per GPU-second: a larger batch, a faster step, a higher cache hit rate or fewer idle pods. The batch is limited by memory and by the latency bound, which is why cost and latency trade against each other [@pope2022]. Providers usually charge more for output tokens than input tokens, a likely reason being that prefill can process many tokens at once while decode produces one per sequence per step [@databricksInference]. Two numbers are needed with any cost figure: how efficiently the stack uses the hardware, and how much of the time the GPUs are busy. The cost line in the site's status panel is computed this way from the simulation's GPU-seconds and the tokens emitted.

### formula
$$\frac{\$}{10^{6}\ \text{tokens}} = \frac{n_{\text{GPU}}\, t\ \cdot\ \text{price per GPU-hour}/3600}{\text{tokens produced}}\cdot 10^{6}$$
