# Step-through and floating callouts

The boxes that explain what is happening to a request. In "explain" mode a short one (title and body) floats beside its node for a few seconds when something happens there. In step-through mode the visitor follows one session: the clock stops at each step, the box is held at the bottom of the screen until Next is pressed, and the `at` line (where in the system we are) and the detail are shown as well. The long teaching text lives in the detail, which only step-through shows; entries whose id starts with `walk.` are shown only there. A term is explained the first time the walkthrough uses it. Values in braces are filled in by the code from the simulation; numbers are formatted there.

## `req.new` A user sends a message
_Where:_ Beside the session that sends a request, the first time one is sent; first box of every step-through. A follow-up has its own box, `req.followup`.

### at
At the client

### title
A user sends a message

### body
Session {sid} is one conversation, drawn in its own colour everywhere in the graph. Its message leaves the client as plain text over HTTP. Nothing is a token yet.

### detail
A model call is stateless: the model remembers nothing between calls, so every request must carry everything it should know [@vllmOpenAiServer]. For this first message that is only the user's words; the gateway adds the rest.

The call is an HTTP chat-completions request: a list of messages goes in, a reply comes out. That request and response format originated with [OpenAI's API][@openaiChatCompletions] and is copied by most open engines (vLLM, SGLang, TGI, llama.cpp, Ollama), which is why tools call it "OpenAI-compatible". It is a convention, not a formal standard, and other vendors such as Anthropic and Google have formats of their own.

## `req.followup` Same user, same conversation
_Where:_ Beside the session, when it sends a follow-up message (at most once every five seconds in explain mode); the first box of a follow-up turn in step-through.

### at
At the client

### title
Same user, same conversation: message {turn}

### body
Session {sid} is the person from before, writing again in the same conversation: {fresh} new tokens on top of {history} tokens of earlier turns.

### detail
Only the new message is typed. Everything before it will be added by the gateway in the next steps, because the model remembers nothing between calls. If its saved work is still on a pod, only the new tokens need computing.

## `store.read` History is read back
_Where:_ Beside the conversation store, the first time history is read for a new turn (every follow-up in step-through).

### at
At the conversation store, then the gateway

### title
Why all of the history is sent again

### body
Every request carries the whole conversation: the gateway reads the earlier turns from the conversation store (every turn, as text) and puts them before the new message.

### detail
{history} history tokens ride along with {fresh} new ones: that is how chat-completions calls work [@vllmOpenAiServer]. It is also why caching pays: the history is last turn's prefix, so the engine finds its saved work by hash and computes only the new tokens [@vllmPrefixCaching], [@zheng2023], and the router can send the request to the pod holding it [@llmdScheduling], [@gao2024].

## `req.tokenized` The prompt is counted in tokens
_Where:_ Beside the gateway and prompt assembler, the first time a prompt has been assembled and counted.

### at
At the gateway, in front of the router

### title
{tokens} tokens: the prompt is counted

### body
The gateway builds the prompt (system prompt, history, new message) and counts it in tokens, the small pieces of text a model reads and writes. It does this before any GPU time is spent.

### detail
{history} tokens of history + {fresh} new. The count feeds rate limits (next step) and the router, which uses the prompt's identity to find a pod already holding its prefix [@llmdKvCacheIndexer], [@llmdScheduling]. The site draws the gateway as one node; real deployments differ in where counting happens.

### detail-again
{history} tokens of history + {fresh} new, counted as before.

## `walk.cost` Why tokens, not requests
_Where:_ Step-through only: beside the gateway and prompt assembler, the first time a prompt has been counted.

### at
At the gateway

### title
Why count tokens, not requests

### body
Reading a prompt takes work in proportion to its tokens, each token in context takes {perToken} of GPU memory, and each output token needs another pass through the model. So a 10,000-token request costs about a hundred times a 100-token one.

### detail
That is why providers limit each customer in tokens per minute as well as requests per minute [@openaiRateLimits], and why a gateway counts tokens before spending GPU time [@envoyAiGatewayRateLimit]. This prompt: {tokens} tokens, {kv} of memory. The memory per token comes from the model's shape: one key and one value vector for each layer and each key-value head.

$$\text{KV bytes per token} = 2 \cdot n_{\text{layers}} \cdot n_{\text{kv heads}} \cdot d_{\text{head}} \cdot b$$

where $b$ is the bytes per stored number (2, for 16-bit floats) and $d_{\text{head}}$ the length of one vector [@kwon2023].

## `walk.deadline` A deadline is attached
_Where:_ Step-through only: beside the gateway and prompt assembler, the first time a prompt has been counted. The body depends on the "shed requests waiting longer than" setting.

### at
At the gateway

### title
A deadline is attached

### body-set
The request may wait in the router's queue for at most {limit}. After that it is rejected rather than answered late.

### body-never
The request may wait in the router's queue as long as it takes: the slider "shed requests waiting longer than" is at never. Set it, and a request that waits longer is rejected rather than answered late.

### detail
llm-d calls this limit the flow-control request time-to-live [@llmdFlowControl]. A quick rejection (HTTP 429) helps a client more than an answer that arrives after it has given up, and it keeps the queue from filling with work nobody waits for. This pattern is called load shedding: when more work arrives than can be served, reject the excess early ("fail fast") so that the work that is accepted still meets its deadline, instead of letting every request get slower until all of them are late [@sreHandlingOverload], [@awsLoadShedding].

## `req.queued` No pod is ready
_Where:_ Beside the router, the first time a request arrives while no pod is ready.

### at
At the router

### title
No pod is ready

### body
The router picks a pod (one copy of the model on its GPUs) for each request. None is running yet, so the request waits while the autoscaler starts one.

### detail
This wait counts towards the time to first token. It is why fleets keep a warm minimum of pods that are always running (the "min pods" slider, {minPods} now): scaling to zero saves money, but someone then pays the cold start [@knativeAutoscaling], [@llmdAutoscaling].

## `scale.up` The autoscaler adds pods
_Where:_ Beside the router, every time the autoscaler raises the number of pods. The body is built from one demand sentence, one "needed" sentence and, when the pod limit is reached, the cap sentence. The detail adds the disaggregation sentence when prefill and decode run on separate pools.

### at
At the autoscaler

### title-one
Scale up to {to} pod

### title-many
Scale up to {to} pods

### demand-one
{demand} request is in flight, and one pod runs at most {perPod} at once, so

### demand-many
{demand} requests are in flight, and one pod runs at most {perPod} at once, so

### needed-one
{to} pod is needed.

### needed-many
{to} pods are needed.

### cap
That hits the cap of {maxPods} pods; the rest queue at the router.

### detail
A pod's engine caps its concurrent requests at `max_num_seqs` [@vllmSchedulerConfig]; the pod draws one slot, a bar, for each. The rule is requests in flight ÷ slots per pod, rounded up and kept between min and max pods: [Knative][@knativeAutoscaling], [llm-d][@llmdAutoscaling] with [KEDA][@keda]. Real autoscalers react with a delay; this one reacts at once.

### detail-disagg
With disaggregation at least two pods are started: one for prefill, one for decode.

## `pod.loading` Weights load into GPU memory
_Where:_ Beside the GPU memory of a pod, the first time a pod starts loading its model.

### at
On the new pod, in GPU memory

### title
Weights load into GPU memory

### body
The pod copies the model's weights, the learned numbers it computes with, into the GPU's own high-bandwidth memory (HBM): {weights} per GPU. It cannot serve until all of them are there.

### detail
The dark block filling up is that copy. It is most of the cold start, the {cold} a new pod needs before it takes traffic. GPU memory holds two things: these weights, and the cache of keys and values that comes next [@kwon2023].

## `pod.ready` The KV pool is what remains
_Where:_ Beside the GPU memory of a pod, the first time a pod finishes loading.

### at
On the new pod, in GPU memory

### title
GPU memory is split in four; the KV pool is what remains

### body
Each GPU's memory has four parts, left to right in the box: the weights ({weights}); activations and CUDA graphs ({work}), the working space of a forward pass and the captured graphs that launch it; the headroom ({headroom}), the part above `gpu_memory_utilization` that the engine leaves unused; and the KV pool, which is what remains of the share the engine may use: {kv} per GPU, {blocks} blocks of 16 tokens for the pod. The KV cache holds the keys and values the model computed for every token it has read, so it never recomputes them.

### detail
The grid of empty cells is that pool; each cell takes the colour of the session whose tokens it holds. The engine may use `gpu_memory_utilization` times the memory the driver reports [@vllmEngineArgs], [@vllmMemoryProfiling]; from that share it takes the weights, the activations and the CUDA graphs it captures, and the rest becomes the pool, cut into blocks so no memory is wasted [@kwon2023]. The headroom is not taken from the pool: it is the memory outside the share. The pool caps how many requests fit at once.

## `pod.failed` The model does not fit
_Where:_ Beside the GPU memory of a pod whose weights leave no room for a batch (every time, not only the first).

### at
On the new pod, in GPU memory

### title
The model does not fit

### body
Weights, working space and CUDA graphs need {fixed} of the {usable} the engine may use per GPU, leaving no room for a batch. Raise tensor parallelism or pick a larger GPU.

## `req.routed` Routed to a pod
_Where:_ Beside the router, the first time a request is sent to a pod. The body is one sentence about the routing policy in use, plus one about disaggregation when it applies. The detail is the formula or rule of that policy.

### at
At the router

### title
Routed to pod-{podId}

### how-prefix-aware
Prefix-aware: each ready pod gets a score and the highest wins. A pod already holding this conversation's saved work (its KV cache) scores well, unless it is too busy: busier than another pod by more than the cache saves.

### how-least-loaded
Least-loaded: the pod with the fewest requests running, waiting or on their way, like the least-request balancer of [Envoy][@envoyLoadBalancing].

### how-round-robin
Round-robin: the pods take turns, whatever they hold and however busy they are, like the default balancer of [Envoy][@envoyLoadBalancing].

### via-prefill
Disaggregated serving: most of this prompt is not cached on any decode pod, so it goes to a prefill pod first; its KV will be handed to a decode pod afterwards. (In [llm-d][@llmdDisaggregation] the decode pod is chosen first and a sidecar in front of it calls the prefill pod with max_tokens=1; the line is drawn straight to the prefill pod here.)

### via-decode-only
Disaggregated serving: the decode pod already holds nearly all of this prompt, so the prefill pool is skipped and the few new tokens are prefilled in place.

### detail-prefix-aware
The score of a ready pod $p$ is below. The weights are [llm-d's][@llmdScheduling] in the [Gateway API Inference Extension][@gatewayInferenceExtension]; scaling the cache term by memory tier is the site's own.

$$\text{score}(p) = [[wCache]]\,c_p + [[wKv]]\,m_p + [[wQueue]]\,q_p$$

| symbol | in plain words |
|---|---|
| $c_p$ | cached share: the share of this prompt's tokens whose KV (saved work) is already on pod $p$, scaled down when it sits in a slower memory tier (HBM ×{affHbm}, DRAM ×{affDram}, SSD ×{affSsd}, remote pool ×{affRemote}) |
| $m_p$ | free KV memory: the share of pod $p$'s KV memory that running requests do not hold |
| $q_p$ | free capacity: the share of pod $p$'s request capacity that is still free, counting requests running, waiting or on their way against a capacity of {cap} |
| [[wCache]], [[wKv]], [[wQueue]] | weights: how much each share counts |

Every share is between 0 and 1, so the cache term is worth at most [[wCache]] points and the two load terms at most [[wKv]] each.

**When is a pod too busy?** A pod with {cap} requests running, waiting or on their way ({slots} slots plus a queue allowance of {slack}) is not a candidate at all. Short of that, a pod is too busy when the other pods lead on the two load terms by more than the cache term is worth. The cached pod $a$ keeps the request while $[[wKv]]\,(m_b - m_a) + [[wQueue]]\,(q_b - q_a) < [[wCache]]\,c_a$. A pod holding the whole prompt in HBM ($c_a = 1$) therefore loses once another pod is ahead by more than [[wCache]] of the at most {loadMax} points the load terms can differ by, and one holding 96% of it once the lead passes {lead96}. In this model that happens when many conversations have their cache on the same pod: their follow-ups pile up there while another pod idles. The trade is between prefill time (recompute the prefix on the idle pod) and queue time (wait behind the full one); the weights say where it flips. Example with {slots} slots: a pod holding all of a prompt in HBM, with a KV pool {exampleKv}% in use, is passed over for an idle pod from {exampleLoad} requests on.

### detail-least-loaded
The router counts each pod's running, waiting and inbound requests and takes the smallest. It ignores what the pods hold, so a returning conversation may land on a pod that has to compute its history again.

### detail-round-robin
The router keeps a counter and sends the next request to the next pod. It ignores load and cache, so a returning conversation usually lands on a pod that has to compute its history again.

## `walk.picked` Why this pod
_Where:_ Step-through only: beside the router, right after the routing policy is explained. The body shows the decision as a table with one row per candidate pod (the numbers the router used, or the rule that decided) and one sentence in words about the notable values; the detail says what the chosen pod holds. The "holds" part names the memory tier when the pod holds some of the prompt.

### at
At the router

### title
Why pod-{podId} was chosen

### table
{table}

### head-prefix-aware
| pod | cached share $c$ | free KV memory $m$ | free capacity $q$ | score |
|---|---|---|---|---|

### row-prefix-aware
| pod-{podId} | {c} | {m} | {q} | {score} |

### row-prefix-aware-chosen
| **pod-{podId}** | {c} | {m} | {q} | **{score}, chosen** |

### head-least-loaded
| pod | requests running, waiting or on their way | |
|---|---|---|

### row-least-loaded
| pod-{podId} | {load} | |

### row-least-loaded-chosen
| **pod-{podId}** | {load} | **fewest, chosen** |

### head-round-robin
| pod | requests running, waiting or on their way | |
|---|---|---|

### row-round-robin
| pod-{podId} | {load} | |

### row-round-robin-chosen
| **pod-{podId}** | {load} | **its turn, chosen** |

### more
{more} more pods scored lower and are not shown.

### why-single
There is only one pod, so there is nothing to compare; add pods in the menu to see a choice.

### why-first-message
$c$ is 0 for every pod because this is the first message of the conversation: no pod has seen it yet, so the cache cannot decide and only the two load terms do.

### why-nothing-held
$c$ is 0 for every pod because none of them still holds this conversation's saved work (it was evicted, dropped or never kept), so only the two load terms decide.

### why-tie
All pods are equally free, so the first one wins.

### why-cache-clear
Pod-{podId} holds {cache}% of the prompt, which earns it {cacheTerm} points, and no other pod is less loaded, so the cache decides.

### why-cache-wins
Pod-{podId} holds {cache}% of the prompt, which earns it {cacheTerm} points. Pod-{otherId} is less loaded and leads by {lead} points on free memory and capacity, but that is less than the cache is worth, so pod-{podId} wins.

### why-cache-loses
Pod-{otherId} holds more of the prompt ({otherCache}%, worth {otherCacheTerm} points), but pod-{podId} is less loaded and leads by {lead} points on free memory and capacity, more than that cache earns: pod-{otherId} is too busy, and the prefix is computed again on pod-{podId}.

### calc-least-loaded
Of {n} ready pods, pod-{podId} has the fewest requests running, waiting or on their way; a tie goes to the first. Whatever the pods hold is ignored.

### calc-round-robin
The router's counter stands at {turn}. With {n} pods, {turn} mod {n} = {slot}, so it is pod-{podId}'s turn, whatever it holds and however busy it is.

### holds-hbm
It already holds {cache}% of this prompt in its HBM, the GPU's own high-bandwidth memory,

### holds-tier
It already holds {cache}% of this prompt in {tier},

### holds-none
It holds none of this prompt,

### busy-none
and has no other requests running or waiting.

### busy-one
and has one other request running or waiting.

### busy-many
and has {load} other requests running or waiting.

### pinned
From now to its last token the request stays on this pod, because its saved work lives in that pod's memory.

## `walk.arrive` Tokenised again on the pod
_Where:_ Step-through only: beside the engine of the chosen pod, the first time a request reaches a pod.

### at
On the pod, at the engine's server

### title
On the pod: tokenised again

### body
The request travels to the pod as text over an HTTP chat-completions API. The engine's own server applies the model's chat template and tokenises it again, giving the token ids the model really consumes.

### detail
The gateway's count informed decisions (limits, routing); this second pass is the model's actual input [@vllmOpenAiServer]. Both happen on the host CPU, before the GPU is involved.

## `walk.slot` The request takes a batch slot
_Where:_ Step-through only: beside the engine of a pod, the first time a request is admitted to a pod.

### at
On the pod, in the engine

### title
The request takes a batch slot

### body
A pod's engine ([vLLM][@vllmRepo]) runs several requests at once and calls each one a sequence: its prompt plus the answer so far. The pod draws one slot, a bar, for each it may run at once ({slots}, `max_num_seqs` [@vllmSchedulerConfig]). This request now holds one.

### detail
The stripe on top of the bar is the session's colour. The running sequences together are the batch; any beyond {slots} wait in a queue for a slot.

## `req.admitted.hit` Prefix cache hit
_Where:_ Beside the engine of a pod, when a request is admitted and most of its prompt is already cached in HBM.

### at
On the pod, in GPU memory

### title
Prefix cache hit

### body
{cached} of {prompt} prompt tokens are already in the pod's KV cache. Only {fresh} are prefilled.

### detail
The engine finds them by the hash of each 16-token block, so only an identical prefix matches [@vllmPrefixCaching]. The cells of this session turn from pale back to full colour: in use again. A follow-up prefill is short, and then comes the usual decode.

## `req.admitted.miss` Rebuilt from text
_Where:_ Beside the engine of a pod, when a follow-up turn is admitted but no tier holds its KV any more (at most once every four seconds).

### at
On the pod, in the engine

### title
Rebuilt from text

### body
No tier holds session {sid}'s KV any more. All {prompt} tokens are prefilled again from the conversation store's text: slower, never wrong.

## `req.admitted.again` Back in a slot
_Where:_ Beside the engine of a pod, when a request takes a slot a second time: after a preemption, or on the decode pod once a prefill pod has handed its KV over (step-through only).

### at
On the pod, in the engine

### title
Back in a slot

### body-preempted
Its whole context fits again, so the request takes a slot and reads its {prompt} prompt tokens afresh, because its saved work was given up.

### body-handoff
The request takes a slot on this decode pod. Its prompt's KV arrived over the network, so only decoding is left.

## `req.admitted.prefill` Prefill
_Where:_ Beside the engine of a pod, the first time a first-turn request is admitted.

### at
On the pod, in the engine

### title
Prefill: the prompt is read

### body
The engine now reads all {prompt} prompt tokens in one go: prefill. The slot fills orange as it does, and for every token the engine stores keys and values in the KV cache.

### detail
Long prompts are cut into chunks of at most the token budget per step, so one big prompt does not stall everyone else [@agrawal2024]. Prefill has high arithmetic intensity: it performs many arithmetic operations (FLOPs) for each byte it fetches from memory [@williams2009], which is what makes it compute-bound (the roofline gauge below shows it).

## `walk.kvmap` The KV cache as a map of GPU memory
_Where:_ Step-through only: beside the GPU memory of a pod, while a prompt is being prefilled, the first time.

### at
On the pod, in GPU memory

### title
The KV cache, as a map of GPU memory

### body
The box under the bars is the same memory as a map: the dark block is the weights, the grid is the KV pool cut into blocks of 16 tokens. Each cell takes the colour of the session whose keys and values it holds (one cell stands for {cellBlocks} blocks).

### detail
Each token the bar gains writes more keys and values, so cells in this session's colour appear as it fills. Above the bars, "KV cache used / {pool} GB" says how much of this pool is in use [@kwon2023], [@vllmEngineArgs].

## `walk.roofline` Prefill is compute-bound
_Where:_ Step-through only: beside the roofline gauge of a pod, while a prompt is being prefilled, the first time.

### at
On the pod, under the memory map

### title
Prefill is compute-bound

### body
The gauge shows arithmetic intensity: how many arithmetic operations (FLOPs) a step does per byte it reads from memory. A GPU can do only so many operations and read only so many bytes per second; the ridge, {ridge} here, is where the two limits meet [@williams2009].

### detail
Left of the ridge a step waits on memory (memory-bound), right of it on arithmetic (compute-bound). Prefill works through thousands of tokens against one read of the weights, so the dot sits far right.

## `req.firstToken` Decode: one token per step
_Where:_ Beside the roofline of a pod, the first time a request produces its first token. In step-through it is shown a few steps later, once the gauge has settled.

### at
On the pod, under the memory map

### title
Decode: one token per step

### body
The first token came out {ttft} after the request began. From here the slot fills blue: the answer is generated one token at a time (decode), and the dot moves left of the ridge.

### detail
The engine works in steps: a step is one pass through the model that advances every running request, usually by one token [@yu2022]. It reads all the weights for one token per request: few operations per byte, so it waits on memory. A bigger batch gives more tokens per step, each step a little slower [@kwon2023].

## `step.tokens.stream` Output tokens streaming back
_Where:_ Beside the output stream, the first time tokens leave a pod.

### at
From the pod back to the client

### title
Output tokens stream back

### body
Each blue dot is a generated token leaving the pod. It is turned back into text and sent to the client at once (streaming), so the user watches the answer grow.

### detail
One dot per running request per step. Streaming is part of the chat-completions API the engine serves [@vllmOpenAiServer].

## `step.tokens.batch` One weight read, several tokens
_Where:_ Beside the engine of a pod, the first time a step decodes at least four sequences together.

### title
One weight read, {n} tokens

### body
Continuous batching shares each forward pass. Throughput rises with the batch while every step gets a little slower.

## `step.spec` Speculative decoding
_Where:_ Beside the roofline of a pod, when a step used speculative decoding (at most once every 20 seconds).

### title-one
Speculative decoding: {tokens} tokens from {seqs} sequence in one step

### title-many
Speculative decoding: {tokens} tokens from {seqs} sequences in one step

### body
A small draft model guesses up to {k} tokens ahead; the large model checks them all in a single pass and keeps the agreeing prefix plus one token of its own. Decode is limited by reading memory, not by arithmetic, so checking the extra positions is nearly free.

## `kv.transfer` KV handed over
_Where:_ Beside the decode pod, when a prefill pod hands a prompt's KV over (disaggregated serving; at most once every six seconds).

### at
On the decode pod

### title
KV handed over: prefill pod → decode pod

### body
Session {sid}'s prompt was prefilled on pod-{from}. Its {size} of keys and values cross a {link} Gbps link in {dur}; decoding starts here.

### detail
Prefill is compute-bound and decode is memory-bound. On one pod a new prompt stalls every running stream; on separate pools neither disturbs the other, at the price of moving the cache once. That transfer is what limits how far apart the two pools can be.

## `step.mixed` A prefill shares the step with the decoders
_Where:_ Beside the roofline of a pod, when a step mixed prompt tokens with decodes (at most once every 12 seconds). One body when the decoders alone would not have taken a measurable time, another comparing the step with the decode-only time.

### title
A prefill shares the step with the decoders

### body
{prefillTok} prompt tokens rode along with {decodeTok} decodes. The step took {dur}: compute-bound work stalls every memory-bound stream on the pod.

### body-instead
{prefillTok} prompt tokens rode along with {decodeTok} decodes. The step took {dur} instead of {decodeDur}: compute-bound work stalls every memory-bound stream on the pod.

## `req.done` The last token is generated
_Where:_ Beside the engine of a pod, the first time a request completes.

### at
On the pod, in the engine

### title
The last token is generated

### body
The answer is complete: {out} tokens, {tpot} per token after the first. The request leaves its slot at once, and a waiting request takes it in the very next step: continuous batching [@yu2022].

### detail
That is why bars disappear and new ones pop up. This session's cells in the memory map turn pale: still cached for a follow-up, and first to be evicted when room is needed [@vllmPrefixCaching].

### detail-again
The session's cells turn pale again, as before.

## `walk.reply` The user has the whole reply
_Where:_ Step-through only: beside the session, once the last output token of its answer has visibly arrived.

### at
At the client

### title
The user has the whole reply

### body
The last token has reached session {sid}: {out} tokens in all, the first after {ttft} (the time to first token, which is what the user feels as waiting).

### detail
The call is over and the model keeps nothing from it. What survives is the text, saved next, and the saved work on the pod.

## `store.append` The turn is appended as text
_Where:_ Beside the conversation store, the first time a finished turn is saved.

### at
At the conversation store

### title
The turn is saved as text

### body
The gateway appends this turn to the conversation store. This log is the system of record: every KV cache is a copy that can be lost and rebuilt from it by a prefill.

### detail
If the user writes again, the gateway reads the turn back from here and puts it in front of the new message.

## `session.idle` The session goes idle
_Where:_ Beside the session, when it stops replying (at most once every six seconds in explain mode). The body depends on whether its KV is still cached.

### at
At the client

### title
The user does not reply: session {sid} goes idle

### body-cached
Nothing more is sent. The session's {size} of KV cache stay on the pod, pale in the memory map, in case the user comes back.

### body-freed
Nothing more is sent. With prefix caching off the KV blocks were freed the moment the answer finished, so nothing is left on the pod.

## `churn` Session churn
_Where:_ Beside the session, when new sessions keep arriving (at most once every ten seconds). The rate sentence is shown only when new sessions arrive continuously.

### title
Session churn

### rate
{rate} new sessions per second.

### body
Of {total} sessions: {active} waiting on a model call, {typing} typing a follow-up, {idle} gone idle.

## `walk.evict.when` Eviction happens only under pressure
_Where:_ Step-through only: beside the GPU memory of the pod holding an idle session, after the session went idle.

### at
On the pod, in GPU memory

### title
Idle KV stays until room is needed

### body
Pale cells cost nothing but space. Nothing is evicted until a new request needs a block and the pool has none free. Then the idle session used longest ago leaves first, whole (least recently used, LRU).

### detail
Per-session LRU: [@gao2024]; vLLM also frees cached blocks least recently used first [@vllmPrefixCaching], block by block. The site moves whole sessions: a returning turn needs all its history or none.

## `walk.evict.force` The walkthrough forces an eviction
_Where:_ Step-through only: beside the memory tiers of the pod, before the walkthrough forces the eviction of the followed session. Pressing Next triggers it.

### at
On the pod, memory tiers

### title
Forcing an eviction now

### body
In a live run this happens when the pool fills, which may take minutes. To show it, the walkthrough forces the eviction of session {sid} now, as if the pool needed its blocks. It runs the simulation's own eviction code, so what you see next is the real animation. Press Next.

## `kv.move.dram` Evicted: HBM to DRAM
_Where:_ Beside the memory tiers of a pod, when an idle session's KV moves from HBM to host memory.

### at
On the pod, memory tiers

### title
Evicted: HBM → DRAM

### body
Session {sid} was idle for {idleFor} s. Its {size} of KV blocks move to host memory (DRAM, the server's ordinary RAM) to make room.

### body-forced
Session {sid}'s {size} of idle KV blocks move to host memory (DRAM, the server's ordinary RAM) to make room.

### detail
The cells leave the grid and the DRAM bar grows. Host memory is the first place tried: more room than GPU memory, but slower to read back [@gao2024], [@llmdKvOffloader].

## `kv.move.ssd` Pushed down to SSD
_Where:_ Beside the memory tiers of a pod, when KV moves down to the local SSD.

### at
On the pod, memory tiers

### title
Pushed down: {from} → SSD

### body
Host memory could not take it. Session {sid}'s {size} go to the local SSD: more room, slower to bring back.

### detail
The tier below host memory on the same machine [@lmcache2025], [@llmdKvOffloader].

## `kv.move.remote` Spilled to the remote pool
_Where:_ Beside the remote pool node, when KV moves to the pool shared by all pods (at most once every four seconds).

### at
At the remote pool

### title
Spilled to the remote pool

### body
This node's tiers are full. Session {sid}'s {size} go to a pool that every pod can reach, at network speed.

### detail
Shared pools such as [Mooncake's][@qin2024] are the only tier that survives this pod being scaled down and the only one another pod can load from.

## `kv.drop` KV dropped
_Where:_ Beside the memory tiers of a pod (or the remote pool), when no tier has room and a session's KV is discarded.

### at
On the pod, memory tiers

### title
KV dropped

### body
No tier has room. Nothing is lost but time: if session {sid} returns, its {tokens} tokens are prefilled again from the stored text.

### detail
The conversation store still has the text, so the session is rebuilt by a prefill: slower, never wrong [@gao2024].

## `walk.evict.cases` Where evicted KV goes
_Where:_ Step-through only: beside the memory tiers of the pod, after the forced eviction, naming the cases the demonstration did not show. The sizes are the current settings.

### at
On the pod, memory tiers

### title
Where evicted KV goes in general

### body
Host DRAM ({dram}) is tried first. If it is full, its oldest session moves down to the local SSD ({ssd}); if the node is full, to a pool shared by all pods ({remote}); if nothing has room, the KV is dropped.

### detail
A dropped session is rebuilt from the stored text if the user returns. Layering: [@gao2024], [@qin2024], [@lmcache2025]; shipped in [llm-d's KV offloader][@llmdKvOffloader] and [NVIDIA Dynamo][@dynamoKvbm].

## `walk.evict.return` If the user comes back
_Where:_ Step-through only: beside the memory tiers of the pod, after the eviction. The body depends on where the KV went and which is cheaper, copying it back or computing it again.

### at
On the pod, memory tiers

### title
If the user comes back

### body-load
The engine compares two costs. Copying the {size} back from {tier} takes {load}; computing them again would take {recompute}. Copying is cheaper, so it copies.

### body-recompute
The engine compares two costs. Copying the {size} back from {tier} takes {load}; computing them again would take {recompute}. Computing is cheaper, so it recomputes.

### body-dropped
Nothing is cached any more, so the whole prompt of {tokens} tokens is prefilled again from the text in the conversation store.

### detail
Choosing per request is the argument of [@lmcache2025]: which wins depends on the tier's speed, the context length and how busy the GPU is. [@liu2023] speeds up the copy itself.

## `walk.end` End of this session's walkthrough
_Where:_ Step-through only: the last box of the followed session. Next follows the next session that sends a request.

### at
End of the walkthrough

### title
End of this session's walkthrough

### body-evicted
You followed session {sid} from its message at the client to its KV cache leaving GPU memory. Next follows the next new request; exit leaves step-through.

### body-idle
You followed session {sid} from its message at the client to the end of its conversation. Next follows the next new request; exit leaves step-through.

### body-failed
Session {sid}'s request was rejected, so there is no answer to follow. Next follows the next new request; exit leaves step-through.

## `kv.reload` Loaded back
_Where:_ Beside the memory tiers of a pod, when a returning session's KV is copied back to HBM.

### at
On the pod, memory tiers

### title
Loaded back from {from}

### body
Session {sid} is back. Copying {size} to HBM takes {dur}; recomputing it would take {recompute}.

## `kv.skipload` Recompute beats loading
_Where:_ Beside the memory tiers of a pod, when a returning session's KV is not loaded because prefilling again is faster (at most once every five seconds).

### at
On the pod, memory tiers

### title
Recompute beats loading

### body
Copying session {sid} back from {from} would take {dur}; prefilling its {tokens} tokens again takes {recompute}. The engine recomputes.

## `req.preempted` Preempted
_Where:_ Beside the engine of a pod, when the KV pool is full and a running sequence gives its blocks back.

### at
On the pod, in the engine

### title
Preempted

### body
The KV pool is full and nothing idle is left to evict. Session {sid} gives its blocks back. It waits until all {lost} tokens of its context fit again, then re-prefills them.

### detail
All of a sequence's blocks go, newest admission first. A waiting request, preempted or new, is let in only when its whole sequence fits in the free blocks, so a preempted one does not come straight back to be preempted again [@vllmScheduler]. The tokens already streamed are kept as text, so the user sees a stall, not a restart [@vllmOptimization].

## `req.failed` Request rejected
_Where:_ Beside the pod or the router that rejected a request, for example because it waited past its deadline.

### at
Where it was rejected

### title
Request rejected

### body
Session {sid}: {why}.

## `scale.down` Scaled down
_Where:_ Beside a pod that the autoscaler removes after it sat idle.

### title
Scaled down

### body
Idle for {idle} s. The KV in this node's HBM, DRAM and SSD is lost with it; only the remote pool and the text survive.

## `fleet.restart` Fleet restarted
_Where:_ Beside the router, when a setting that sizes the weights or the KV pool changes and every pod is rebuilt.

### title
Fleet restarted

### body
Weights and the KV pool are sized at start-up, so this change rebuilds every pod. In-flight requests re-prefill.
