import { describe, expect, it } from "vitest";
import eventsSchema from "../events.schema.json" with { type: "json" };
import {
  parseAndValidateNDJSON,
  validateRecord,
  type BLISEventStreamRecordV1,
  type HeaderRecord,
  type SimEvent
} from "../src/index.js";

function makeHeader(): HeaderRecord {
  return {
    type: "header",
    schema_version: "1.0",
    blis: {
      commit: "abcdef123456",
      vllm_version: "0.7.3",
      llmd_version: "0.2.0",
      stack_versions: {
        cuda: "12.4",
        pytorch: "2.5.1"
      }
    },
    scenario: {
      name: "pd-disagg-smoke",
      model: "meta-llama/Llama-3.1-8B-Instruct",
      hardware: "H100-SXM-80GB",
      flags: {
        chunked_prefill: true,
        prefix_caching: true
      },
      seed: 42,
      horizon_us: 10_000_000,
      routing_policy: "kv-cache-aware"
    },
    topology: {
      gateway_latency_us: 250,
      pools: [
        {
          role: "prefill",
          replicas: 1,
          tp: 2,
          pp: 1,
          dp: 1,
          gpus_per_pod: 2,
          gpu_type: "H100-SXM-80GB",
          gpu_specs: {
            memory_gib: 80,
            tflops_peak: 989,
            tflops_fp8: 1979,
            bw_peak_tbs: 3.35,
            sm_count: 132
          },
          memory_breakdown_bytes: {
            weights: 8_000_000_000,
            activation_peak: 1_500_000_000,
            cuda_graph: 512_000_000,
            comm_buffers: 256_000_000
          },
          kv_blocks_per_gpu: 4096,
          kv_block_size_tokens: 16,
          max_num_seqs: 256,
          max_num_batched_tokens: 8192,
          max_model_len: 32768
        },
        {
          role: "decode",
          replicas: 1,
          tp: 2,
          pp: 1,
          dp: 1,
          gpus_per_pod: 2,
          gpu_type: "H100-SXM-80GB",
          gpu_specs: {
            memory_gib: 80,
            tflops_peak: 989,
            tflops_fp8: 1979,
            bw_peak_tbs: 3.35,
            sm_count: 132
          },
          memory_breakdown_bytes: {
            weights: 8_000_000_000,
            activation_peak: 1_000_000_000,
            cuda_graph: 512_000_000,
            comm_buffers: 256_000_000
          },
          kv_blocks_per_gpu: 4096,
          kv_block_size_tokens: 16,
          max_num_seqs: 256,
          max_num_batched_tokens: 2048,
          max_model_len: 32768
        }
      ],
      tiers: {
        gpu_hbm_blocks: 16384,
        cpu_ram_blocks: 32768,
        cpu_ram_bytes: 68_719_476_736,
        local_ssd_modelled: false,
        remote_store_modelled: false,
        unmodelled_notes: {
          network: "Idealized RDMA bandwidth"
        }
      },
      initial_pods: [
        {
          pod_id: "prefill-0",
          pool_role: "prefill",
          gpu_ids: ["gpu-0", "gpu-1"],
          tp_degree: 2,
          state: "ready"
        },
        {
          pod_id: "decode-0",
          pool_role: "decode",
          gpu_ids: ["gpu-2", "gpu-3"],
          tp_degree: 2,
          state: "ready"
        }
      ]
    }
  };
}

