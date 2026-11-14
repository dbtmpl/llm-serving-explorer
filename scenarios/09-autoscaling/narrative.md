# 09 · Pod Autoscaling & Lifecycle

## What Happens

Starting from **1 warm pod** (`instance_0`, `min_replicas: 1`) running **Llama 3.1 8B · A100 80GB** with `gpu_memory_utilization: 0.25` (tightened KV budget per ADR 0003), a two-stage workload drives a full scale-up and scale-down cycle over 25 seconds:

1. **Spike (`rate=20 req/s` for 3s, 1,000-token prompts, 48 output tokens):** KV cache pressure and queue utilization exceed `scale_up_threshold: 0.5` past the 1s stabilization window. The autoscaler spawns additional replicas (`pod.created`), which spend 0.5s loading weights (`pod.loading`) before joining the serving pool (`pod.ready`).
2. **Cool-down (`rate=1 req/s` for 12s):** Load drops below `scale_down_boundary: 0.4`. Once the 1s scale-down stabilization window passes, the autoscaler transitions idle replicas to `pod.draining` (stopping new routing while in-flight requests finish) and finally `pod.terminated`.

## What to Watch in the Visualization

- **Autoscaling & Lifecycle View:** Follow the timeline swimlanes across all five pod lifecycle events (`pod.created`, `pod.loading`, `pod.ready`, `pod.draining`, `pod.terminated`).
- **Cluster Topology & Metrics:** Watch active replica count scale up during the burst and step back down as requests drain, alongside aggregate KV utilization and queue depth.

## BLIS Configuration

- `llama-3.1-8b-instruct` on `a100-sxm`, `block_size: 16`, `gpu_memory_utilization: 0.25` (ADR 0003).
- `--num-instances 1 --policy-config policy.yaml --model-autoscaler-interval-us 1000000 --workload-spec workload.yaml --horizon 25000000`.
