/// <reference lib="webworker" />

import {
  buildSimulationConfig,
  findInjectedRequestId,
  type SimulationRunConfig
} from "@llm-viz/local-runner/config";
import { createVirtualFsEnvironment, type VirtualFsEnvironment } from "./virtualFs.js";

export type BlisWorkerRequest =
  | { type: "init"; requestId: string; baseUrl?: string }
  | { type: "run"; requestId: string; config: SimulationRunConfig; baseUrl?: string };

export type BlisWorkerResponse =
  | { type: "inited"; requestId: string }
  | {
      type: "result";
      requestId: string;
      ok: true;
      ndjson: string;
      result: Record<string, unknown>;
      commandArgs: string[];
      injectedReqTag?: string;
      injectedReqId?: string;
    }
  | { type: "result"; requestId: string; ok: false; error: string };

interface GoRuntime {
  argv: string[];
  env: Record<string, string>;
  exit: (code: number) => void;
  importObject: WebAssembly.Imports;
  run: (instance: WebAssembly.Instance) => Promise<void>;
}

type GoConstructor = new () => GoRuntime;

let virtualEnv: VirtualFsEnvironment | null = null;
let compiledModule: WebAssembly.Module | null = null;
let defaultsYamlText: string | null = null;
let initPromise: Promise<void> | null = null;

function resolveWasmAssetUrl(baseUrl: string | undefined, filename: string): string {
  const envBase =
    typeof import.meta !== "undefined" && import.meta.env?.BASE_URL
      ? import.meta.env.BASE_URL
      : "/";
  const rawBase = baseUrl && baseUrl.length > 0 ? baseUrl : envBase;
  const normalizedBase = rawBase.endsWith("/") ? rawBase : `${rawBase}/`;
  return `${normalizedBase}wasm/${filename}`;
}

async function gunzipResponse(res: Response): Promise<ArrayBuffer> {
  if (!res.ok) {
    throw new Error(`Failed to fetch ${res.url}: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) {
    return buf;
  }
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Browser does not support DecompressionStream('gzip')");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function ensureInitialized(baseUrl?: string): Promise<void> {
  if (compiledModule && defaultsYamlText !== null && virtualEnv) {
    return;
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    if (!virtualEnv) {
      virtualEnv = createVirtualFsEnvironment();
      const g = globalThis as Record<string, unknown>;
      g.fs = virtualEnv.fs;
      g.process = virtualEnv.process;
      g.path = virtualEnv.path;
    }

    const [wasmExecRes, defaultsRes, wasmRes] = await Promise.all([
      fetch(resolveWasmAssetUrl(baseUrl, "wasm_exec.js")),
      fetch(resolveWasmAssetUrl(baseUrl, "defaults.yaml")),
      fetch(resolveWasmAssetUrl(baseUrl, "blis.wasm.gz"))
    ]);

    if (!wasmExecRes.ok) {
      throw new Error(`Failed to fetch wasm_exec.js: HTTP ${wasmExecRes.status}`);
    }
    if (!defaultsRes.ok) {
      throw new Error(`Failed to fetch defaults.yaml: HTTP ${defaultsRes.status}`);
    }

    const [wasmExecSrc, defaultsText, wasmBuffer] = await Promise.all([
      wasmExecRes.text(),
      defaultsRes.text(),
      gunzipResponse(wasmRes)
    ]);

    if (typeof (globalThis as Record<string, unknown>).Go !== "function") {
      // Evaluate Go's wasm_exec.js after installing the virtual fs/process/path globals.
      new Function(wasmExecSrc)();
    }

    defaultsYamlText = defaultsText;
    compiledModule = await WebAssembly.compile(wasmBuffer);
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

async function runSimulationInWasm(
  config: SimulationRunConfig,
  baseUrl?: string
): Promise<Omit<Extract<BlisWorkerResponse, { type: "result"; ok: true }>, "type" | "requestId">> {
  await ensureInitialized(baseUrl);
  if (!virtualEnv || !compiledModule || defaultsYamlText === null) {
    throw new Error("WASM runtime failed to initialize");
  }

  const eventsOutputPath = "/sim/events.ndjson";
  const workloadSpecPath = "/sim/workload.yaml";
  const built = buildSimulationConfig(config, {
    scenarioDir: "/sim",
    defaultsFilepath: "/sim/defaults.yaml",
    eventsOutputPath,
    workloadSpecPath: config.injected_request ? workloadSpecPath : undefined
  });

  const virtualFiles: Record<string, string> = {
    "/sim/defaults.yaml": defaultsYamlText,
    "/sim/scenario.yaml": built.scenarioYaml,
    "/sim/router.yaml": built.routerYaml
  };
  if (built.workloadYaml !== undefined) {
    virtualFiles[workloadSpecPath] = built.workloadYaml;
  }
  virtualEnv.reset(virtualFiles);

  const GoClass = (globalThis as unknown as { Go: GoConstructor }).Go;
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

  if (exitCode !== 0) {
    throw new Error(`BLIS WASM exited with code ${exitCode}: ${stderr || stdout}`.trim());
  }

  const ndjson = virtualEnv.readVirtualFileText(eventsOutputPath);
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse BLIS WASM stdout Result JSON: ${err instanceof Error ? err.message : String(err)}\n${stderr}`
    );
  }

  const injectedReqTag = built.injectedRequest?.tag;
  const injectedReqId = findInjectedRequestId(ndjson, built.injectedRequest);

  return {
    ok: true,
    ndjson,
    result,
    commandArgs: built.commandArgs,
    ...(injectedReqTag !== undefined ? { injectedReqTag } : {}),
    ...(injectedReqId !== undefined ? { injectedReqId } : {})
  };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = async (event: MessageEvent<BlisWorkerRequest>) => {
    const msg = event.data;
    if (msg.type === "init") {
      try {
        await ensureInitialized(msg.baseUrl);
        const resp: BlisWorkerResponse = { type: "inited", requestId: msg.requestId };
        self.postMessage(resp);
      } catch (err) {
        const resp: BlisWorkerResponse = {
          type: "result",
          requestId: msg.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        };
        self.postMessage(resp);
      }
      return;
    }

    if (msg.type === "run") {
      try {
        const out = await runSimulationInWasm(msg.config, msg.baseUrl);
        const resp: BlisWorkerResponse = {
          type: "result",
          requestId: msg.requestId,
          ...out
        };
        self.postMessage(resp);
      } catch (err) {
        const resp: BlisWorkerResponse = {
          type: "result",
          requestId: msg.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        };
        self.postMessage(resp);
      }
    }
  };
}
