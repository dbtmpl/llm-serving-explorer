import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseAndValidateNDJSON, type MetricsSnapshotEvent, type SimEvent } from "@llm-viz/schema";

interface RunConfigFields {
  scenario?: string;
  num_requests?: number;
  rate?: number;
  prompt_tokens?: number;
  prompt_tokens_stdev?: number;
  prompt_tokens_min?: number;
  prompt_tokens_max?: number;
  output_tokens?: number;
  output_tokens_stdev?: number;
  output_tokens_min?: number;
  output_tokens_max?: number;
  prefix_tokens?: number;
  seed?: number;
  horizon?: number;
  num_instances?: number;
  prefill_instances?: number;
  decode_instances?: number;
  workload_spec?: string;
  policy_config?: string;
  model_autoscaler_interval_us?: number;
  timeout?: number;
  pd_transfer_contention?: boolean;
  kv_event_delay?: number;
  epp_scrape_jitter?: number;
  gateway_latency?: number;
  cli_flags?: string[];
  extra_args?: string[];
}

interface CompareVariantConfig extends RunConfigFields {
  label: string;
}

interface ScenarioFlagsJson extends RunConfigFields {
  title: string;
  subtitle: string;
  recommended_views: string[];
  compare_variant?: CompareVariantConfig;
}

export interface ScenarioManifestEntry {
  id: string;
  title: string;
  subtitle: string;
  events_file: string;
  baseline_events_file?: string;
  compare_label?: string;
  recommended_views: string[];
  event_count: number;
  duration_us: number;
  completed_requests: number;
  events_bytes: number;
  baseline_event_count?: number;
  baseline_events_bytes?: number;
}

export interface ScenariosManifest {
  schema_version: "1.0";
  scenarios: ScenarioManifestEntry[];
}

const BLIS_BIN_PATH = "/tmp/blis-gen";

function findRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../..");
}

function parseCliArgs(argv: string[]): { only?: string; rebuild: boolean } {
  let only: string | undefined;
  let rebuild = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rebuild") {
      rebuild = true;
    } else if (arg === "--only") {
      only = argv[i + 1];
      i++;
    } else if (arg.startsWith("--only=")) {
      only = arg.slice("--only=".length);
    }
  }
  return { only, rebuild };
}

function ensureBlisBinary(repoRoot: string, rebuild: boolean): string {
  if (!rebuild && existsSync(BLIS_BIN_PATH)) {
    return BLIS_BIN_PATH;
  }
  const engineDir = path.join(repoRoot, "engine");
  console.log(`[gen-scenarios] Building BLIS binary into ${BLIS_BIN_PATH}...`);
  execFileSync("go", ["build", "-o", BLIS_BIN_PATH, "."], {
    cwd: engineDir,
    stdio: "inherit"
  });
  return BLIS_BIN_PATH;
}

function deterministicGzip(input: Buffer): Buffer {
  const gz = gzipSync(input, { level: 9 });
  // RFC 1952 header: zero MTIME (bytes 4..7) and normalize OS byte (byte 9 = 3 Unix)
  gz[4] = 0;
  gz[5] = 0;
  gz[6] = 0;
  gz[7] = 0;
  gz[9] = 3;
  return gz;
}

