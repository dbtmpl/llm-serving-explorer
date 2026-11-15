/**
 * Run BLIS on a scenario and reduce its Result to a `Reduced` record. Needs the BLIS binary, so
 * only the reference-regeneration script uses it; the Vitest suite reads committed references.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BLOCK_TOKENS, CONFORMANCE_DIR, type Scenario } from "../scenario.js";
import { microseconds, sortRows, type BlisProvenance, type Fate, type Reduced, type Reference, type RequestRow } from "../record.js";
import { toBlis } from "../translate/toBlis.js";

export const BLIS_LOCK = path.join(CONFORMANCE_DIR, "blis.lock");

/** The commit pinned in `conformance/blis.lock` (the first non-comment line). */
export function lockedCommit(): string {
  const line = readFileSync(BLIS_LOCK, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line || !/^[0-9a-f]{40}$/.test(line)) throw new Error(`${BLIS_LOCK}: the first non-comment line must be a full 40-character commit hash`);
  return line;
}

interface Row {
  id: string;
  fate: string;
  arrival_us: number;
  ttft_us?: number;
  e2e_us?: number;
  prompt_tokens?: number;
  cached_local_tokens?: number;
  output_tokens?: number;
  instance?: string;
  session_id?: string;
  round_index?: number;
}

interface Result {
  engine: { version: string };
  data: { catalog: { hash: string }; registry: { hash: string } };
  request_rows: Row[];
  requests: { dropped?: Record<string, number> };
  reports: { engine: { cluster: { kv_capacity_tokens_per_replica: number; preemptions: number } } };
}

/**
 * A row's fate. BLIS rows say only "dropped"; the Result says why in aggregate (`requests.dropped`).
 * Attribution is therefore only possible when every drop has one cause, and refused otherwise.
 */
function fateOf(s: Scenario, result: Result, row: Row): Fate {
  if (row.fate === "completed") return "completed";
  if (row.fate !== "dropped") return "other";
  const causes = Object.keys(result.requests.dropped ?? {});
  if (causes.length === 1 && causes[0] === "gateway_expired") return "shed";
  if (causes.length === 1 && causes[0] === "dropped_unservable") return "unservable";
  throw new Error(`${s.id}: BLIS dropped requests for several causes (${causes.join(", ")}); the rows cannot be attributed one by one`);
}

export function reduceBlis(s: Scenario, result: Result): Reduced {
  const cluster = result.reports.engine.cluster;
  if (cluster.kv_capacity_tokens_per_replica % BLOCK_TOKENS) throw new Error(`${s.id}: KV capacity ${cluster.kv_capacity_tokens_per_replica} is not a whole number of blocks`);
  const wanted = new Map(s.requests.map((r) => [`s${r.session}/${r.round}`, r]));
  const seen = new Set<string>();
  const rows: RequestRow[] = [];
  const requestsPerPod = new Array<number>(s.replicas).fill(0);
  for (const r of result.request_rows) {
    if (!r.session_id) throw new Error(`${s.id}: BLIS row ${r.id} has no session_id`);
    const session = Number(r.session_id.slice(1));
    const round = r.round_index ?? 0;
    const key = `s${session}/${round}`;
    const asked = wanted.get(key);
    if (!asked) throw new Error(`${s.id}: BLIS returned a row for ${key}, which the scenario did not send`);
    seen.add(key);
    const pod = r.instance === undefined ? null : Number(r.instance.replace("instance_", ""));
    if (pod !== null) requestsPerPod[pod] = (requestsPerPod[pod] ?? 0) + 1;
    rows.push({
      session,
      round,
      inputTokens: r.prompt_tokens ?? 0,
      outputTokens: r.output_tokens ?? asked.outputTokens,
      cachedTokens: r.cached_local_tokens ?? 0,
      pod,
      arrivalS: microseconds(r.arrival_us / 1e6),
      firstTokenS: r.ttft_us === undefined ? null : microseconds((r.arrival_us + r.ttft_us) / 1e6),
      lastTokenS: r.e2e_us === undefined ? null : microseconds((r.arrival_us + r.e2e_us) / 1e6),
      fate: fateOf(s, result, r),
      preemptions: null
    });
  }
  const missing = [...wanted.keys()].filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`${s.id}: BLIS reported no row for ${missing.join(", ")}`);
  return {
    simulator: "blis",
    scenario: s.id,
    kvBlocksPerReplica: cluster.kv_capacity_tokens_per_replica / BLOCK_TOKENS,
    requests: sortRows(rows),
    preemptions: cluster.preemptions,
    requestsPerPod
  };
}

export interface BlisRun {
  reference: Reference;
}

/** Version string of the router fork, as `blis router-configs` prints it on its first line. */
function routerModule(binary: string): string {
  return execFileSync(binary, ["router-configs"], { encoding: "utf8" }).split("\n")[0]!.trim();
}

/**
 * Write the scenario's BLIS input to a scratch directory, run `blis replay`, and reduce the Result.
 * Throws with BLIS's own message when it refuses the scenario.
 */
export function runBlis(s: Scenario, binary: string, keep?: string): BlisRun {
  const input = toBlis(s);
  const dir = keep ?? mkdtempSync(path.join(tmpdir(), `blis-${s.id}-`));
  mkdirSync(dir, { recursive: true });
  try {
    for (const [file, text] of Object.entries(input.files)) {
      const target = path.join(dir, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    try {
      execFileSync(binary, input.args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error(`${s.id}: blis replay failed:\n${err.stderr ?? err.message}`);
    }
    const result = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")) as Result;
    const provenance: BlisProvenance = {
      commit: lockedCommit(),
      catalogHash: result.data.catalog.hash,
      registryHash: result.data.registry.hash,
      engineVersion: result.engine.version,
      routerModule: routerModule(binary)
    };
    return { reference: { scenario: s.id, inputHash: input.inputHash, blis: provenance, record: reduceBlis(s, result) } };
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}
