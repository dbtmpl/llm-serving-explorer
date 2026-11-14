import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { SimulationRunConfig } from "./configBuilder.js";
import { resolveBlisBinary, runBlisSimulation } from "./runner.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface LocalRunnerServerOptions {
  port?: number;
  host?: string;
  blisBin?: string;
  repoRoot?: string;
  timeoutMs?: number;
}

export interface LocalRunnerServerHandle {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new BodyError(413, "Request body exceeds 1 MB limit");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new BodyError(
      400,
      `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

class BodyError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function isConfigValidationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes("must be") ||
    err.message.includes("Unsupported ") ||
    err.message.includes("required") ||
    err.message.includes("Both prefill_instances")
  );
}

/**
 * Starts the HTTP local runner server (`GET /health`, `POST /api/run`) with CORS enabled.
 */
export async function createLocalRunnerServer(
  options: LocalRunnerServerOptions = {}
): Promise<LocalRunnerServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 4190;

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";

    if (method === "OPTIONS") {
      setCorsHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method === "GET" && pathname === "/health") {
      try {
        const binary = await resolveBlisBinary({
          blisBin: options.blisBin,
          repoRoot: options.repoRoot
        });
        sendJson(res, 200, { ok: true, engine: "native-blis", binary });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      return;
    }

    if (method === "POST" && pathname === "/api/run") {
      try {
        const body = await readJsonBody(req);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: "Request body must be a JSON object" });
          return;
        }
        const output = await runBlisSimulation(body as SimulationRunConfig, {
          blisBin: options.blisBin,
          repoRoot: options.repoRoot,
          timeoutMs: options.timeoutMs
        });
        sendJson(res, 200, output);
      } catch (err) {
        if (err instanceof BodyError) {
          sendJson(res, err.statusCode, { ok: false, error: err.message });
          return;
        }
        const status = isConfigValidationError(err) ? 400 : 500;
        sendJson(res, status, {
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: `Not found: ${method} ${pathname}` });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const url = `http://${host}:${port}`;

  return {
    server,
    host,
    port,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
