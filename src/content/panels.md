# Panels and menus

The explanatory text of the screen outside the graph: the empty-state card, the hints under each scenario, the notes in the menus on the left and right, and the legend note. Control labels (slider names, button captions, table headers) are not here; they stay in the code. Values in braces are filled in by the code.

## `empty` Empty-state card
_Where:_ The card in the middle of the screen before anything has been sent (not shown while the tutorial is open).

### title
How an LLM serves a request

### text
The stack starts empty. Send a request and watch it build: text, tokens, a route, a pod, weights, KV cache, a stream of output tokens.

### hint
The trace stops the clock at each stage and explains it until you press Next.

## `scenario.evict` Idle sessions, eviction
_Where:_ Left menu, Requests panel, group "Scenarios", under the buttons once the "Idle sessions → eviction" scenario is selected.

### text
40 sessions with 10k-token prompts on one pod. Finished sessions stay cached until HBM fills, then move to DRAM, to SSD, and out. gpu_memory_utilization is lowered to 0.5 so the pool fills sooner.

## `scenario.preempt` Outputs outgrow the pool, preemption
_Where:_ Left menu, group "Scenarios", under the buttons once the "Outputs outgrow the pool → preemption" scenario is selected.

### text
12 prompts fit in a small KV pool (gpu_memory_utilization 0.28), but their long outputs keep growing. With nothing idle to evict, the newest sequence gives its blocks back and recomputes; it waits until its whole context fits again.

## `scenario.70b` 70B on 4 x H100
_Where:_ Left menu, group "Scenarios", under the buttons once the "70B on 4 × H100" scenario is selected.

### text
Tensor parallelism is bought for memory: four GPUs each hold a quarter of the weights and a slice of every KV block.

## `scenario.churn` Conversations with churn
_Where:_ Left menu, group "Scenarios", under the buttons once the "Conversations with churn" scenario is selected.

### text
100 sessions that keep replying, plus two new sessions every second while others go idle. Follow-up turns are short prefills on cached history; new sessions are long ones. Watch the two kinds of work share each step.

## `sessions.note` Session behaviour summary
_Where:_ Left menu, group "Session behaviour", under the sliders; it restates the current slider values in words.

### text
After each answer {returnPct}% of sessions reply again about {thinkTime} s later; the other {leavePct}% go idle and leave their KV cache behind. Lengths vary ±40% around the mean. Times are simulated seconds.

## `model.note` Model and GPU note
_Where:_ Right menu, group "Model and GPU", under the controls.

### text
These size the weights and the KV pool at start-up, so changing one restarts every pod. [vLLM][@vllmEngineArgs]'s gpu_memory_utilization was 0.9 by default for years; current releases default to 1.0 on CUDA and measure what is free.

## `spec.note` Speculative decoding estimate
_Where:_ Right menu, group "Engine", under the speculative-decoding sliders; shown only while speculative decoding is on.

### text
Expected {tokensPerStep} tokens per step and a {speedup}× speed-up ([Leviathan et al. 2023][@leviathan2023], eq. 1 and theorem 3.8). The paper measured α 0.53 to 0.89 and c 0.02 to 0.11, at batch 1.

## `scaling.note` Cold start note
_Where:_ Right menu, group "Routing and autoscaling", under the sliders.

### text
Real cold starts take tens of seconds to minutes; the default is short so the animation keeps moving.

## `tiers.measured` Measured copy rates
_Where:_ Right menu, group "Memory tiers", under the sliders.

### text
Measured: host memory to GPU 11 to 49 GB/s depending on copy size (64 is the PCIe 5 ceiling); SSD 1.6 to 12 GB/s; [LMCache][@lmcache2025] studies 32 to 128 Gbps networks.

## `tiers.flow` How idle sessions move down the tiers
_Where:_ Right menu, group "Memory tiers", under the measured rates.

### text
Idle sessions fall HBM → DRAM → SSD → remote pool, whole sessions at a time, least recently used first. Below that only the text in the conversation store remains.

## `legend.note` Legend note
_Where:_ Right menu, group "Legend", under the colour key.

### text
Each session has its own hue. Click any node to dive in; drag to pan, scroll to zoom.