function makeAllEvents(): SimEvent[] {
  return [
    {
      seq: 1,
      t_us: 100,
      type: "pod.created",
      pod_id: "decode-1",
      pool_role: "decode",
      gpu_ids: ["gpu-4", "gpu-5"],
      tp_degree: 2,
      node_id: "node-1"
    },
    {
      seq: 2,
      t_us: 200,
      type: "pod.loading",
      pod_id: "decode-1",
      pool_role: "decode"
    },
    {
      seq: 3,
      t_us: 500,
      type: "pod.ready",
      pod_id: "decode-1",
      pool_role: "decode"
    },
    {
      seq: 4,
      t_us: 1000,
      type: "request.arrived",
      req_id: "req-1",
      prompt_tokens: 64,
      max_output_tokens: 32,
      prefix_group: "sys-prompt-a",
      prefix_tokens: 32,
      block_hashes: ["h0", "h1", "h2", "h3"],
      slo_class: "interactive",
      session_id: "sess-1"
    },
    {
      seq: 5,
      t_us: 1000,
      type: "request.admitted",
      req_id: "req-1",
      reason: "within_concurrency_limit"
    },
    {
      seq: 6,
      t_us: 1050,
      type: "request.arrived",
      req_id: "req-rejected",
      prompt_tokens: 128000,
      max_output_tokens: 1024
    },
    {
      seq: 7,
      t_us: 1050,
      type: "request.rejected",
      req_id: "req-rejected",
      reason: "exceeds_max_model_len",
      stage: "admission"
    },
    {
      seq: 8,
      t_us: 1250,
      type: "request.routed",
      req_id: "req-1",
      chosen_pod: "prefill-0",
      prefill_pod: "prefill-0",
      decode_pod: "decode-0",
      disaggregate: true,
      reason: "highest_prefix_cache_affinity",
      scores: {
        "prefill-0": 0.92,
        "decode-0": 0.85
      },
      candidates: [
        {
          pod_id: "prefill-0",
          score: 0.92,
          scorer_breakdown: { prefix: 0.7, load: 0.22 },
          queue_depth: 0,
          batch_size: 1,
          in_flight_requests: 1,
          kv_utilization: 0.12,
          free_kv_blocks: 3600
        }
      ],
      regret: 0.0
    },
    {
      seq: 9,
      t_us: 1300,
      type: "request.queued",
      req_id: "req-1",
      pod_id: "prefill-0",
      queue_depth: 1
    },
    {
      seq: 10,
      t_us: 1400,
      type: "request.scheduled",
      req_id: "req-1",
      pod_id: "prefill-0",
      cached_tokens: 32,
      cpu_hit_tokens: 16,
      prefix_lookup: true
    },
    {
      seq: 11,
      t_us: 1410,
      type: "kv.block.allocated",
      pod_id: "prefill-0",
      gpu_indices: [0, 1],
      block_ids: [10, 11],
      req_id: "req-1",
      block_hashes: ["h2", "h3"],
      tier: "gpu",
      shared_with_reqs: []
    },
    {
      seq: 12,
      t_us: 1420,
      type: "kv.block.moved",
      pod_id: "prefill-0",
      transfer_id: 1,
      req_id: "req-1",
      from_tier: "cpu_dram",
      to_tier: "gpu",
      direction: "load",
      block_ids: [9],
      num_blocks: 1,
      tokens: 16,
      duration_us: 80,
      status: "completed"
    },
    {
      seq: 13,
      t_us: 1800,
      type: "request.prefill",
      req_id: "req-1",
      pod_id: "prefill-0",
      batch_id: 1,
      tokens_processed: 32,
      computed_after: 64,
      prompt_tokens: 64,
      duration_us: 380
    },
    {
      seq: 14,
      t_us: 1800,
      type: "batch.step",
      pod_id: "prefill-0",
      batch_id: 1,
      phase: "prefill",
      members: [
        {
          req_id: "req-1",
          role: "prefill",
          tokens: 32,
          computed_before: 32
        }
      ],
      prefill_tokens: 32,
      decode_tokens: 0,
      total_tokens: 32,
      duration_us: 380,
      roofline: {
        flops: 5.12e11,
        bytes_moved: 1.6e10,
        arithmetic_intensity: 32.0,
        achieved_tflops: 420.5,
        achieved_bw_tbs: 2.1,
        bottleneck: "memory_bandwidth",
        per_resource_us: {
          compute: 210,
          hbm: 380
        },
        derived: false
      }
    },
    {
      seq: 15,
      t_us: 2000,
      type: "kv.transfer",
      transfer_id: 2,
      req_id: "req-1",
      from_pod: "prefill-0",
      to_pod: "decode-0",
      num_kv_blocks: 4,
      pulled_kv_blocks: 4,
      duration_us: 190,
      status: "completed"
    },
    {
      seq: 16,
      t_us: 2200,
      type: "request.decode_step",
      req_id: "req-1",
      pod_id: "decode-0",
      batch_id: 2,
      tokens_emitted: 1,
      total_emitted: 1,
      is_first_token: true,
      duration_us: 180
    },
    {
      seq: 17,
      t_us: 2400,
      type: "request.preempted",
      req_id: "req-1",
      pod_id: "decode-0",
      reason: "kv_cache_pressure",
      computed_tokens_lost: 1,
      freed_blocks: [10, 11]
    },
    {
      seq: 18,
      t_us: 2450,
      type: "kv.block.cached",
      pod_id: "prefill-0",
      gpu_indices: [0, 1],
      block_ids: [10, 11],
      block_hashes: ["h2", "h3"],
      prev_owner_req_id: "req-1",
      tier: "gpu"
    },
    {
      seq: 19,
      t_us: 2500,
      type: "kv.block.evicted",
      pod_id: "prefill-0",
      gpu_indices: [0, 1],
      block_ids: [10],
      block_hashes: ["h2"],
      tier: "gpu",
      destination: "cpu_dram",
      reason: "lru_eviction",
      triggered_by_req_id: "req-2"
    },
    {
      seq: 20,
      t_us: 3000,
      type: "request.finished",
      req_id: "req-1",
      pod_id: "decode-0",
      reason: "stop",
      output_tokens: 16,
      ttft_us: 1200,
      e2e_us: 2000,
      tpot_us: 53.3
    },
    {
      seq: 21,
      t_us: 3500,
      type: "request.timed_out",
      req_id: "req-2",
      pod_id: "decode-0",
      stage: "engine",
      elapsed_us: 2500
    },
    {
      seq: 22,
      t_us: 4000,
      type: "pod.draining",
      pod_id: "decode-1",
      pool_role: "decode",
      reason: "scale_down"
    },
    {
      seq: 23,
      t_us: 4500,
      type: "pod.terminated",
      pod_id: "decode-1",
      pool_role: "decode"
    },
    {
      seq: 24,
      t_us: 5000,
      type: "metrics.snapshot",
      is_final: true,
      gateway_queue_depth: 0,
      completed_requests: 1,
      preemptions: 1,
      rejected_requests: 1,
      timed_out_requests: 1,
      dropped_requests: 0,
      ttft_mean_ms: 1.2,
      tpot_mean_ms: 0.0533,
      output_tok_s: 320.0,
      prefix_cache_hit_rate: 0.5,
      instances: [
        {
          pod_id: "prefill-0",
          state: "active",
          queue_depth: 0,
          batch_size: 0,
          kv_used_blocks: 2,
          kv_cached_blocks: 2,
          kv_free_blocks: 4092,
          kv_total_blocks: 4096,
          cpu_used_blocks: 1,
          cpu_total_blocks: 32768,
          preemptions: 0,
          completed_requests: 0
        },
        {
          pod_id: "decode-0",
          state: "ready",
          queue_depth: 0,
          batch_size: 0,
          kv_used_blocks: 0,
          kv_cached_blocks: 0,
          kv_free_blocks: 4096,
          kv_total_blocks: 4096,
          preemptions: 1,
          completed_requests: 1
        }
      ]
    }
  ];
}