function buildBlisArgs(
  repoRoot: string,
  scenarioDir: string,
  cfg: RunConfigFields,
  eventsOutPath: string
): string[] {
  const args: string[] = [
    "run",
    "--scenarios",
    scenarioDir,
    "--scenario",
    cfg.scenario ?? "scenario.yaml",
    "--defaults-filepath",
    path.join(repoRoot, "engine", "defaults.yaml"),
    "--events-output",
    eventsOutPath
  ];

  const numericFlags: Array<[keyof RunConfigFields, string]> = [
    ["num_requests", "--num-requests"],
    ["rate", "--rate"],
    ["prompt_tokens", "--prompt-tokens"],
    ["prompt_tokens_stdev", "--prompt-tokens-stdev"],
    ["prompt_tokens_min", "--prompt-tokens-min"],
    ["prompt_tokens_max", "--prompt-tokens-max"],
    ["output_tokens", "--output-tokens"],
    ["output_tokens_stdev", "--output-tokens-stdev"],
    ["output_tokens_min", "--output-tokens-min"],
    ["output_tokens_max", "--output-tokens-max"],
    ["prefix_tokens", "--prefix-tokens"],
    ["seed", "--seed"],
    ["horizon", "--horizon"],
    ["num_instances", "--num-instances"],
    ["prefill_instances", "--prefill-instances"],
    ["decode_instances", "--decode-instances"],
    ["model_autoscaler_interval_us", "--model-autoscaler-interval-us"],
    ["kv_event_delay", "--kv-event-delay"],
    ["epp_scrape_jitter", "--epp-scrape-jitter"],
    ["gateway_latency", "--gateway-latency"]
  ];

  for (const [key, flag] of numericFlags) {
    const val = cfg[key];
    if (typeof val === "number") {
      args.push(flag, String(val));
    }
  }

  const timeoutVal = typeof cfg.timeout === "number" ? cfg.timeout : -1;
  args.push("--timeout", String(timeoutVal));

  if (cfg.pd_transfer_contention) {
    args.push("--pd-transfer-contention");
  }
  if (cfg.workload_spec) {
    args.push("--workload-spec", path.resolve(scenarioDir, cfg.workload_spec));
  }
  if (cfg.policy_config) {
    args.push("--policy-config", path.resolve(scenarioDir, cfg.policy_config));
  }
  if (cfg.cli_flags && cfg.cli_flags.length > 0) {
    args.push(...cfg.cli_flags);
  }
  if (cfg.extra_args && cfg.extra_args.length > 0) {
    args.push(...cfg.extra_args);
  }
  return args;
}

function summarizeEvents(events: readonly SimEvent[]): {
  eventCount: number;
  durationUs: number;
  completedRequests: number;
} {
  const eventCount = events.length;
  const durationUs = eventCount > 0 ? events[eventCount - 1].t_us : 0;
  let completedRequests = 0;

  for (let i = eventCount - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === "metrics.snapshot") {
      completedRequests = (ev as MetricsSnapshotEvent).completed_requests;
      break;
    }
  }
  return { eventCount, durationUs, completedRequests };
}

function runAndWriteTrace(
  blisBin: string,
  repoRoot: string,
  scenarioDir: string,
  scenarioId: string,
  variantLabel: string,
  cfg: RunConfigFields,
  outGzPath: string,
  scratchDir: string
): { eventCount: number; durationUs: number; completedRequests: number; bytes: number } {
  const rawPath = path.join(scratchDir, `${scenarioId}-${variantLabel}.ndjson`);
  const args = buildBlisArgs(repoRoot, scenarioDir, cfg, rawPath);

  try {
    execFileSync(blisBin, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer; message?: string };
    const stderr = e.stderr ? e.stderr.toString("utf8") : "";
    const stdout = e.stdout ? e.stdout.toString("utf8") : "";
    throw new Error(
      `BLIS failed for ${scenarioId} (${variantLabel}): ${e.message ?? String(err)}\n${stderr}\n${stdout}`
    );
  }

  const rawNdjson = readFileSync(rawPath, "utf8");
  const validation = parseAndValidateNDJSON(rawNdjson);
  if (!validation.valid) {
    const preview = validation.issues
      .slice(0, 10)
      .map((iss) => `  line ${iss.line}: ${iss.message}`)
      .join("\n");
    throw new Error(
      `Schema validation failed for ${scenarioId} (${variantLabel}) (${validation.issues.length} issues):\n${preview}`
    );
  }

  const gzBuf = deterministicGzip(Buffer.from(rawNdjson, "utf8"));
  writeFileSync(outGzPath, gzBuf);

  const summary = summarizeEvents(validation.events);
  return { ...summary, bytes: gzBuf.byteLength };
}

