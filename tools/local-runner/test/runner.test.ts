import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseAndValidateNDJSON, type RequestArrivedEvent } from "@llm-viz/schema";
import {
  buildSimulationConfig,
  createLocalRunnerServer,
  resolveBlisBinary,
  type LocalRunnerServerHandle
} from "../src/index.js";

describe("configBuilder", () => {
  it("builds valid preset configs for llama-3.1-8b-instruct and llama-3.1-70b-instruct", () => {
    const cfg8b = buildSimulationConfig(
      {
        preset: "llama-3.1-8b-instruct",
        num_requests: 10,
        rate: 5,
        max_num_seqs: 64,
        gpu_memory_utilization: 0.4,
        routing_policy: "prefix-cache",
        num_instances: 2,
        offload_cpu_gib: 2
      },
      {
        scenarioDir: "/sim",
        defaultsFilepath: "/sim/defaults.yaml",
        eventsOutputPath: "/sim/events.ndjson"
      }
    );
    expect(cfg8b.scenarioYaml).toContain("model: llama-3.1-8b-instruct");
    expect(cfg8b.scenarioYaml).toContain("hardware: a100-sxm");
    expect(cfg8b.scenarioYaml).toContain("block_size: 16");
    expect(cfg8b.scenarioYaml).toContain("max_num_seqs: 64");
    expect(cfg8b.scenarioYaml).toContain("gpu_memory_utilization: 0.4");
    expect(cfg8b.scenarioYaml).toContain("cost-model-offload-tiers");
    expect(cfg8b.scenarioYaml).toContain("tier: cpu_dram");
    expect(cfg8b.routerYaml).toContain("prefix-cache-scorer");
    expect(cfg8b.commandArgs).toContain("--num-instances");
    expect(cfg8b.commandArgs).toContain("2");

    const cfg70b = buildSimulationConfig(
      {
        preset: "llama-3.1-70b-instruct",
        prefill_instances: 2,
        decode_instances: 1,
        routing_policy: "round-robin"
      },
      {
        scenarioDir: "/sim",
        defaultsFilepath: "/sim/defaults.yaml",
        eventsOutputPath: "/sim/events.ndjson"
      }
    );
    expect(cfg70b.scenarioYaml).toContain("model: llama-3.1-70b-instruct");
    expect(cfg70b.scenarioYaml).toContain("hardware: h100");
    expect(cfg70b.scenarioYaml).toContain("tp: 2");
    expect(cfg70b.scenarioYaml).toContain("quantization: fp8");
    expect(cfg70b.scenarioYaml).toContain("kv_cache_dtype: fp8");
    expect(cfg70b.scenarioYaml).toContain("fabric: ib-400g");
    expect(cfg70b.scenarioYaml).toContain("NixlConnector");
    expect(cfg70b.routerYaml).toContain("disagg-profile-handler");
    expect(cfg70b.routerYaml).toContain("random-picker");
    expect(cfg70b.commandArgs).toContain("--prefill-instances");
    expect(cfg70b.commandArgs).toContain("--decode-instances");
  });

  it("rejects mismatched P/D instance counts", () => {
    expect(() =>
      buildSimulationConfig(
        { prefill_instances: 2, decode_instances: 0 },
        {
          scenarioDir: "/sim",
          defaultsFilepath: "/sim/defaults.yaml",
          eventsOutputPath: "/sim/events.ndjson"
        }
      )
    ).toThrow(/Both prefill_instances and decode_instances/);
  });
});

