# 02 · Continuous Batching vs Static Batching

## What Happens

Twelve identical requests (`256` prompt tokens, `128` output tokens) arrive over ~0.3 seconds (`rate=40 req/s`) at a single **Llama 3.1 8B · A100 80GB** pod:

- **Continuous Batching (`max_num_seqs=256`):** As new requests arrive while earlier requests are already decoding, vLLM's iteration-level scheduler admits them on the very next step (`phase: "mixed"`, combining prefill tokens of the new arrival with decode tokens of active requests) and batches up to 12 concurrent decodes per forward pass. Because decode is HBM-bandwidth bound on model weights, batching 12 decodes shares one weight read across 12 tokens, boosting output throughput nearly **10×**!
- **Static Serialized Baseline (`max_num_seqs=1`):** Each request waits in the queue until the previous request emits all 128 tokens, keeping batch size locked at 1 and leaving compute & HBM bandwidth underutilized.

## What to Watch in the Visualization

- **Batch & Roofline View:** Scrub through `batch.step` events to watch `members.length` grow from 1 to 12, spot `phase: "mixed"` steps where prefill and decode share one batch, and see arithmetic intensity rise on the roofline.
- **Compare Mode:** Toggle the `Static Serialized (max_num_seqs=1)` baseline to compare `output_tok_s` (~626 tok/s vs ~65 tok/s) and total makespan.
- **Request Timeline:** Notice overlapping decode bars under continuous batching versus a strict staircase under `max_num_seqs=1`.

## BLIS Configuration

- Uses `llama-3.1-8b-instruct` on `a100-sxm` (`block_size: 16`, ADR 0003).
- Primary `scenario.yaml` sets `max_num_seqs: 256`; `baseline.scenario.yaml` restricts `max_num_seqs: 1`.
