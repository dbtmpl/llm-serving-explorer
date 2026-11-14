import { pathToFileURL } from "node:url";
import { createLocalRunnerServer } from "./server.js";

export * from "./configBuilder.js";
export * from "./runner.js";
export * from "./server.js";

function parsePort(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && i + 1 < argv.length) {
      const parsed = Number(argv[i + 1]);
      if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    } else if (arg.startsWith("--port=")) {
      const parsed = Number(arg.slice("--port=".length));
      if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  const envPort = process.env.PORT ? Number(process.env.PORT) : NaN;
  if (Number.isInteger(envPort) && envPort >= 0) {
    return envPort;
  }
  return 4190;
}

const isCliEntry =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCliEntry) {
  const port = parsePort(process.argv.slice(2));
  const host = process.env.HOST ?? "127.0.0.1";
  const handle = await createLocalRunnerServer({ port, host });
  console.log(`[local-runner] Listening on ${handle.url} (GET /health, POST /api/run)`);

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