function discoverScenarioIds(scenariosRoot: string): string[] {
  if (!existsSync(scenariosRoot)) {
    return [];
  }
  return readdirSync(scenariosRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(scenariosRoot, d.name, "flags.json")))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

function main(): void {
  const { only, rebuild } = parseCliArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot();
  const scenariosRoot = path.join(repoRoot, "scenarios");
  mkdirSync(scenariosRoot, { recursive: true });

  const allIds = discoverScenarioIds(scenariosRoot);
  const targetIds = only ? allIds.filter((id) => id === only) : allIds;

  if (targetIds.length === 0) {
    throw new Error(
      only
        ? `No scenario directory matching --only=${only} found under ${scenariosRoot}`
        : `No scenarios found under ${scenariosRoot}`
    );
  }

  const blisBin = ensureBlisBinary(repoRoot, rebuild);
  const scratchDir = mkdtempSync(path.join(tmpdir(), "blis-gen-"));

  try {
    const manifestPath = path.join(scenariosRoot, "manifest.json");
    const existingById = new Map<string, ScenarioManifestEntry>();
    if (only && existsSync(manifestPath)) {
      const existing = JSON.parse(readFileSync(manifestPath, "utf8")) as ScenariosManifest;
      for (const entry of existing.scenarios) {
        existingById.set(entry.id, entry);
      }
    }

    for (const id of targetIds) {
      const scenarioDir = path.join(scenariosRoot, id);
      const flags = JSON.parse(readFileSync(path.join(scenarioDir, "flags.json"), "utf8")) as ScenarioFlagsJson;

      const primaryOutPath = path.join(scenarioDir, "events.ndjson.gz");
      const primary = runAndWriteTrace(
        blisBin,
        repoRoot,
        scenarioDir,
        id,
        "primary",
        flags,
        primaryOutPath,
        scratchDir
      );

      const entry: ScenarioManifestEntry = {
        id,
        title: flags.title,
        subtitle: flags.subtitle,
        events_file: `${id}/events.ndjson.gz`,
        recommended_views: flags.recommended_views,
        event_count: primary.eventCount,
        duration_us: primary.durationUs,
        completed_requests: primary.completedRequests,
        events_bytes: primary.bytes
      };

      if (flags.compare_variant) {
        const mergedBaseline: RunConfigFields = {
          ...flags,
          ...flags.compare_variant,
          cli_flags: flags.compare_variant.cli_flags ?? flags.cli_flags,
          extra_args: flags.compare_variant.extra_args ?? flags.extra_args
        };
        const baselineOutPath = path.join(scenarioDir, "baseline.events.ndjson.gz");
        const baseline = runAndWriteTrace(
          blisBin,
          repoRoot,
          scenarioDir,
          id,
          "baseline",
          mergedBaseline,
          baselineOutPath,
          scratchDir
        );
        entry.baseline_events_file = `${id}/baseline.events.ndjson.gz`;
        entry.compare_label = flags.compare_variant.label;
        entry.baseline_event_count = baseline.eventCount;
        entry.baseline_events_bytes = baseline.bytes;
      }

      existingById.set(id, entry);
      const baselineNote = entry.baseline_event_count
        ? ` | baseline: ${entry.baseline_event_count} events (${(entry.baseline_events_bytes! / 1024).toFixed(1)} KB)`
        : "";
      console.log(
        `[gen-scenarios] ${id}: ${entry.event_count} events (${(entry.events_bytes / 1024).toFixed(1)} KB), ` +
          `${entry.completed_requests} reqs, ${(entry.duration_us / 1e6).toFixed(2)}s${baselineNote}`
      );
    }

    const orderedEntries = allIds
      .map((id) => existingById.get(id))
      .filter((e): e is ScenarioManifestEntry => e !== undefined);

    const manifest: ScenariosManifest = {
      schema_version: "1.0",
      scenarios: orderedEntries
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`[gen-scenarios] Wrote ${manifestPath} (${orderedEntries.length} scenarios)`);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

main();
