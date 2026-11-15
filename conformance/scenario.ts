/**
 * The neutral scenario: one description of a deployment, a workload and the checks to run on it,
 * which neither simulator owns. `translate/` turns it into each simulator's own input.
 *
 * Format: YAML, so that every tolerance can carry its justification as plain text next to it and
 * the request lists stay readable. (JSON has no comments; a TypeScript module would be code, not
 * data, and could not be handed to a reviewer who does not read TypeScript.) The only cost is one
 * dev dependency, `yaml`.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const CONFORMANCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIO_DIR = path.join(CONFORMANCE_DIR, "scenarios");
export const REFERENCE_DIR = path.join(CONFORMANCE_DIR, "reference");

/** KV block size in tokens. Both simulators use vLLM's default; the scenario states it so a mismatch fails loudly. */
export const BLOCK_TOKENS = 16;

export type RoutingPolicyName = "round-robin" | "least-loaded" | "prefix-aware";

export interface ScenarioRequest {
  /** Seconds from the start of the run. */
  at: number;
  session: number;
  round: number;
  /** Tokens added in this round (the whole prompt in round 0). */
  newTokens: number;
  outputTokens: number;
}

/** A conversation written compactly: round r is sent at `at + r · gapS`. */
interface SessionSpec {
  id: number;
  at: number;
  gapS: number;
  /** `[newTokens, outputTokens]` per round. */
  turns: [number, number][];
}

/** Quantities a check may compare. Each is a record of named scalars, so a difference names where it is. */
export type Quantity =
  | "kv_blocks_per_replica"
  | "prefix_cached_tokens"
  | "routed_pod"
  | "requests_per_pod"
  | "session_pod_changes"
  | "preemptions"
  | "request_fate";

export interface KnownDifference {
  /** What each simulator does and why they differ: a finding, not a shrug. */
  reason: string;
  /** Exactly the keys that differ, with each simulator's value. The test fails if this drifts. */
  differences: Record<string, { typescript: Scalar; blis: Scalar }>;
}

export type Scalar = number | string | boolean | null;

export interface Check {
  id: string;
  /** What the check shows, in one sentence. */
  claim: string;
  kind: "exact";
  quantity: Quantity;
  /** One line: why this quantity has to be equal and not merely close. */
  tolerance: string;
  knownDifference?: KnownDifference;
}

export interface Scenario {
  id: string;
  title: string;
  /** Neutral names, mapped to each simulator's catalogue in `translate/names.ts`. */
  model: string;
  gpu: string;
  engine: {
    tp: number;
    gpuMemoryUtilisation: number;
    maxNumSeqs: number;
    maxNumBatchedTokens: number;
    prefixCaching: boolean;
    /** Longest context the engine accepts. Only BLIS asks for it (it refuses a pool that cannot hold one such sequence); the TypeScript model has no limit. */
    maxModelLen?: number;
  };
  replicas: number;
  routing: RoutingPolicyName;
  /** Seconds a request may wait at the router before it is shed (0 = never). */
  queueDeadlineS: number;
  requests: ScenarioRequest[];
  checks: Check[];
}

const fail = (file: string, msg: string): never => {
  throw new Error(`${file}: ${msg}`);
};

const num = (file: string, o: Record<string, unknown>, key: string): number => {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) fail(file, `"${key}" must be a number`);
  return v as number;
};
const str = (file: string, o: Record<string, unknown>, key: string): string => {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) fail(file, `"${key}" must be a non-empty string`);
  return v as string;
};
const obj = (file: string, v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(file, `${what} must be a mapping`);
  return v as Record<string, unknown>;
};

const QUANTITIES: readonly Quantity[] = ["kv_blocks_per_replica", "prefix_cached_tokens", "routed_pod", "requests_per_pod", "session_pod_changes", "preemptions", "request_fate"];

