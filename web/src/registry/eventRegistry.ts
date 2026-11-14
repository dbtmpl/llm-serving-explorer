import type { SimEvent, SimEventType, UnknownEvent } from "@llm-viz/schema";

export type EventCategory = "request" | "batch" | "kv" | "pod" | "metrics" | "unknown";

export type SemanticTone =
  | "prefill"
  | "decode"
  | "cached"
  | "evicted"
  | "preempted"
  | "cpu_dram"
  | "transfer"
  | "draining"
  | "ready"
  | "neutral";

export interface EventPresentation<T extends SimEvent | UnknownEvent = SimEvent | UnknownEvent> {
  readonly type: string;
  readonly badge: string;
  readonly category: EventCategory;
  readonly color: SemanticTone | ((ev: T) => SemanticTone);
  readonly shortSummary: (ev: T) => string;
  readonly details: (ev: T) => Record<string, unknown>;
}

export function resolveEventTone<T extends SimEvent | UnknownEvent>(
  pres: EventPresentation<T>,
  ev: T
): SemanticTone {
  return typeof pres.color === "function" ? pres.color(ev) : pres.color;
}

type EventByType<K extends SimEventType> = Extract<SimEvent, { type: K }>;

function defineEvent<K extends SimEventType>(
  type: K,
  spec: Omit<EventPresentation<EventByType<K>>, "type">
): EventPresentation<EventByType<K>> {
  return { type, ...spec };
}

