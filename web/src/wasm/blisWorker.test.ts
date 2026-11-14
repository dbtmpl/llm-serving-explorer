import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSimulationConfig,
  findInjectedRequestId,
  type SimulationRunConfig
} from "@llm-viz/local-runner/config";
import { parseAndValidateNDJSON, type RequestArrivedEvent } from "@llm-viz/schema";
import { createVirtualFsEnvironment } from "./virtualFs.js";

function getWasmDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../public/wasm");
}

async function gunzipBytes(gzBytes: Uint8Array): Promise<ArrayBuffer> {
  const copy = new Uint8Array(gzBytes);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

interface GoConstructor {
  new (): {
    argv: string[];
    env: Record<string, string>;
    exit: (code: number) => void;
    importObject: WebAssembly.Imports;
    run: (instance: WebAssembly.Instance) => Promise<void>;
  };
}

async function runWasmWithVirtualFs(
  compiledModule: WebAssembly.Module,
  defaultsYaml: string,
  config: SimulationRunConfig
) {
  const virtualEnv = createVirtualFsEnvironment();
  const g = globalThis as Record<string, unknown>;
  const prevFs = g.fs;
  const prevProcess = g.process;
  const prevPath = g.path;

  try {
    g.fs = virtualEnv.fs;
    g.process = virtualEnv.process;
    g.path = virtualEnv.path;

    if (typeof g.Go !== "function") {
      const wasmExecSrc = readFileSync(path.join(getWasmDir(), "wasm_exec.js"), "utf8");
      new Function(wasmExecSrc)();
    }

    const eventsOutputPath = "/sim/events.ndjson";
    const workloadSpecPath = "/sim/workload.yaml";
    const built = buildSimulationConfig(config, {
      scenarioDir: "/sim",
      defaultsFilepath: "/sim/defaults.yaml",
      eventsOutputPath,
      workloadSpecPath: config.injected_request ? workloadSpecPath : undefined
    });

    const files: Record<string, string> = {
      "/sim/defaults.yaml": defaultsYaml,
      "/sim/scenario.yaml": built.scenarioYaml,
      "/sim/router.yaml": built.routerYaml
    };
    if (built.workloadYaml !== undefined) {
      files[workloadSpecPath] = built.workloadYaml;
    }
    virtualEnv.reset(files);

    const GoClass = g.Go as GoConstructor;
    const go = new GoClass();
    go.argv = ["blis", ...built.commandArgs];
    go.env = { TMPDIR: "/tmp" };

    let exitCode = 0;
    go.exit = (code: number) => {
      exitCode = code;
    };

    const instance = await WebAssembly.instantiate(compiledModule, go.importObject);
    await go.run(instance);

    const stdout = virtualEnv.getStdout();
    const stderr = virtualEnv.getStderr();
    expect(exitCode, `WASM exited non-zero: ${stderr}`).toBe(0);

    const ndjson = virtualEnv.readVirtualFileText(eventsOutputPath);
    const result = JSON.parse(stdout) as Record<string, unknown>;
    const injectedReqId = findInjectedRequestId(ndjson, built.injectedRequest);

    return { ndjson, result, built, injectedReqId };
  } finally {
    g.fs = prevFs;
    g.process = prevProcess;
    g.path = prevPath;
  }
}

describe("BLIS WASM + virtualFs integration", () => {
  it("decompresses blis.wasm.gz, runs simulation via in-memory fs shim, and validates NDJSON + injection", async () => {
    const wasmDir = getWasmDir();
    const gzPath = path.join(wasmDir, "blis.wasm.gz");
    const execPath = path.join(wasmDir, "wasm_exec.js");
    const defaultsPath = path.join(wasmDir, "defaults.yaml");

    expect(existsSync(gzPath), `Missing ${gzPath}; run pnpm build:wasm`).toBe(true);
    expect(existsSync(execPath), `Missing ${execPath}; run pnpm build:wasm`).toBe(true);
    expect(existsSync(defaultsPath), `Missing ${defaultsPath}; run pnpm build:wasm`).toBe(true);

    const defaultsYaml = readFileSync(defaultsPath, "utf8");
    const wasmBytes = await gunzipBytes(new Uint8Array(readFileSync(gzPath)));
    const compiledModule = await WebAssembly.compile(wasmBytes);

    // Run 1: Standard custom simulation with virtual fs
    const run1 = await runWasmWithVirtualFs(compiledModule, defaultsYaml, {
      preset: "llama-3.1-8b-instruct",
      num_requests: 5,
      rate: 5,
      prompt_tokens: 64,
      output_tokens: 16,
      max_num_seqs: 32,
      gpu_memory_utilization: 0.4,
      routing_policy: "least-loaded",
      num_instances: 2,
      seed: 42
    });
    expect(run1.result).toBeDefined();
    expect(run1.result.kind).toBe("Result");

    const parsed1 = parseAndValidateNDJSON(run1.ndjson);
    expect(parsed1.valid).toBe(true);
    expect(parsed1.issues).toEqual([]);
    expect(parsed1.header?.topology.pools[0]?.max_num_seqs).toBe(32);
    expect(parsed1.header?.topology.pools[0]?.replicas).toBe(2);

    // Run 2: Re-instantiate same compiled module with single-request injection
    const run2 = await runWasmWithVirtualFs(compiledModule, defaultsYaml, {
      preset: "llama-3.1-8b-instruct",
      num_requests: 4,
      rate: 4,
      prompt_tokens: 48,
      output_tokens: 12,
      prefix_tokens: 128,
      routing_policy: "prefix-cache",
      num_instances: 2,
      seed: 9,
      injected_request: {
        id: "wasm-probe",
        arrival_s: 0.6,
        prompt_tokens: 96,
        output_tokens: 20,
        prefix_group: "shared"
      }
    });
    const parsed2 = parseAndValidateNDJSON(run2.ndjson);
    expect(parsed2.valid).toBe(true);
    expect(parsed2.issues).toEqual([]);
    expect(run2.injectedReqId).toMatch(/^request_\d+$/);

    const arrived2 = parsed2.events.filter(
      (ev): ev is RequestArrivedEvent => ev.type === "request.arrived"
    );
    expect(arrived2).toHaveLength(5);
    const injEv = arrived2.find((ev) => ev.req_id === run2.injectedReqId);
    expect(injEv).toBeDefined();
    expect(injEv?.t_us).toBe(600_000);
    expect(injEv?.prompt_tokens).toBe(224); // 128 prefix + 96 prompt
    expect(injEv?.max_output_tokens).toBe(20);
    expect(injEv?.prefix_group).toBe("shared");
  }, 120_000);
});