function expand(file: string, raw: Record<string, unknown>): ScenarioRequest[] {
  const out: ScenarioRequest[] = [];
  const list = raw.requests;
  if (!Array.isArray(list) || !list.length) return fail(file, `"requests" must be a non-empty list of conversations`);
  for (const item of list) {
    const o = obj(file, item, "a request entry");
    if (Array.isArray(o.turns)) {
      const s: SessionSpec = { id: num(file, o, "session"), at: num(file, o, "at"), gapS: o.gap_s === undefined ? 0 : num(file, o, "gap_s"), turns: o.turns as [number, number][] };
      s.turns.forEach((t, round) => {
        if (!Array.isArray(t) || t.length !== 2) fail(file, `session ${s.id}: each turn is [newTokens, outputTokens]`);
        out.push({ at: s.at + round * s.gapS, session: s.id, round, newTokens: t[0]!, outputTokens: t[1]! });
      });
    } else fail(file, `a request entry needs "turns: [[newTokens, outputTokens], ...]"`);
  }
  return out.sort((a, b) => a.at - b.at || a.session - b.session || a.round - b.round);
}

/** Read and validate one scenario file. */
export function parseScenario(file: string, text: string): Scenario {
  const raw = obj(file, parse(text), "the scenario");
  const engine = obj(file, raw.engine, `"engine"`);
  const id = str(file, raw, "id");
  if (path.basename(file, ".yaml") !== id) fail(file, `"id" (${id}) must equal the file name`);
  if (engine.block_size !== BLOCK_TOKENS) fail(file, `engine.block_size must be ${BLOCK_TOKENS}: the TypeScript model fixes it`);
  const routing = str(file, raw, "routing") as RoutingPolicyName;
  if (!["round-robin", "least-loaded", "prefix-aware"].includes(routing)) fail(file, `unknown routing "${routing}"`);
  const checksRaw = raw.checks;
  if (!Array.isArray(checksRaw) || !checksRaw.length) fail(file, `"checks" must be a non-empty list`);
  const checks = (checksRaw as unknown[]).map((c): Check => {
    const o = obj(file, c, "a check");
    const quantity = str(file, o, "quantity") as Quantity;
    if (!QUANTITIES.includes(quantity)) fail(file, `unknown quantity "${quantity}"`);
    if (o.kind !== "exact") fail(file, `check ${String(o.id)}: only kind "exact" exists in this phase`);
    const check: Check = { id: str(file, o, "id"), claim: str(file, o, "claim"), kind: "exact", quantity, tolerance: str(file, o, "tolerance") };
    if (o.known_difference !== undefined) {
      const k = obj(file, o.known_difference, "known_difference");
      const reason = str(file, k, "reason");
      if (reason.length < 80) fail(file, `check ${check.id}: a known_difference needs a concrete reason (what each simulator does and why they differ)`);
      const diffs = obj(file, k.differences, "known_difference.differences");
      const differences: KnownDifference["differences"] = {};
      for (const [key, v] of Object.entries(diffs)) {
        const d = obj(file, v, `difference ${key}`);
        differences[key] = { typescript: d.typescript as Scalar, blis: d.blis as Scalar };
      }
      if (!Object.keys(differences).length) fail(file, `check ${check.id}: known_difference lists no differences`);
      check.knownDifference = { reason, differences };
    }
    return check;
  });
  return {
    id,
    title: str(file, raw, "title"),
    model: str(file, raw, "model"),
    gpu: str(file, raw, "gpu"),
    engine: {
      tp: num(file, engine, "tp"),
      gpuMemoryUtilisation: num(file, engine, "gpu_memory_utilisation"),
      maxNumSeqs: num(file, engine, "max_num_seqs"),
      maxNumBatchedTokens: num(file, engine, "max_num_batched_tokens"),
      prefixCaching: engine.prefix_caching !== false,
      ...(engine.max_model_len === undefined ? {} : { maxModelLen: num(file, engine, "max_model_len") })
    },
    replicas: num(file, raw, "replicas"),
    routing,
    queueDeadlineS: raw.queue_deadline_s === undefined ? 0 : num(file, raw, "queue_deadline_s"),
    requests: expand(file, raw),
    checks
  };
}

export function loadScenario(id: string): Scenario {
  const file = path.join(SCENARIO_DIR, `${id}.yaml`);
  return parseScenario(file, readFileSync(file, "utf8"));
}

/** Every scenario in `conformance/scenarios/`, by id. */
export function scenarioIds(): string[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => path.basename(f, ".yaml"))
    .sort();
}