## `step.header` Where the visitor is in a step-through
_Where:_ The small line at the top of the step-through box: which step is showing, which session is followed and the simulated time of that step.

### text-session
Step {n} of {total} · session {sid} · {time} s

### text-fleet
Step {n} of {total} · fleet · {time} s

### no-rewind
The graph could not be rewound this far, so it shows where the simulation is now.

## `gpu.weights` Weights segment of the GPU memory box
_Where:_ Hover tooltip over the dark block at the left of a GPU's memory box in a pod; the size is per GPU.

### title
Weights

### text
The model's learned numbers, copied into GPU memory at start-up. They are read in full for every step, so they set how fast a token can be made.

## `gpu.work` Activations, CUDA graphs and runtime segment
_Where:_ Hover tooltip over the thin strip after the weights in a GPU's memory box; the size is per GPU.

### title
Activations, CUDA graphs and runtime

### text
Working space of the start-up profiling pass, the captured CUDA graphs that launch a step cheaply, and about 0.7 GB the process holds outside PyTorch (the CUDA context and library workspaces, a figure fitted to two measured vLLM runs). The pass is one step of `max_num_batched_tokens` tokens (the intermediate results between layers) and the sampler's rows over the whole vocabulary, so a larger token budget or `max_num_seqs` makes this strip wider and the KV pool smaller; the graphs are one per batch size on the capture list. It is reserved once, before the KV pool is sized.

## `gpu.kv` KV pool segment
_Where:_ Hover tooltip over the grid of cells in a GPU's memory box; the size is per GPU.

### title
KV pool

### text
What remains of the memory the engine may use: blocks of 16 tokens that hold the keys and values of every token read so far. It caps how many requests fit at once.

## `gpu.headroom` Headroom segment
_Where:_ Hover tooltip over the hatched block at the right of a GPU's memory box; the size is per GPU.

### title
Headroom

### text
The part of the GPU's memory above `gpu_memory_utilization`, which the engine leaves unused as a safety margin.

## `fit.blocked` A configuration that cannot serve
_Where:_ The box at the top of the graph while the chosen model, precision, GPU, tensor parallelism and memory utilisation leave no room for a KV cache, so no pod can start. It stays until a configuration fits; the buttons under it apply a change that makes it fit.

### title
This configuration cannot serve requests

### body
{model} in {precision} needs {need} of each GPU for weights, working space and CUDA graphs, but the engine may use only {usable} of a {gpu} (gpu_memory_utilization {util}). No pod can start, so requests wait at the router. Pick a way out, or change the settings yourself.

## `fit.tight` A KV pool that holds only a few requests
_Where:_ The box at the top of the graph while the configuration fits but one pod's KV pool holds fewer than four requests of the current length; the buttons under it are changes that leave more room.

### title
The KV pool is very small

### body
One pod's pool holds only about {tokens} tokens of KV, roughly {requests} requests of the current length. Requests queue at the pod and running ones may be preempted and recomputed, so expect it to be slow and uneven. Pick more room, or change the settings yourself.

## `fit.fix` The buttons that make a configuration fit
_Where:_ Buttons in the box at the top of the graph (see the two entries above); each applies one change of settings and restarts the fleet. The `pool` line is the small print on each button.

### util
Raise gpu_memory_utilization to {value}

### precision
Use FP8 weights

### tp
Use {value} GPUs per pod (tensor parallel {value})

### gpu
Switch to {value}

### model
Use {value}

### pool
KV pool of about {tokens} tokens per pod

## `fit.option` Menu options that would not fit
_Where:_ Right menu, group "Model and GPU": the `title` is the hover text of an option that would not fit with the other settings as they are now, and the `note` appears under the controls while any option is marked.

### title
Does not fit with the other settings as they are: no room is left for a KV cache, so no pod could start.

### note
Dimmed options do not fit with the other settings as they are. You can still pick one; the graph then shows why nothing starts and offers a way out.

## `fit.gateway` The router's reason for holding requests
_Where:_ On the router node, under its queue count, while requests wait and the configuration cannot serve.

### text
waiting: the model does not fit
