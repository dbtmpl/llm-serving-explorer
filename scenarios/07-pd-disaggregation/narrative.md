# 07 · Prefill / Decode Disaggregation (3P1D)

## What Happens

Using **Preset 2 from ADR 0003** (**Llama 3.1 70B FP8, TP=2** on **NVIDIA H100 80GB** GPUs connected by **400G InfiniBand**), we split the cluster into **3 dedicated Prefill pods** (`instance_0`, `instance_1`, `instance_2`) and **1 dedicated Decode pod** (`instance_3`), orchestrated by `disagg-profile-handler` (`always-disagg-pd-decider` in `router.yaml`):

1. **Dual-Pool Routing (`disaggregate: true`):** Every incoming 1,024-token prompt is routed to both a prefill pod (`prefill_pod`) and the decode pod (`decode_pod`).
2. **Prefill Execution:** One of the 3 prefill pods computes the 1,024-token prompt (`64` KV blocks at `block_size=16`) without interfering with ongoing token generation on the decode pod.
3. **NIXL KV Handoff (`kv.transfer`):** Once prefill completes, `instance_3` pulls the 64 KV blocks from the prefill pod over `ib-400g` (`kv.transfer` `started` → `completed`, ~2.07 ms per 64-block transfer).
4. **Decode Execution:** `instance_3` batches all active decode streams together and generates 64 output tokens per request.

## What to Watch in the Visualization

- **P/D Disaggregation View:** Follow each request across the 3 prefill pods → NIXL KV transfer arcs → 1 decode pod, with zero prefill/decode interference on `instance_3`.
- **Cluster Topology:** Observe separate `prefill` (`3× TP=2`) and `decode` (`1× TP=2`) pools and active inter-pod transfer counters.
- **Request Timeline:** Notice the `kv_transfer` span bridging the `prefill` and `decode` phases.

## BLIS Configuration

- Model & GPU preset (ADR 0003): `llama-3.1-70b-instruct` (FP8, `tp: 2`, `block_size: 16`) on `h100` over `ib-400g`.
- `--num-instances 4 --prefill-instances 3 --decode-instances 1 --num-requests 18 --rate 50 --prompt-tokens 1024 --output-tokens 64`, `pd_transfer: { connector: NixlConnector }`.
