import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseAndValidateNDJSON } from "@llm-viz/schema";
import {
  buildSimulationConfig,
  findInjectedRequestId,
  type SimulationRunConfig
} from "./configBuilder.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_BLIS_LOCAL_BIN = "/tmp/blis-local-runner";
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

let pendingBuild: Promise<string> | null = null;

export function findRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

/**
 * Resolves the native BLIS binary path (`BLIS_BIN` env, explicit override, or `/tmp/blis-local-runner`),
 * building it from `engine/` on first use if needed.
 */
export async function resolveBlisBinary(
  options: { blisBin?: string; repoRoot?: string } = {}
): Promise<string> {
  const explicit = options.blisBin ?? process.env.BLIS_BIN;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`BLIS binary not found at ${explicit}`);
    }
    return explicit;
  }

  if (existsSync(DEFAULT_BLIS_LOCAL_BIN)) {
    return DEFAULT_BLIS_LOCAL_BIN;
  }

  if (!pendingBuild) {
    const repoRoot = options.repoRoot ?? findRepoRoot();
    const engineDir = path.join(repoRoot, "engine");
    pendingBuild = execFileAsync(
      "go",
      ["build", "-o", DEFAULT_BLIS_LOCAL_BIN, "."],
      { cwd: engineDir, maxBuffer: MAX_BUFFER_BYTES }
    )
      .then(() => DEFAULT_BLIS_LOCAL_BIN)
      .finally(() => {
        pendingBuild = null;
      });
  }

  return pendingBuild;
}

export interface RunBlisResult {
  ok: true;
  ndjson: string;
  result: Record<string, unknown>;
  commandArgs: string[];
  injectedReqTag?: string;
  injectedReqId?: string;
}

export interface RunBlisOptions {
  blisBin?: string;
  repoRoot?: string;
  timeoutMs?: number;
}

/**
 * Runs a single BLIS simulation in an isolated temp directory, validates the emitted NDJSON
 * event stream against `@llm-viz/schema`, and returns the parsed Result + NDJSON stream.
 */
export async function runBlisSimulation(
  config: SimulationRunConfig,
  options: RunBlisOptions = {}
): Promise<RunBlisResult> {
  const repoRoot = options.repoRoot ?? findRepoRoot();
  const blisBin = await resolveBlisBinary({ blisBin: options.blisBin, repoRoot });
  const defaultsFilepath = path.join(repoRoot, "engine", "defaults.yaml");
  const scratchDir = await mkdtemp(path.join(tmpdir(), "blis-local-run-"));

  try {
    const eventsOutputPath = path.join(scratchDir, "events.ndjson");
    const workloadSpecPath = path.join(scratchDir, "workload.yaml");

    const built = buildSimulationConfig(config, {
      scenarioDir: scratchDir,
      defaultsFilepath,
      eventsOutputPath,
      workloadSpecPath: config.injected_request ? workloadSpecPath : undefined
    });

    await writeFile(path.join(scratchDir, "scenario.yaml"), built.scenarioYaml, "utf8");
    await writeFile(path.join(scratchDir, "router.yaml"), built.routerYaml, "utf8");
    if (built.workloadYaml !== undefined) {
      await writeFile(workloadSpecPath, built.workloadYaml, "utf8");
    }

    let stdout: string;
    try {
      const execRes = await execFileAsync(blisBin, built.commandArgs, {
        cwd: repoRoot,
        timeout: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES
      });
      stdout = execRes.stdout;
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      throw new Error(
        `BLIS execution failed: ${e.message ?? String(err)}\n${e.stderr ?? ""}`.trim()
      );
    }

    const ndjson = await readFile(eventsOutputPath, "utf8");
    const validation = parseAndValidateNDJSON(ndjson);
    if (!validation.valid) {
      const preview = validation.issues
        .slice(0, 5)
        .map((iss) => `line ${iss.line}: ${iss.message}`)
        .join("; ");
      throw new Error(`BLIS event stream failed schema validation: ${preview}`);
    }

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(stdout) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Failed to parse BLIS stdout Result JSON: ${err instanceof Error ? err.message : String(err)}`
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
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