function toNDJSON(records: BLISEventStreamRecordV1[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

describe("@llm-viz/schema", () => {
  it("validates a complete realistic NDJSON stream containing a header and every schema event type", () => {
    const header = makeHeader();
    const events = makeAllEvents();
    const allRecords: BLISEventStreamRecordV1[] = [header, ...events];

    // Confirm every record passes validateRecord individually.
    for (const record of allRecords) {
      const res = validateRecord(record);
      expect(res.errors, `Record type ${record.type} failed`).toEqual([]);
      expect(res.valid).toBe(true);
    }

    // Confirm our test stream covers every event type defined in events.schema.json.
    const schemaEventTypes = eventsSchema.oneOf
      .map((refObj) => {
        const defName = refObj.$ref.replace("#/$defs/", "");
        const def = eventsSchema.$defs[defName as keyof typeof eventsSchema.$defs] as {
          properties: { type: { const: string } };
        };
        return def.properties.type.const;
      })
      .filter((t) => t !== "header");

    expect(schemaEventTypes.length).toBe(23);
    const coveredTypes = new Set(events.map((e) => e.type));
    for (const eventType of schemaEventTypes) {
      expect(coveredTypes.has(eventType as SimEvent["type"]), `Missing type ${eventType}`).toBe(true);
    }

    const ndjson = toNDJSON(allRecords);
    const result = parseAndValidateNDJSON(ndjson);

    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.header).toEqual(header);
    expect(result.events).toHaveLength(events.length);
    expect(result.events).toEqual(events);
  });

  it("handles CRLF line endings and blank lines in valid NDJSON", () => {
    const header = makeHeader();
    const events = makeAllEvents().slice(0, 3);
    const ndjson = `\r\n${JSON.stringify(header)}\r\n\r\n${events.map((e) => JSON.stringify(e)).join("\r\n")}\r\n`;

    const result = parseAndValidateNDJSON(ndjson);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.header).toEqual(header);
    expect(result.events).toEqual(events);
  });

  it("rejects empty or whitespace-only input", () => {
    for (const input of ["", "   ", "\n\r\n  \t  \n"]) {
      const result = parseAndValidateNDJSON(input);
      expect(result.valid).toBe(false);
      expect(result.header).toBeUndefined();
      expect(result.events).toEqual([]);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].line).toBe(1);
    }
  });

  it("rejects invalid JSON lines", () => {
    const header = makeHeader();
    const ndjson = `${JSON.stringify(header)}\n{not valid json\n`;

    const result = parseAndValidateNDJSON(ndjson);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].line).toBe(2);
    expect(result.issues[0].message).toContain("Invalid JSON");

    const line1Bad = parseAndValidateNDJSON("{bad");
    expect(line1Bad.valid).toBe(false);
    expect(line1Bad.issues[0].line).toBe(1);
    expect(line1Bad.issues[0].message).toContain("Invalid JSON");
  });

  it("rejects missing header on line 1", () => {
    const firstEvent = makeAllEvents()[0];
    const ndjson = JSON.stringify(firstEvent);

    const result = parseAndValidateNDJSON(ndjson);
    expect(result.valid).toBe(false);
    expect(result.header).toBeUndefined();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].line).toBe(1);
    expect(result.issues[0].message).toContain("Line 1 must be 'header'");
  });

  it("rejects duplicate header after line 1", () => {
    const header = makeHeader();
    const firstEvent = makeAllEvents()[0];
    const ndjson = [
      JSON.stringify(header),
      JSON.stringify(firstEvent),
      JSON.stringify(header)
    ].join("\n");

    const result = parseAndValidateNDJSON(ndjson);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].line).toBe(3);
    expect(result.issues[0].message).toContain("Duplicate 'header'");
  });

  it("rejects unknown event type in validateRecord and parseAndValidateNDJSON", () => {
    const unknownRecord = {
      seq: 1,
      t_us: 100,
      type: "request.unknown_phase",
      req_id: "req-1"
    };

    const recResult = validateRecord(unknownRecord);
    expect(recResult.valid).toBe(false);
    expect(recResult.errors.length).toBeGreaterThan(0);

    const ndjson = `${JSON.stringify(makeHeader())}\n${JSON.stringify(unknownRecord)}`;
    const streamResult = parseAndValidateNDJSON(ndjson);
    expect(streamResult.valid).toBe(false);
    expect(streamResult.issues).toHaveLength(1);
    expect(streamResult.issues[0].line).toBe(2);
    expect(streamResult.issues[0].message).toContain("Schema error");
  });

  it("rejects missing required payload fields and schema constraint violations", () => {
    const invalidRecords: unknown[] = [
      // Header missing required topology
      (() => {
        const { topology: _omit, ...rest } = makeHeader();
        return rest;
      })(),
      // request.arrived missing prompt_tokens
      {
        seq: 1,
        t_us: 10,
        type: "request.arrived",
        req_id: "req-1",
        max_output_tokens: 16
      },
      // batch.step missing roofline
      {
        seq: 2,
        t_us: 20,
        type: "batch.step",
        pod_id: "prefill-0",
        batch_id: 1,
        phase: "prefill",
        members: [],
        prefill_tokens: 16,
        decode_tokens: 0,
        total_tokens: 16,
        duration_us: 100
      },
      // kv.block.allocated with empty block_ids (violates minItems: 1)
      {
        seq: 3,
        t_us: 30,
        type: "kv.block.allocated",
        pod_id: "prefill-0",
        gpu_indices: [0],
        block_ids: [],
        req_id: "req-1",
        tier: "gpu"
      },
      // metrics.snapshot missing instances
      {
        seq: 4,
        t_us: 40,
        type: "metrics.snapshot",
        is_final: false,
        gateway_queue_depth: 0,
        completed_requests: 0,
        preemptions: 0,
        rejected_requests: 0,
        timed_out_requests: 0,
        dropped_requests: 0,
        ttft_mean_ms: 0,
        tpot_mean_ms: 0,
        output_tok_s: 0,
        prefix_cache_hit_rate: 0
      },
      // request.admitted with unexpected extra property (additionalProperties: false)
      {
        seq: 5,
        t_us: 50,
        type: "request.admitted",
        req_id: "req-1",
        unexpected_field: 123
      }
    ];

    for (const badRecord of invalidRecords) {
      const res = validateRecord(badRecord);
      expect(res.valid).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);

      // Verify stream-level rejection for invalid event records (non-header).
      if ((badRecord as { type?: string }).type !== "header") {
        const streamRes = parseAndValidateNDJSON(
          `${JSON.stringify(makeHeader())}\n${JSON.stringify(badRecord)}`
        );
        expect(streamRes.valid).toBe(false);
        expect(streamRes.issues).toHaveLength(1);
        expect(streamRes.issues[0].line).toBe(2);
        expect(streamRes.issues[0].message).toContain("Schema error");
      }
    }

    // Also verify invalid header in NDJSON stream is rejected on line 1.
    const badHeaderStream = parseAndValidateNDJSON(JSON.stringify(invalidRecords[0]));
    expect(badHeaderStream.valid).toBe(false);
    expect(badHeaderStream.issues).toHaveLength(1);
    expect(badHeaderStream.issues[0].line).toBe(1);
    expect(badHeaderStream.issues[0].message).toContain("Schema error");
  });

  it("rejects non-monotonic seq (equal or decreasing)", () => {
    const header = makeHeader();
    const ev1: SimEvent = {
      seq: 5,
      t_us: 100,
      type: "request.arrived",
      req_id: "req-1",
      prompt_tokens: 16,
      max_output_tokens: 16
    };
    const evEqualSeq: SimEvent = {
      seq: 5,
      t_us: 200,
      type: "request.admitted",
      req_id: "req-1"
    };
    const evDecreasingSeq: SimEvent = {
      seq: 4,
      t_us: 300,
      type: "request.queued",
      req_id: "req-1",
      pod_id: "prefill-0",
      queue_depth: 1
    };

    const equalRes = parseAndValidateNDJSON(toNDJSON([header, ev1, evEqualSeq]));
    expect(equalRes.valid).toBe(false);
    expect(equalRes.issues).toHaveLength(1);
    expect(equalRes.issues[0].line).toBe(3);
    expect(equalRes.issues[0].message).toContain("Non-monotonic seq");

    const decreasingRes = parseAndValidateNDJSON(toNDJSON([header, ev1, evDecreasingSeq]));
    expect(decreasingRes.valid).toBe(false);
    expect(decreasingRes.issues).toHaveLength(1);
    expect(decreasingRes.issues[0].line).toBe(3);
    expect(decreasingRes.issues[0].message).toContain("Non-monotonic seq");
  });

  it("rejects decreasing t_us", () => {
    const header = makeHeader();
    const ev1: SimEvent = {
      seq: 1,
      t_us: 500,
      type: "request.arrived",
      req_id: "req-1",
      prompt_tokens: 16,
      max_output_tokens: 16
    };
    const ev2: SimEvent = {
      seq: 2,
      t_us: 499,
      type: "request.admitted",
      req_id: "req-1"
    };

    const result = parseAndValidateNDJSON(toNDJSON([header, ev1, ev2]));
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].line).toBe(3);
    expect(result.issues[0].message).toContain("Decreasing timestamp t_us");
  });
});