describe("local-runner HTTP server (live native BLIS)", () => {
  let serverHandle: LocalRunnerServerHandle;

  beforeAll(async () => {
    await resolveBlisBinary();
    serverHandle = await createLocalRunnerServer({ port: 0, timeoutMs: 60_000 });
  }, 120_000);

  afterAll(async () => {
    await serverHandle.close();
  });

  it("GET /health reports native-blis and binary path", async () => {
    const res = await fetch(`${serverHandle.url}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { ok: boolean; engine: string; binary: string };
    expect(body.ok).toBe(true);
    expect(body.engine).toBe("native-blis");
    expect(typeof body.binary).toBe("string");
    expect(body.binary.length).toBeGreaterThan(0);
  });

  it("POST /api/run runs llama-3.1-8b-instruct with custom max_num_seqs, gpu_memory_utilization, and rate", async () => {
    const res = await fetch(`${serverHandle.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "llama-3.1-8b-instruct",
        num_requests: 6,
        rate: 8,
        prompt_tokens: 96,
        output_tokens: 24,
        max_num_seqs: 48,
        gpu_memory_utilization: 0.35,
        routing_policy: "least-loaded",
        num_instances: 2,
        seed: 7
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      ndjson: string;
      result: Record<string, unknown>;
      commandArgs: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.result).toBeDefined();
    expect(body.commandArgs).toContain("--num-instances");

    const parsed = parseAndValidateNDJSON(body.ndjson);
    expect(parsed.valid).toBe(true);
    expect(parsed.issues).toEqual([]);
    expect(parsed.header?.scenario.model).toBe("llama-3.1-8b-instruct");
    expect(parsed.header?.scenario.hardware).toBe("a100-sxm");
    expect(parsed.header?.topology.pools[0]?.max_num_seqs).toBe(48);
    expect(parsed.header?.topology.pools[0]?.replicas).toBe(2);

    const arrived = parsed.events.filter(
      (ev): ev is RequestArrivedEvent => ev.type === "request.arrived"
    );
    expect(arrived).toHaveLength(6);
    expect(arrived[0]?.prompt_tokens).toBe(96);
    expect(arrived[0]?.max_output_tokens).toBe(24);
  }, 60_000);

  it("POST /api/run supports single-request injection and emits valid NDJSON containing the injected request", async () => {
    const res = await fetch(`${serverHandle.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "llama-3.1-8b-instruct",
        num_requests: 5,
        rate: 5,
        prompt_tokens: 64,
        output_tokens: 16,
        prefix_tokens: 256,
        routing_policy: "prefix-cache",
        num_instances: 2,
        seed: 42,
        injected_request: {
          id: "probe-req-1",
          arrival_s: 0.55,
          prompt_tokens: 128,
          output_tokens: 20,
          prefix_group: "shared"
        }
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      ndjson: string;
      result: Record<string, unknown>;
      commandArgs: string[];
      injectedReqTag?: string;
      injectedReqId?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.injectedReqTag).toBe("probe-req-1");
    expect(body.injectedReqId).toMatch(/^request_\d+$/);

    const parsed = parseAndValidateNDJSON(body.ndjson);
    expect(parsed.valid).toBe(true);
    expect(parsed.issues).toEqual([]);

    const arrived = parsed.events.filter(
      (ev): ev is RequestArrivedEvent => ev.type === "request.arrived"
    );
    expect(arrived).toHaveLength(6);

    const injectedEv = arrived.find((ev) => ev.req_id === body.injectedReqId);
    expect(injectedEv).toBeDefined();
    expect(injectedEv?.t_us).toBe(550_000);
    // 256 shared prefix tokens + 128 injected prompt tokens = 384 total prompt tokens
    expect(injectedEv?.prompt_tokens).toBe(384);
    expect(injectedEv?.max_output_tokens).toBe(20);
    expect(injectedEv?.prefix_group).toBe("shared");
  }, 60_000);

  it("POST /api/run handles injected request arriving after background batch completes", async () => {
    const res = await fetch(`${serverHandle.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "llama-3.1-8b-instruct",
        num_requests: 4,
        rate: 10,
        prompt_tokens: 48,
        output_tokens: 12,
        injected_request: {
          id: "late-probe",
          arrival_s: 1.25,
          prompt_tokens: 192,
          output_tokens: 24
        }
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      ndjson: string;
      injectedReqId?: string;
    };
    const parsed = parseAndValidateNDJSON(body.ndjson);
    expect(parsed.valid).toBe(true);

    const arrived = parsed.events.filter(
      (ev): ev is RequestArrivedEvent => ev.type === "request.arrived"
    );
    expect(arrived).toHaveLength(5);
    const late = arrived.find((ev) => ev.req_id === body.injectedReqId);
    expect(late?.t_us).toBe(1_250_000);
    expect(late?.prompt_tokens).toBe(192);
    expect(late?.max_output_tokens).toBe(24);
  }, 60_000);

  it("POST /api/run runs llama-3.1-70b-instruct (FP8, TP2, H100) with P/D disaggregation", async () => {
    const res = await fetch(`${serverHandle.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: "llama-3.1-70b-instruct",
        num_requests: 4,
        rate: 10,
        prompt_tokens: 128,
        output_tokens: 16,
        routing_policy: "round-robin",
        prefill_instances: 1,
        decode_instances: 1,
        seed: 11
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ndjson: string };
    const parsed = parseAndValidateNDJSON(body.ndjson);
    expect(parsed.valid).toBe(true);
    expect(parsed.issues).toEqual([]);
    expect(parsed.header?.scenario.model).toBe("llama-3.1-70b-instruct");
    expect(parsed.header?.scenario.hardware).toBe("h100");
    expect(parsed.header?.topology.pools).toHaveLength(2);
    expect(parsed.header?.topology.pools[0]?.tp).toBe(2);
  }, 60_000);
});