export const EVENT_REGISTRY: { [K in SimEventType]: EventPresentation<EventByType<K>> } = {
  "request.arrived": defineEvent("request.arrived", {
    badge: "ARRIVED",
    category: "request",
    color: "neutral",
    shortSummary: (ev) =>
      `${ev.req_id} arrived (${ev.prompt_tokens} prompt, max ${ev.max_output_tokens} out)`,
    details: (ev) => ({
      req_id: ev.req_id,
      prompt_tokens: ev.prompt_tokens,
      max_output_tokens: ev.max_output_tokens,
      prefix_group: ev.prefix_group,
      prefix_tokens: ev.prefix_tokens,
      slo_class: ev.slo_class,
      session_id: ev.session_id
    })
  }),
  "request.admitted": defineEvent("request.admitted", {
    badge: "ADMITTED",
    category: "request",
    color: "ready",
    shortSummary: (ev) => `${ev.req_id} admitted${ev.reason ? ` (${ev.reason})` : ""}`,
    details: (ev) => ({ req_id: ev.req_id, reason: ev.reason })
  }),
  "request.rejected": defineEvent("request.rejected", {
    badge: "REJECTED",
    category: "request",
    color: "preempted",
    shortSummary: (ev) => `${ev.req_id} rejected at ${ev.stage}: ${ev.reason}`,
    details: (ev) => ({ req_id: ev.req_id, stage: ev.stage, reason: ev.reason })
  }),
  "request.routed": defineEvent("request.routed", {
    badge: "ROUTED",
    category: "request",
    color: (ev) => (ev.disaggregate ? "transfer" : "decode"),
    shortSummary: (ev) =>
      ev.disaggregate
        ? `${ev.req_id} routed P=${ev.prefill_pod ?? ev.chosen_pod} -> D=${ev.decode_pod ?? "?"}`
        : `${ev.req_id} routed -> ${ev.chosen_pod}`,
    details: (ev) => ({
      req_id: ev.req_id,
      chosen_pod: ev.chosen_pod,
      prefill_pod: ev.prefill_pod,
      decode_pod: ev.decode_pod,
      disaggregate: ev.disaggregate,
      reason: ev.reason,
      regret: ev.regret,
      candidates: ev.candidates
    })
  }),
  "request.queued": defineEvent("request.queued", {
    badge: "QUEUED",
    category: "request",
    color: "neutral",
    shortSummary: (ev) => `${ev.req_id} queued on ${ev.pod_id} (depth ${ev.queue_depth})`,
    details: (ev) => ({ req_id: ev.req_id, pod_id: ev.pod_id, queue_depth: ev.queue_depth })
  }),
  "request.scheduled": defineEvent("request.scheduled", {
    badge: "SCHEDULED",
    category: "request",
    color: (ev) => (ev.cached_tokens > 0 ? "cached" : "prefill"),
    shortSummary: (ev) =>
      `${ev.req_id} scheduled on ${ev.pod_id} (cached ${ev.cached_tokens} tok${
        ev.cpu_hit_tokens ? `, cpu ${ev.cpu_hit_tokens}` : ""
      })`,
    details: (ev) => ({
      req_id: ev.req_id,
      pod_id: ev.pod_id,
      cached_tokens: ev.cached_tokens,
      cpu_hit_tokens: ev.cpu_hit_tokens,
      prefix_lookup: ev.prefix_lookup
    })
  }),
  "request.prefill": defineEvent("request.prefill", {
    badge: "PREFILL",
    category: "request",
    color: "prefill",
    shortSummary: (ev) =>
      `${ev.req_id} prefill ${ev.tokens_processed} tok (${ev.computed_after}/${ev.prompt_tokens}) on ${ev.pod_id}`,
    details: (ev) => ({
      req_id: ev.req_id,
      pod_id: ev.pod_id,
      batch_id: ev.batch_id,
      tokens_processed: ev.tokens_processed,
      computed_after: ev.computed_after,
      prompt_tokens: ev.prompt_tokens,
      duration_us: ev.duration_us
    })
  }),
  "request.decode_step": defineEvent("request.decode_step", {
    badge: "DECODE",
    category: "request",
    color: "decode",
    shortSummary: (ev) =>
      `${ev.req_id} decode tok #${ev.total_emitted}${ev.is_first_token ? " (TTFT)" : ""} on ${ev.pod_id}`,
    details: (ev) => ({
      req_id: ev.req_id,
      pod_id: ev.pod_id,
      batch_id: ev.batch_id,
      tokens_emitted: ev.tokens_emitted,
      total_emitted: ev.total_emitted,
      is_first_token: ev.is_first_token,
      duration_us: ev.duration_us
    })
  }),
  "request.preempted": defineEvent("request.preempted", {
    badge: "PREEMPT",
    category: "request",
    color: "preempted",
    shortSummary: (ev) =>
      `${ev.req_id} preempted on ${ev.pod_id} (freed ${ev.freed_blocks.length} blocks: ${ev.reason})`,
    details: (ev) => ({
      req_id: ev.req_id,
      pod_id: ev.pod_id,
      reason: ev.reason,
      computed_tokens_lost: ev.computed_tokens_lost,
      freed_blocks: ev.freed_blocks
    })
  }),
  "request.finished": defineEvent("request.finished", {
    badge: "FINISHED",
    category: "request",
    color: "ready",
    shortSummary: (ev) =>
      `${ev.req_id} finished (${ev.output_tokens} out, TTFT ${(ev.ttft_us / 1000).toFixed(2)}ms, E2E ${(ev.e2e_us / 1000).toFixed(2)}ms)`,
    details: (ev) => ({
      req_id: ev.req_id,
      pod_id: ev.pod_id,
      reason: ev.reason,
      output_tokens: ev.output_tokens,
      ttft_us: ev.ttft_us,
      e2e_us: ev.e2e_us,
      tpot_us: ev.tpot_us
    })
  }),
  "request.timed_out": defineEvent("request.timed_out", {
    badge: "TIMEOUT",
    category: "request",
    color: "preempted",
    shortSummary: (ev) =>
      `${ev.req_id} timed out (${ev.stage}, ${(ev.elapsed_us / 1000).toFixed(1)}ms)`,
    details: (ev) => ({
      req_id: ev.req_id,
      pod_id: ev.pod_id,
      stage: ev.stage,
      elapsed_us: ev.elapsed_us
    })
  }),
  "batch.step": defineEvent("batch.step", {
    badge: "BATCH",
    category: "batch",
    color: "prefill",
    shortSummary: (ev) =>
      `${ev.pod_id} batch #${ev.batch_id} [${ev.phase}] ${ev.members.length} reqs (${ev.total_tokens} tok, ${ev.duration_us}us)`,
    details: (ev) => ({
      pod_id: ev.pod_id,
      batch_id: ev.batch_id,
      phase: ev.phase,
      prefill_tokens: ev.prefill_tokens,
      decode_tokens: ev.decode_tokens,
      total_tokens: ev.total_tokens,
      duration_us: ev.duration_us,
      members: ev.members,
      roofline: ev.roofline
    })
  }),
  "kv.block.allocated": defineEvent("kv.block.allocated", {
    badge: "KV ALLOC",
    category: "kv",
    color: "decode",
    shortSummary: (ev) =>
      `${ev.pod_id} alloc ${ev.block_ids.length} ${ev.tier} blocks for ${ev.req_id}`,
    details: (ev) => ({
      pod_id: ev.pod_id,
      req_id: ev.req_id,
      tier: ev.tier,
      block_ids: ev.block_ids,
      gpu_indices: ev.gpu_indices,
      shared_with_reqs: ev.shared_with_reqs
    })
  }),
  "kv.block.cached": defineEvent("kv.block.cached", {
    badge: "KV CACHED",
    category: "kv",
    color: "cached",
    shortSummary: (ev) =>
      `${ev.pod_id} cached ${ev.block_ids.length} ${ev.tier} blocks${
        ev.prev_owner_req_id ? ` (from ${ev.prev_owner_req_id})` : ""
      }`,
    details: (ev) => ({
      pod_id: ev.pod_id,
      tier: ev.tier,
      block_ids: ev.block_ids,
      block_hashes: ev.block_hashes,
      prev_owner_req_id: ev.prev_owner_req_id
    })
  }),
  "kv.block.evicted": defineEvent("kv.block.evicted", {
    badge: "EVICTED",
    category: "kv",
    color: "evicted",
    shortSummary: (ev) =>
      `${ev.pod_id} evicted ${ev.block_ids.length} ${ev.tier} blocks -> ${ev.destination} (${ev.reason})`,
    details: (ev) => ({
      pod_id: ev.pod_id,
      tier: ev.tier,
      destination: ev.destination,
      reason: ev.reason,
      block_ids: ev.block_ids,
      triggered_by_req_id: ev.triggered_by_req_id
    })
  }),
  "kv.block.moved": defineEvent("kv.block.moved", {
    badge: "KV MOVE",
    category: "kv",
    color: "cpu_dram",
    shortSummary: (ev) =>
      `${ev.pod_id} ${ev.direction} ${ev.num_blocks} blocks (${ev.from_tier}->${ev.to_tier}, ${ev.status}) for ${ev.req_id}`,
    details: (ev) => ({
      pod_id: ev.pod_id,
      transfer_id: ev.transfer_id,
      req_id: ev.req_id,
      direction: ev.direction,
      from_tier: ev.from_tier,
      to_tier: ev.to_tier,
      num_blocks: ev.num_blocks,
      tokens: ev.tokens,
      duration_us: ev.duration_us,
      status: ev.status
    })
  }),
  "kv.transfer": defineEvent("kv.transfer", {
    badge: "KV XFER",
    category: "kv",
    color: "transfer",
    shortSummary: (ev) =>
      `${ev.req_id} KV xfer ${ev.from_pod} -> ${ev.to_pod} (${ev.pulled_kv_blocks}/${ev.num_kv_blocks} blk, ${ev.status})`,
    details: (ev) => ({
      transfer_id: ev.transfer_id,
      req_id: ev.req_id,
      from_pod: ev.from_pod,
      to_pod: ev.to_pod,
      num_kv_blocks: ev.num_kv_blocks,
      pulled_kv_blocks: ev.pulled_kv_blocks,
      duration_us: ev.duration_us,
      status: ev.status
    })
  }),
  "pod.created": defineEvent("pod.created", {
    badge: "POD CREATE",
    category: "pod",
    color: "ready",
    shortSummary: (ev) =>
      `${ev.pod_id} created (${ev.pool_role}, TP=${ev.tp_degree}, ${ev.gpu_ids.length} GPUs)`,
    details: (ev) => ({
      pod_id: ev.pod_id,
      pool_role: ev.pool_role,
      tp_degree: ev.tp_degree,
      gpu_ids: ev.gpu_ids,
      node_id: ev.node_id
    })
  }),
  "pod.loading": defineEvent("pod.loading", {
    badge: "POD LOAD",
    category: "pod",
    color: "prefill",
    shortSummary: (ev) => `${ev.pod_id} (${ev.pool_role}) loading weights`,
    details: (ev) => ({ pod_id: ev.pod_id, pool_role: ev.pool_role })
  }),
  "pod.ready": defineEvent("pod.ready", {
    badge: "POD READY",
    category: "pod",
    color: "ready",
    shortSummary: (ev) => `${ev.pod_id} (${ev.pool_role}) ready`,
    details: (ev) => ({ pod_id: ev.pod_id, pool_role: ev.pool_role })
  }),
  "pod.draining": defineEvent("pod.draining", {
    badge: "DRAINING",
    category: "pod",
    color: "draining",
    shortSummary: (ev) => `${ev.pod_id} draining${ev.reason ? ` (${ev.reason})` : ""}`,
    details: (ev) => ({ pod_id: ev.pod_id, pool_role: ev.pool_role, reason: ev.reason })
  }),
  "pod.terminated": defineEvent("pod.terminated", {
    badge: "TERMINATED",
    category: "pod",
    color: "neutral",
    shortSummary: (ev) => `${ev.pod_id} (${ev.pool_role}) terminated`,
    details: (ev) => ({ pod_id: ev.pod_id, pool_role: ev.pool_role })
  }),
  "metrics.snapshot": defineEvent("metrics.snapshot", {
    badge: "METRICS",
    category: "metrics",
    color: "neutral",
    shortSummary: (ev) =>
      `snapshot: completed=${ev.completed_requests}, ttft=${ev.ttft_mean_ms.toFixed(1)}ms, tpot=${ev.tpot_mean_ms.toFixed(2)}ms, out=${ev.output_tok_s.toFixed(1)} tok/s`,
    details: (ev) => ({
      is_final: ev.is_final,
      gateway_queue_depth: ev.gateway_queue_depth,
      completed_requests: ev.completed_requests,
      preemptions: ev.preemptions,
      ttft_mean_ms: ev.ttft_mean_ms,
      tpot_mean_ms: ev.tpot_mean_ms,
      output_tok_s: ev.output_tok_s,
      prefix_cache_hit_rate: ev.prefix_cache_hit_rate,
      instances: ev.instances
    })
  })
};

export const REGISTERED_EVENT_TYPES = Object.keys(EVENT_REGISTRY) as SimEventType[];

const FALLBACK_PRESENTATION: EventPresentation<SimEvent | UnknownEvent> = {
  type: "unknown",
  badge: "UNKNOWN",
  category: "unknown",
  color: "neutral",
  shortSummary: (ev) => `Unknown event: ${String(ev.type)}`,
  details: (ev) => ({ ...(ev as unknown as Record<string, unknown>) })
};

export function getEventPresentation(
  event: SimEvent | UnknownEvent
): EventPresentation<SimEvent | UnknownEvent> {
  const entry = (EVENT_REGISTRY as Record<string, EventPresentation | undefined>)[event.type];
  if (!entry) {
    return {
      ...FALLBACK_PRESENTATION,
      type: String(event.type)
    };
  }
  return entry as EventPresentation<SimEvent | UnknownEvent>;
}
