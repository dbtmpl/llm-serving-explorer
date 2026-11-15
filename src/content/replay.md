# Calibrated mode

The explanatory text of the "Calibrated (BLIS replay)" mode: what the mode is, which scenarios it offers and what each shows, the badge that names the BLIS commit, the note on what a replay cannot show, and the notes in the inspector for a replay. Control labels stay in the code. Values in braces are filled in by the code from the replay file, so the text cannot disagree with the data.

## `mode.explore` Explore mode
_Where:_ Left menu, under the mode toggle, while Explore is selected.

### text
The TypeScript model in `src/sim/`: change any setting while requests are in flight and watch every block, step and routing decision.

## `mode.calibrated` Calibrated mode
_Where:_ Left menu, under the mode toggle, while Calibrated is selected.

### text
A recorded run of BLIS on a fixed scenario. The settings are the run's and cannot be changed; you can pause, change the speed and click any part to see what BLIS recorded.

## `badge` BLIS commit badge
_Where:_ A badge at the top of the graph and in the left menu for as long as a BLIS replay is shown.

### title
BLIS replay

### text
Every time, route and number in this picture was produced by [BLIS](https://github.com/inference-sim/inference-sim) at commit {commit}. It is a recording, not the TypeScript model.

## `shows` What a replay is evidence for
_Where:_ Left menu, drop-down "What this shows" under the badge.

### text
BLIS runs the [llm-d router][@llmdScheduling]'s own scoring code in front of a Go translation of the [vLLM][@vllmRepo] scheduler, so routing choices, queueing, load shedding, preemption counts and per-request latencies are the best evidence this site has for how those systems behave. It is still a simulator: its engine step times come from fitted coefficients and the scenarios are small and constructed. It is not a measurement of a live cluster.

## `omits` What a replay cannot show
_Where:_ Left menu, drop-down "What this does not show" under the badge.

### text
BLIS reports no events inside an engine step. A replay therefore draws no per-block KV map, no forward-pass sweep, no roofline dot and no memory tiers: a pod shows how full its KV pool is and how many requests run and wait. Output tokens are spaced evenly between the first and the last token BLIS reports. BLIS starts a request's clock when it reaches the router, so the short trip from the session to the router is drawn for the picture, just before that time.

## `pod.aggregate` Pod interior note
_Where:_ On each pod in the graph, where Explore draws the forward pass, the roofline and the memory tiers.

### line-1
Not in BLIS's output

### line-2
BLIS reports no step-level events, so there is no per-block map,

### line-3
forward-pass sweep or roofline here: only how full the KV

### line-4
pool is, and how many requests run and wait.

## `scenario.prefix-followups` Follow-up turns return to their pod
_Where:_ Left menu, under the scenario picker, while "Follow-up turns return to their pod" is selected.

### text
Eight conversations of four turns each reach four pods. The router scores every pod on its queue, its KV use and how much of the prompt the pod already holds in its prefix cache, and picks the highest total. A first turn has nothing cached anywhere; a follow-up repeats the conversation so far, which only the pod that answered the previous turn holds. {back} of the {followups} follow-ups went back to that pod, and BLIS served {hit}% of all prompt tokens from the prefix cache. Click the router to see the scores of a decision.

## `scenario.steady-chat-70b` Steady chat, Llama 3.1 70B
_Where:_ Left menu, under the scenario picker, while "Steady chat, Llama 3.1 70B" is selected.

### text
Two pods of four H200 GPUs each serve Llama 3.1 70B to fourteen conversations of three turns, one starting every 1.5 s. The load stays well below what the pods can take: queues are empty and the KV pools are nearly empty, so each request sees the latency of a lightly loaded system, a first token after about {ttft} ms (median) and a token about every {tpot} ms. It is the baseline to compare the other scenarios with.

## `scenario.overload-shedding` Overload: queueing, then shedding
_Where:_ Left menu, under the scenario picker, while "Overload: queueing, then shedding" is selected.

### text
Requests arrive at about seven a second, more than two pods that run at most {slots} sequences each can finish. Once the pods are full the router holds new requests and drops any that waits longer than {deadline} s. Of {total} requests BLIS held {held} at the router for a while and shed {shed}; the median first token of the others came after {ttft} ms. Watch the router's queue build up and requests being shed.

## `scenario.kv-pressure` KV pressure: preemption
_Where:_ Left menu, under the scenario picker, while "KV pressure: preemption" is selected.

### text
One pod with a deliberately small KV pool ({pool} tokens) receives four requests that each grow to {each} tokens. Three fit; the fourth outgrows the pool, so the engine preempts the newest request: it gives its blocks back, waits, and recomputes when memory is free. BLIS counted {preemptions} preemption but not when it happened; the pause drawn here is read from the pod's waiting-request series and is accurate to about {bin} s.

## `params.note` Read-only parameters
_Where:_ Right menu, under the list of the scenario's settings.

### text
These are the settings BLIS ran this scenario with. They are fixed because the run is recorded; switch to Explore to change settings and see the TypeScript model respond.

## `explore-only` Features that stay in Explore
_Where:_ Left menu, under the scenario description, in Calibrated mode.

### text
The step-through, the explain boxes and the guided tour narrate the TypeScript model, so they are available in Explore mode only.

## `legend` Legend note
_Where:_ Right menu, group "Legend", in Calibrated mode.

### text
Everything on the graph is BLIS's record of the run. The blue bar in a pod is the share of its KV pool BLIS reports as in use; a red outline marks a preemption.

## `loading` Loading a replay
_Where:_ Centre of the screen while a replay file is being fetched.

### text
Loading the BLIS replay…

## `failed` Replay could not be loaded
_Where:_ Centre of the screen when a replay file could not be fetched or is not a valid replay file.

### text
This replay could not be loaded: {reason}. Pick another scenario or switch back to Explore.

## `finished` Replay finished
_Where:_ Under the clock when the replay has reached its last event.

### text
Replay finished. Press reset to watch it again.

## `inspector.front` Gateway in a replay
_Where:_ Dive-in panel, when the gateway (prompt assembly) is selected in Calibrated mode.

### text
BLIS starts a request's clock when it reaches the router, so it records nothing about the prompt text or about tokenizing. The picture draws a request travelling here for about 0.3 s before its arrival time, and the token counts shown are BLIS's.

## `inspector.router` Router decisions in a replay
_Where:_ Dive-in panel, when the router is selected in Calibrated mode.

### text
The router asks each scoring plugin to rate every pod from 0 to 1, multiplies each rating by the plugin's weight and sends the request to the pod with the highest sum ([llm-d scheduling][@llmdScheduling]). The table is BLIS's own record of the decision for the latest request: one column per plugin, then the weighted total. A pod missing from the table was filtered out before scoring.

## `inspector.pod` Pods in a replay
_Where:_ Dive-in panel, when a pod is selected in Calibrated mode.

### text
BLIS reports each pod's KV pool use and its running and waiting requests once every {interval} s; the numbers above are those series, smoothed between bins. The requests listed are the ones BLIS shows running on this pod now. Per-block and per-step detail is not in BLIS's output.

## `inspector.session` Sessions in a replay
_Where:_ Dive-in panel, when a session is selected in Calibrated mode.

### text
The rounds of this conversation as BLIS ran them. A follow-up repeats the whole conversation so far, so the pod that served the previous round can answer most of its prompt from the prefix cache: the cached tokens column is BLIS's count.
