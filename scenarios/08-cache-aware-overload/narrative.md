# 08 · Cache-Affinity Overload & Queue Skew

## What Happens

Under a `120 req/s` burst of 60 requests where 85% share a single hot 1,024-token prefix (`hot-system-prompt`), **cache-affinity routing can overload the warm pod**:

- **Affinity-Heavy Router (`prefix-cache-scorer` weight 10 vs `queue-scorer` weight 1):** Because prefix hits score up to `+10` while queue penalty is weighted only `1`, the router repeatedly piles hot-prefix requests onto `instance_2` and `instance_3` (20–29 in-flight requests, queue depths climbing up to 8) while `instance_0` and `instance_1` handle only ~4 requests each.
- **In-Flight Balanced Baseline (`inflight-load-producer` + `active-request-scorer` weight 2):** Accounts for in-flight requests immediately at routing time, preventing stampeding herds and keeping queue depth and tail TTFT lower.

## What to Watch in the Visualization

- **Routing & Gateway View:** Inspect `request.routed` candidates during the burst—see `instance_3` carrying `in_flight_requests: 29, queue_depth: 3` while `instance_0` has `4` in-flight and `0` queued, yet `instance_2/3` still win on score (`9.98` vs `1.99`).
- **Scheduler & Queue:** Watch queue depth spike unevenly on the hot pods.
- **Compare Mode:** Toggle the `In-Flight Load Balanced` baseline to see how balancing active load trades a small drop in cache hits for far more uniform pod utilization and lower queueing delay.

## BLIS Configuration

- `llama-3.1-8b-instruct` on `a100-sxm` (`block_size: 16`, ADR 0003), `--num-instances 4`, `workload.yaml` (`aggregate_rate: 120`, `85%` shared `1024`-token prefix).
