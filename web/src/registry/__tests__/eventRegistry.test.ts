import { describe, expect, it } from "vitest";
import eventsSchema from "../../../../schema/events.schema.json" with { type: "json" };
import type { HeaderRecord, SimEvent, UnknownEvent } from "@llm-viz/schema";
import { parseScenarioNDJSON } from "../../data/scenarioLoader.js";
import {
  EVENT_REGISTRY,
  REGISTERED_EVENT_TYPES,
  getEventPresentation,
  resolveEventTone
} from "../eventRegistry.js";

function makeMinimalHeader(): HeaderRecord {
  return {
    type: "header",
    schema_version: "1.0",
    blis: {
      commit: "abcdef12",
      vllm_version: "0.32.0",
      llmd_version: "1.0.0",
      stack_versions: {}
    },
    scenario: {
      name: "test",
      model: "llama-3.1-8b-instruct",
      hardware: "a100-sxm",
      flags: {},
      seed: 42,
      horizon_us: 1_000_000
    },
    topology: {
      gateway_latency_us: 0,
      pools: [
        {
          role: "colocated",
          replicas: 1,
          tp: 1,
          pp: 1,
          dp: 1,
          gpus_per_pod: 1,
          gpu_type: "a100-sxm",
          gpu_specs: {
            memory_gib: 80,
            tflops_peak: 312,
            tflops_fp8: 0,
            bw_peak_tbs: 2.039,
            sm_count: 108
          },
          memory_breakdown_bytes: {
            weights: 16_000_000_000,
            activation_peak: 200_000_000,
            cuda_graph: 1_000_000_000,
            comm_buffers: 0
          },
          kv_blocks_per_gpu: 1000,
          kv_block_size_tokens: 16,
          max_num_seqs: 64,
          max_num_batched_tokens: 2048,
          max_model_len: 8192
        }
      ],
      tiers: {
        gpu_hbm_blocks: 1000,
        cpu_ram_blocks: 0,
        cpu_ram_bytes: 0,
        local_ssd_modelled: false,
        remote_store_modelled: false,
        unmodelled_notes: {}
      },
      initial_pods: [
        {
          pod_id: "instance_0",
          pool_role: "colocated",
          gpu_ids: ["gpu-0"],
          tp_degree: 1,
          state: "ready"
        }
      ]
    }
  };
}

describe("eventRegistry", () => {
  it("registers every simulation event type defined in events.schema.json (all 23)", () => {
    const schemaTypes = eventsSchema.oneOf
      .map((refObj) => {
        const defName = refObj.$ref.replace("#/$defs/", "");
        const def = eventsSchema.$defs[defName as keyof typeof eventsSchema.$defs] as {
          properties: { type: { const: string } };
        };
        return def.properties.type.const;
      })
      .filter((t) => t !== "header");

    expect(schemaTypes).toHaveLength(23);
    expect(REGISTERED_EVENT_TYPES).toHaveLength(23);

    for (const typeName of schemaTypes) {
      expect(EVENT_REGISTRY[typeName as SimEvent["type"]]).toBeDefined();
    }
  });

  it("renders a safe fallback presentation for unknown/future event types without throwing", () => {
    const unknownEvent: UnknownEvent = {
      seq: 99,
      t_us: 12345,
      type: "future.scheduler.speculative_draft",
      pod_id: "instance_0",
      draft_tokens: 4
    };

    const pres = getEventPresentation(unknownEvent);
    expect(pres.category).toBe("unknown");
    expect(pres.badge).toBe("UNKNOWN");
    expect(resolveEventTone(pres, unknownEvent)).toBe("neutral");
    expect(pres.shortSummary(unknownEvent)).toContain("future.scheduler.speculative_draft");
    expect(pres.details(unknownEvent)).toEqual(unknownEvent);
  });

  it("parseScenarioNDJSON preserves unknown event types for Event Log without crashing", () => {
    const header = makeMinimalHeader();
    const knownEv: SimEvent = {
      seq: 1,
      t_us: 100,
      type: "request.arrived",
      req_id: "req_0",
      prompt_tokens: 64,
      max_output_tokens: 16
    };
    const futureEv: UnknownEvent = {
      seq: 2,
      t_us: 200,
      type: "future.kv.compress",
      pod_id: "instance_0",
      ratio: 0.5
    };

    const ndjson = [header, knownEv, futureEv].map((r) => JSON.stringify(r)).join("\n");
    const parsed = parseScenarioNDJSON(ndjson);

    expect(parsed.unknownEventCount).toBe(1);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.timeline.eventCount).toBe(2);

    const state = parsed.timeline.stateAt(200);
    expect(state.tUs).toBe(200);
    expect(state.requests.get("req_0")?.promptTokens).toBe(64);
  });
});
