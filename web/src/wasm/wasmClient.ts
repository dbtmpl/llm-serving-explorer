import type { SimulationRunConfig } from "@llm-viz/local-runner/config";
import { parseAndValidateNDJSON } from "@llm-viz/schema";
import type { BlisWorkerRequest, BlisWorkerResponse } from "./blisWorker.js";

export interface WasmRunResult {
  ok: true;
  ndjson: string;
  result: Record<string, unknown>;
  commandArgs: string[];
  injectedReqTag?: string;
  injectedReqId?: string;
}

function getBaseUrl(): string {
  const raw = import.meta.env?.BASE_URL || "/";
  const normalized = raw.endsWith("/") ? raw : `${raw}/`;
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${normalized}`;
  }
  return normalized;
}

export function isWasmSupported(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof DecompressionStream !== "undefined"
  );
}

interface PendingCall {
  resolve: (value: BlisWorkerResponse) => void;
  reject: (reason: Error) => void;
}

class BlisWasmClient {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingCall>();
  private seq = 0;

  private ensureWorker(): Worker {
    if (!isWasmSupported()) {
      throw new Error(
        "Browser WebAssembly Worker or DecompressionStream('gzip') is not available in this environment."
      );
    }
    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(new URL("./blisWorker.ts", import.meta.url), {
      type: "module"
    });
    worker.onmessage = (event: MessageEvent<BlisWorkerResponse>) => {
      const resp = event.data;
      const entry = this.pending.get(resp.requestId);
      if (!entry) return;
      this.pending.delete(resp.requestId);
      entry.resolve(resp);
    };
    worker.onerror = (err) => {
      const message = err.message || "BLIS WASM Worker crashed";
      for (const [id, entry] of this.pending.entries()) {
        this.pending.delete(id);
        entry.reject(new Error(message));
      }
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private postRequest(msg: BlisWorkerRequest, timeoutMs = 120_000): Promise<BlisWorkerResponse> {
    const worker = this.ensureWorker();
    return new Promise<BlisWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.requestId);
        reject(new Error(`BLIS WASM simulation timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      this.pending.set(msg.requestId, {
        resolve: (resp) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      worker.postMessage(msg);
    });
  }

  async warmup(): Promise<void> {
    const requestId = `init_${++this.seq}`;
    const resp = await this.postRequest({
      type: "init",
      requestId,
      baseUrl: getBaseUrl()
    });
    if (resp.type === "result" && !resp.ok) {
      throw new Error(resp.error);
    }
  }

  async run(config: SimulationRunConfig, options?: { timeoutMs?: number }): Promise<WasmRunResult> {
    const requestId = `run_${++this.seq}`;
    const resp = await this.postRequest(
      {
        type: "run",
        requestId,
        config,
        baseUrl: getBaseUrl()
      },
      options?.timeoutMs
    );
    if (resp.type !== "result") {
      throw new Error(`Unexpected WASM worker response type: ${resp.type}`);
    }
    if (!resp.ok) {
      throw new Error(resp.error);
    }
    const validation = parseAndValidateNDJSON(resp.ndjson);
    if (!validation.valid) {
      const preview = validation.issues
        .slice(0, 5)
        .map((iss) => `line ${iss.line}: ${iss.message}`)
        .join("; ");
      throw new Error(`BLIS WASM event stream failed schema validation: ${preview}`);
    }
    return {
      ok: true,
      ndjson: resp.ndjson,
      result: resp.result,
      commandArgs: resp.commandArgs,
      ...(resp.injectedReqTag !== undefined ? { injectedReqTag: resp.injectedReqTag } : {}),
      ...(resp.injectedReqId !== undefined ? { injectedReqId: resp.injectedReqId } : {})
    };
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const entry of this.pending.values()) {
      entry.reject(new Error("BLIS WASM client disposed"));
    }
    this.pending.clear();
  }
}

export const blisWasmClient = new BlisWasmClient();

export function runBlisWasm(
  config: SimulationRunConfig,
  options?: { timeoutMs?: number }
): Promise<WasmRunResult> {
  return blisWasmClient.run(config, options);
}
