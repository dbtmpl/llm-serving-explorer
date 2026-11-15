# Tutorial

The cards of the guided tour. It opens on a first visit and again whenever the visitor presses the tutorial button; each card points at one component of the graph and shows a looping preview of its animation. The cards appear in the order of this file.

## `welcome` One live graph of an LLM serving stack
_Where:_ The first card of the tutorial, shown on a first visit and when the visitor presses the tutorial button. It points at nothing in particular.

### title
One live graph of an LLM serving stack

### text
It starts empty and grows as requests travel through it, in slow motion. A small demo is running behind this tour. Each step points at one component and shows what its animation means.

## `session` Sessions
_Where:_ Tutorial card 2, pointing at a session in the graph.

### title
Sessions

### text
Each dot or card is one conversation, with its own colour everywhere in the graph. Bright means it is waiting on a model call, lighter means the user is typing a follow-up, pale means it went idle. The small page leaving it is the prompt, still text. The ring fills as its answer streams in.

## `assemble` Gateway and prompt assembly
_Where:_ Tutorial card 3, pointing at the gateway and prompt assembler.

### title
Gateway and prompt assembly

### text
Hops 1 and 2. The gateway authenticates the call and builds the prompt: system prompt, history, new message. The text lights up piece by piece as it is counted in tokens (small pieces of text, the unit that limits and prices use), and the bar shows how much is history and how much is new.

## `store` Conversation store
_Where:_ Tutorial card 4, pointing at the conversation store.

### title
Conversation store

### text
The text of every turn, appended as a log. Grey dots going down are history being read back for a new turn; grey dots arriving are a finished turn being saved. It is the source of truth: every KV cache below is a copy that can be rebuilt from it.

## `router` Router
_Where:_ Tutorial card 5, pointing at the router.

### title
Router

### text
Hop 3. Small trains of squares are counted prompts on their way to a pod. The router scores the pods and picks one; by default the pod that already holds the session's saved work (its KV cache) wins unless it is too busy. Squares stacked above it are requests waiting for a free pod.

## `weights` A pod and its GPUs
_Where:_ Tutorial card 6, pointing at the GPU memory of a pod.

### title
A pod and its GPUs

### text
A pod is one replica of the model on one or more GPUs. Each GPU box is its memory: the dark block fills while weights load, then comes a thin strip of activations, the grid of KV blocks, and hatched headroom that is never used.

## `slots` The running batch
_Where:_ Tutorial card 7, pointing at the running batch of a pod.

### title
The running batch

### text
One slot, drawn as a bar, for each request the engine may run at once (`max_num_seqs`, a setting under Engine [@vllmSchedulerConfig]). The engine calls a running request a sequence: its prompt plus the answer so far; together they are the batch. A bar fills orange while its prompt is read (prefill), then blue as the answer is generated one token per step. When the answer is complete the request leaves at once and a waiting one takes its slot in the next step, which is why bars disappear and pop up again [@yu2022]. The stripe on top is the session's colour.

## `grid` KV cache blocks
_Where:_ Tutorial card 8, pointing at the KV cache blocks of a pod.

### title
KV cache blocks

### text
The same GPU memory as a map: the dark block is the weights, the grid is the KV pool, cut into blocks of 16 tokens that need not be contiguous [@kwon2023]. Every token read leaves keys and values behind; a cell takes the colour of the session whose keys and values it holds (one cell stands for several blocks). When a turn finishes its cells turn pale: still cached for a follow-up, and first to be evicted when room is needed [@vllmPrefixCaching].

## `roofline` Forward pass and arithmetic intensity
_Where:_ Tutorial card 9, pointing at the roofline strip of a pod.

### title
Forward pass and arithmetic intensity

### text
The strip sweeps once per engine step, through every layer. The dot below shows arithmetic intensity: how many arithmetic operations (FLOPs) the step does per byte it reads from memory. A GPU can do only so many operations and read only so many bytes per second; the ridge, the number on the gauge, is where the two limits meet [@williams2009]. Left of it a step waits on memory (decode, blue); right of it on arithmetic (prefill, orange). A prefill joining the batch throws the dot right and slows every stream.

## `stream` Output tokens
_Where:_ Tutorial card 10, pointing at the output token stream.

### title
Output tokens

### text
The blue dots flowing from the pods back to the sessions are generated tokens, streamed as they are produced: one per sequence per engine step.

## `tiers` Where idle KV cache goes
_Where:_ Tutorial card 11, pointing at the memory tiers of a pod.

### title
Where idle KV cache goes

### text
When HBM is full, the least recently used idle session leaves: to host DRAM (green), then local SSD (violet), then a remote pool shared by all pods (yellow). A red outline marks blocks being evicted. If no tier has room the KV is dropped and rebuilt from the stored text when the user returns. Loading back is only used when it is faster than recomputing.

## `menus` Change anything while it runs
_Where:_ Tutorial card 12, pointing at the menus on the right.

### title
Change anything while it runs

### text
Model, GPU, engine, routing, autoscaling and memory tiers can all be changed mid-flight. On the left: step through seven serving architectures from static batching to today's stack, send 1 to 10,000 sessions at once, start a scenario, or set how sessions behave. Click any node in the graph to dive into its numbers.

## `step` Slow motion and step-through
_Where:_ Last tutorial card, pointing at the speed and step-through controls at the bottom.

### title
Slow motion and step-through

### text
Pick the speed here. Turn on step-through to follow a single session: the clock stops at each thing that happens to it, with a longer explanation, until you press Next. The tutorial button brings this tour back.
