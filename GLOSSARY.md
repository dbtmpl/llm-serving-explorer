# Glossary

- **BLIS (Blackbox Inference Simulator):** The discrete-event simulator (`github.com/inference-sim/inference-sim`) pinned in `engine/` that models the end-to-end llm-d + vLLM serving stack.
- **EPP (Endpoint Picker):** The `llm-d` router component embedded inside BLIS (`sim/llmd`) that performs admission control, flow control, and scored endpoint selection.
- **Scenario:** A YAML specification (`kind: Scenario` + `kind: Deployment`) defining the model, hardware, cluster topology, parallelism, engine configuration, and optional offload/router settings.
- **Event File (`.ndjson` / `.ndjson.gz`):** A deterministic newline-delimited JSON stream emitted by BLIS via `--events-output` (starting with a `header` record followed by time-ordered simulation events), conforming to `schema/events.schema.json`.
- **Replay Core:** The pure TypeScript state machine (`web/src/replay`) with `apply(state, event) -> state`, periodic snapshots, and `stateAt(t)` for deterministic scrubbing without re-simulating anything.
- **KV Block:** A fixed-size page of `block_size` tokens (default `16`) in GPU HBM or offload memory. In `blis-vllm`, a block is in one of three states: **used** (actively referenced, `RefCnt > 0`), **cached** (unpinned `RefCnt == 0`, still holding a prefix hash for reuse until LRU eviction), or **free** (unassigned).
- **Prefix Caching:** Reusing previously computed KV blocks across requests that share an identical leading token block chain. Shared active blocks have `RefCnt > 1`.
- **Eviction:** Removing a cached, unpinned KV block's hash from the prefix cache (either dropping it or offloading it to a lower memory tier) to make room for a new allocation.
- **Preemption:** Evicting a running request back to the waiting queue and freeing its KV blocks when the engine runs out of free blocks mid-generation.
- **Chunked Prefill:** Splitting a long prompt prefill across multiple engine steps (`max_num_batched_tokens`) so shorter decode/prefill requests can share GPU batches.
- **Continuous Batching:** Iteration-level scheduling (`max_num_seqs > 1`) where requests can join or leave the running batch on every forward step rather than waiting for an entire batch to finish.
- **P/D Disaggregation (Prefill/Decode Split):** Separating prefill pods and decode pods into distinct pools, transferring computed KV cache blocks between them (`kv.transfer`).
- **Tensor Parallelism (TP):** Sharding a single pod's model weights and KV cache heads across `tp` GPUs within the pod.
- **Arithmetic Intensity (AI):** `FLOPs / BytesMoved` for a GPU step, plotted on the Roofline chart against the GPU's peak compute (`TFlopsPeak`) and HBM bandwidth (`BwPeakTBs`) limits.
- **TTFT (Time to First Token):** Time from request arrival at the gateway to emission of its first output token.
- **TPOT (Time Per Output Token) / ITL (Inter-Token Latency):** Mean time per generated token after the first token (`(E2E - TTFT) / (output_tokens - 1)`).
