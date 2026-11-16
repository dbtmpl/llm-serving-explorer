/**
 * The neutral scenario: one description of a deployment, a workload and the checks to run on it,
 * which neither the model nor any reference owns. `translate/` turns it into the TypeScript model's
 * input and each reference (`refs/<id>/`) turns it into its own.
 *
 * Format: YAML, so that every tolerance can carry its justification as plain text next to it and
 * the request lists stay readable. (JSON has no comments; a TypeScript module would be code, not
 * data, and could not be handed to a reviewer who does not read TypeScript.) The only cost is one
 * dev dependency, `yaml`.
 *
 * Four kinds of check, strictest first:
 *
 * - `exact`: integers and decisions that must be equal.
 * - `capacity`: a size both sides derive from estimates (KV blocks per replica), within a relative
 *   tolerance chosen on principle, not to fit.
 * - `calibrated`: a timing or rate that must agree within a relative tolerance, after the
 *   TypeScript model's free timing parameters have been fitted to BLIS on other scenarios
 *   (`conformance/calibration/`). The TypeScript run of a scenario with a calibrated check uses
 *   the fitted values.
 * - `directional`: the same intervention (one arm of the scenario against another) moves the same
 *   metric in the same direction by a similar factor in both simulators.
 *
 * A scenario with `arms` runs once per arm, each arm being the scenario with a few fields replaced.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export const CONFORMANCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIO_DIR = path.join(CONFORMANCE_DIR, "scenarios");
export const REFERENCE_DIR = path.join(CONFORMANCE_DIR, "reference");

/** Where reference `ref` keeps its committed record of scenario `scenario`. */
export const referenceFile = (ref: string, scenario: string): string => path.join(REFERENCE_DIR, ref, `${scenario}.json`);

/** The name a known difference or a gap uses for the TypeScript model, and for the span of several references. */
export const TYPESCRIPT = "typescript";
export const SPAN = "span";

/** KV block size in tokens. Both simulators use vLLM's default; the scenario states it so a mismatch fails loudly. */
export const BLOCK_TOKENS = 16;

/** How long a replica added by an autoscaler takes to load, seconds. The same number is given to both simulators. */
export const AUTOSCALE_LOAD_S = 5;

/** The name of the only arm of a scenario that declares none. */
export const MAIN_ARM = "main";

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

/** Quantities an exact check may compare. Each is a record of named scalars, so a difference names where it is. */
export type ExactQuantity =
  | "kv_blocks_per_replica"
  | "prefix_cached_tokens"
  | "routed_pod"
  | "requests_per_pod"
  | "session_pod_changes"
  | "preemptions"
  | "request_fate"
  | "prefill_pool_requests";

export type Subset = "all" | "calibration" | "held-out";

/** Timings and rates a calibrated or directional check may use (see `record.ts`, `metricOf`). */
export const METRICS = [
  "ttft_mean_s",
  "ttft_p50_s",
  "ttft_p99_s",
  "tpot_mean_s",
  "e2e_mean_s",
  "e2e_p50_s",
  "e2e_p99_s",
  "tpot_p50_s",
  "tpot_p99_s",
  "throughput_tokens_per_s",
  "kv_transfer_mean_s",
  "spec_tokens_per_step",
  "followup_ttft_mean_s",
  "prefix_hit_rate",
  "cpu_tier_hit_rate",
  "preemptions",
  "peak_replicas",
  "completed"
] as const;
export type Metric = (typeof METRICS)[number];

export type Scalar = number | string | boolean | null;

/** The keys that differ, each with the value every party has there: `typescript` and the reference's id (or, for a gap, each reference's id). */
export type Differences = Record<string, Record<string, Scalar>>;

export interface KnownDifference {
  /** Three to twenty words: why, for the table of failing checks in the README. */
  cause: string;
  /** True when the two sides follow different rules on purpose (round robin, the autoscalers), so there is no miss to measure against a tolerance. */
  byDesign: boolean;
  /**
   * Which comparison this records: a reference's id (the TypeScript model against that reference),
   * or `span` (the model against the range of references that disagree with each other).
   */
  reference: string;
  /** What each side does and why they differ: a finding, not a shrug. */
  reason: string;
  /** Exactly the keys that differ, with each side's value. The test fails if this drifts. */
  differences: Differences;
}

/** Two references that both cover a check and disagree with each other: the gap, explained. Asserted exactly like a known difference. */
export interface ReferenceGap {
  reason: string;
  differences: Differences;
}

interface CheckBase {
  id: string;
  /** What the check shows, in one sentence. */
  claim: string;
  /** One line: why this standard (equal, this relative tolerance, this factor band) is the right one. Written before the first run. */
  tolerance: string;
  /**
   * Which timing parameters the TypeScript model runs this check with: the site's `defaults`, or the
   * ones `fitted` to the reference. Unstated: `fitted` where the scenario has a calibrated or
   * directional check, `defaults` otherwise (the BLIS scenarios, where every timing check is held out).
   */
  params?: "defaults" | "fitted";
  /**
   * Which requests the check's metrics are computed over: `all`, the `calibration` requests (the
   * first `split.calibrationRequests` by arrival) or the `held-out` rest. A check on the held-out
   * requests with `params: fitted` tests a fit made on the others.
   */
  subset?: Subset;
  /**
   * The references this check applies to. Unstated: every reference that supports the scenario's
   * model, GPU and mechanisms and can state the check's quantity (`refs/reference.ts`, `checkReferences`).
   */
  references?: string[];
  /** One record per comparison that does not hold as stated. */
  knownDifferences: KnownDifference[];
  referenceGap?: ReferenceGap;
}

export interface ExactCheck extends CheckBase {
  kind: "exact";
  quantity: ExactQuantity;
}

/** Quantities a capacity check may compare: one number per run that both sides derive from estimates. */
export const CAPACITY_QUANTITIES = ["kv_blocks_per_replica"] as const;
export type CapacityQuantity = (typeof CAPACITY_QUANTITIES)[number];

export interface CapacityCheck extends CheckBase {
  kind: "capacity";
  quantity: CapacityQuantity;
  /** Largest allowed |typescript - reference| / reference. */
  relTol: number;
}

export interface CalibratedCheck extends CheckBase {
  kind: "calibrated";
  metric: Metric;
  /** Largest allowed |typescript − blis| / blis. */
  relTol: number;
  /** Arm to compare; defaults to the only one. */
  arm: string;
}

export interface DirectionalCheck extends CheckBase {
  kind: "directional";
  metric: Metric;
  /** The arm the intervention is measured from, and the arm it is applied in. */
  baseline: string;
  intervention: string;
  /** How the change is measured: `to / from` or `to − from`. */
  effect: "ratio" | "difference";
  /** Expected direction of the change, in both simulators. */
  direction: "increase" | "decrease";
  /** The two simulators' effects (typescript / blis) must lie in this band. */
  band: [number, number];
}

export type Check = ExactCheck | CapacityCheck | CalibratedCheck | DirectionalCheck;

/** Speculative decoding: K draft tokens per step, accepting `acceptanceLength` tokens per step on average (BLIS's own parameter). */
export interface SpeculativeSpec {
  k: number;
  /** Mean tokens produced per verification step, counting the bonus token; in [1, k + 1]. */
  acceptanceLength: number;
}

/** A prefill pool and a decode pool, and the routing threshold below which a prompt is prefilled on its decode replica. */
export interface DisaggSpec {
  prefillReplicas: number;
  decodeReplicas: number;
  /** Uncached prompt tokens above which a request goes through the prefill pool. */
  thresholdTokens: number;
}

/** Host DRAM per replica for KV that no longer fits in GPU memory. */
export interface OffloadSpec {
  /** Gigabytes (1e9 bytes) per replica. */
  cpuGB: number;
}

/** Request-driven scaling between `minReplicas` and `maxReplicas`. The two simulators' rules differ by design. */
export interface AutoscaleSpec {
  minReplicas: number;
  maxReplicas: number;
}

/** A constant-rate open-loop stream of identical single-turn requests, used where BLIS's `run` (not `replay`) is needed. */
export interface StreamSpec {
  ratePerS: number;
  count: number;
  promptTokens: number;
  outputTokens: number;
}

export interface Deployment {
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
  speculative?: SpeculativeSpec;
  disagg?: DisaggSpec;
  offload?: OffloadSpec;
  autoscale?: AutoscaleSpec;
  /** Set for a stream-driven scenario; `requests` is then the expansion of the stream. */
  stream?: StreamSpec;
}

export interface Scenario {
  id: string;
  title: string;
  /** `calibration`: the TypeScript model's timing parameters are fitted to this scenario's BLIS run. */
  role: "check" | "calibration";
  /**
   * The reference whose fit the TypeScript model's timing parameters come from when a check is
   * calibrated. Unstated: the only reference that covers the scenario.
   */
  fitReference?: string;
  /**
   * Fit the timing parameters to the reference's measurements of the first `calibrationRequests`
   * requests (by arrival) of the main arm, and check on the rest. For references that are measured
   * data, which has no separate calibration scenarios.
   */
  split?: { calibrationRequests: number };
  /**
   * The references allowed to answer this scenario. Unstated: every reference whose `supports` covers its model, GPU, mechanisms and arms.
   * A scenario that replays one reference's own workload or is built from the inputs of one simulator names the references it is for.
   */
  references?: string[];
  /** The deployments to run; one named `main` unless the scenario declares `arms`. */
  arms: Record<string, Deployment>;
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
const stringList = (file: string, v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string")) fail(file, `${what} must be a non-empty list of names`);
  return v as string[];
};
const obj = (file: string, v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(file, `${what} must be a mapping`);
  return v as Record<string, unknown>;
};

const EXACT: readonly ExactQuantity[] = ["prefix_cached_tokens", "routed_pod", "requests_per_pod", "session_pod_changes", "preemptions", "request_fate", "prefill_pool_requests"];

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

/** The requests of a stream: single-turn, one every 1 / rate seconds, the first at 1 / rate (as BLIS's constant arrival process places them). */
export function expandStream(s: StreamSpec): ScenarioRequest[] {
  return Array.from({ length: s.count }, (_, i) => ({ at: Math.round(((i + 1) / s.ratePerS) * 1e6) / 1e6, session: i + 1, round: 0, newTokens: s.promptTokens, outputTokens: s.outputTokens }));
}

/** Merge `over` into `base`, mapping merging recursively and everything else replacing. */
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) && typeof b === "object" && b !== null && !Array.isArray(b) ? merge(b as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

function deployment(file: string, raw: Record<string, unknown>): Deployment {
  const engine = obj(file, raw.engine, `"engine"`);
  if (engine.block_size !== BLOCK_TOKENS) fail(file, `engine.block_size must be ${BLOCK_TOKENS}: the TypeScript model fixes it`);
  const routing = str(file, raw, "routing") as RoutingPolicyName;
  if (!["round-robin", "least-loaded", "prefix-aware"].includes(routing)) fail(file, `unknown routing "${routing}"`);
  const d: Deployment = {
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
    requests: []
  };
  if (raw.stream !== undefined) {
    const s = obj(file, raw.stream, `"stream"`);
    d.stream = { ratePerS: num(file, s, "rate_per_s"), count: num(file, s, "count"), promptTokens: num(file, s, "prompt_tokens"), outputTokens: num(file, s, "output_tokens") };
    d.requests = expandStream(d.stream);
  } else d.requests = expand(file, raw);
  if (raw.speculative !== undefined) {
    const s = obj(file, raw.speculative, `"speculative"`);
    const spec = { k: num(file, s, "k"), acceptanceLength: num(file, s, "acceptance_length") };
    if (spec.acceptanceLength < 1 || spec.acceptanceLength > spec.k + 1) fail(file, `speculative.acceptance_length must be in [1, k + 1]`);
    d.speculative = spec;
  }
  if (raw.disagg !== undefined) {
    const s = obj(file, raw.disagg, `"disagg"`);
    d.disagg = { prefillReplicas: num(file, s, "prefill_replicas"), decodeReplicas: num(file, s, "decode_replicas"), thresholdTokens: num(file, s, "threshold_tokens") };
    if (d.disagg.prefillReplicas + d.disagg.decodeReplicas !== d.replicas) fail(file, `disagg replicas must add up to "replicas"`);
  }
  if (raw.offload !== undefined) d.offload = { cpuGB: num(file, obj(file, raw.offload, `"offload"`), "cpu_gb") };
  if (raw.autoscale !== undefined) {
    const s = obj(file, raw.autoscale, `"autoscale"`);
    d.autoscale = { minReplicas: num(file, s, "min_replicas"), maxReplicas: num(file, s, "max_replicas") };
  }
  return d;
}

function check(file: string, c: unknown, arms: string[]): Check {
  const o = obj(file, c, "a check");
  const base: CheckBase = { id: str(file, o, "id"), claim: str(file, o, "claim"), tolerance: str(file, o, "tolerance"), knownDifferences: [] };
  if (o.params !== undefined) {
    if (o.params !== "defaults" && o.params !== "fitted") fail(file, `check ${base.id}: params must be "defaults" or "fitted"`);
    base.params = o.params as "defaults" | "fitted";
  }
  if (o.subset !== undefined) {
    if (o.subset !== "all" && o.subset !== "calibration" && o.subset !== "held-out") fail(file, `check ${base.id}: subset must be "all", "calibration" or "held-out"`);
    base.subset = o.subset as Subset;
  }
  const references = o.references === undefined ? undefined : stringList(file, o.references, `check ${base.id}: "references"`);
  if (references) base.references = references;
  const differencesOf = (k: Record<string, unknown>, where: string): Differences => {
    const diffs = obj(file, k.differences, `${where}.differences`);
    const differences: Differences = {};
    for (const [key, v] of Object.entries(diffs)) differences[key] = obj(file, v, `difference ${key}`) as Record<string, Scalar>;
    if (!Object.keys(differences).length) fail(file, `check ${base.id}: ${where} lists no differences`);
    return differences;
  };
  const reasonOf = (k: Record<string, unknown>, where: string): string => {
    const reason = str(file, k, "reason");
    if (reason.length < 80) fail(file, `check ${base.id}: ${where} needs a concrete reason (what each side does and why they differ)`);
    return reason;
  };
  const known = o.known_difference === undefined ? [] : Array.isArray(o.known_difference) ? o.known_difference : [o.known_difference];
  for (const item of known) {
    const k = obj(file, item, "known_difference");
    const reference = str(file, k, "reference");
    if (base.knownDifferences.some((x) => x.reference === reference)) fail(file, `check ${base.id}: two known_difference records for "${reference}"`);
    const differences = differencesOf(k, "known_difference");
    for (const [key, v] of Object.entries(differences)) {
      const want = [TYPESCRIPT, reference === SPAN ? SPAN : reference].sort().join(",");
      if (Object.keys(v).sort().join(",") !== want) fail(file, `check ${base.id}: difference ${key} of the known_difference for "${reference}" must give the values of ${want.replace(",", " and ")}`);
    }
    const cause = str(file, k, "cause");
    if (cause.split(/\s+/).length > 24) fail(file, `check ${base.id}: the cause of a known_difference is a few words (the reason carries the explanation)`);
    base.knownDifferences.push({ reference, cause, byDesign: k.by_design === true, reason: reasonOf(k, "known_difference"), differences });
  }
  if (o.reference_gap !== undefined) {
    const k = obj(file, o.reference_gap, "reference_gap");
    base.referenceGap = { reason: reasonOf(k, "reference_gap"), differences: differencesOf(k, "reference_gap") };
  }
  const metric = (): Metric => {
    const m = str(file, o, "metric") as Metric;
    if (!METRICS.includes(m)) fail(file, `check ${base.id}: unknown metric "${m}"`);
    return m;
  };
  const arm = (key: string, fallback?: string): string => {
    const a = o[key] === undefined && fallback ? fallback : str(file, o, key);
    if (!arms.includes(a)) fail(file, `check ${base.id}: unknown arm "${a}" (arms: ${arms.join(", ")})`);
    return a;
  };
  switch (o.kind) {
    case "exact": {
      const quantity = str(file, o, "quantity") as ExactQuantity;
      if (!EXACT.includes(quantity)) fail(file, `unknown quantity "${quantity}"`);
      return { ...base, kind: "exact", quantity };
    }
    case "capacity": {
      const quantity = str(file, o, "quantity") as CapacityQuantity;
      if (!CAPACITY_QUANTITIES.includes(quantity)) fail(file, `check ${base.id}: "${quantity}" is not a capacity (capacities: ${CAPACITY_QUANTITIES.join(", ")}); integers and decisions use kind "exact"`);
      const relTol = num(file, o, "rel_tol");
      if (!(relTol > 0 && relTol < 1)) fail(file, `check ${base.id}: rel_tol must be in (0, 1)`);
      return { ...base, kind: "capacity", quantity, relTol };
    }
    case "calibrated": {
      const relTol = num(file, o, "rel_tol");
      if (!(relTol > 0 && relTol < 1)) fail(file, `check ${base.id}: rel_tol must be in (0, 1)`);
      return { ...base, kind: "calibrated", metric: metric(), relTol, arm: arm("arm", arms[0]) };
    }
    case "directional": {
      const band = o.band;
      if (!Array.isArray(band) || band.length !== 2 || !(typeof band[0] === "number" && typeof band[1] === "number" && band[0] > 0 && band[0] < band[1])) fail(file, `check ${base.id}: band must be [low, high] with 0 < low < high`);
      if (o.effect !== "ratio" && o.effect !== "difference") fail(file, `check ${base.id}: effect must be "ratio" or "difference"`);
      if (o.direction !== "increase" && o.direction !== "decrease") fail(file, `check ${base.id}: direction must be "increase" or "decrease"`);
      return { ...base, kind: "directional", metric: metric(), baseline: arm("baseline"), intervention: arm("intervention"), effect: o.effect as "ratio" | "difference", direction: o.direction as "increase" | "decrease", band: band as [number, number] };
    }
    default:
      return fail(file, `check ${base.id}: kind must be "exact", "capacity", "calibrated" or "directional"`);
  }
}

/** Read and validate one scenario file. */
export function parseScenario(file: string, text: string): Scenario {
  const raw = obj(file, parse(text), "the scenario");
  const id = str(file, raw, "id");
  if (path.basename(file, ".yaml") !== id) fail(file, `"id" (${id}) must equal the file name`);
  const role = raw.role === undefined ? "check" : raw.role;
  if (role !== "check" && role !== "calibration") fail(file, `role must be "check" or "calibration"`);
  const { arms: armsRaw, checks: checksRaw, id: _id, title: _title, role: _role, fit_reference: fitRaw, split: splitRaw, references: referencesRaw, ...baseRaw } = raw;
  const split = splitRaw === undefined ? undefined : { calibrationRequests: num(file, obj(file, splitRaw, `"split"`), "calibration_requests") };
  const fitReference = fitRaw === undefined ? undefined : str(file, { fit_reference: fitRaw }, "fit_reference");
  const references = referencesRaw === undefined ? undefined : stringList(file, referencesRaw, `"references"`);
  const arms: Record<string, Deployment> = {};
  if (armsRaw === undefined) arms[MAIN_ARM] = deployment(file, baseRaw);
  else
    for (const [name, over] of Object.entries(obj(file, armsRaw, `"arms"`)))
      arms[name] = deployment(file, merge(baseRaw, over === null ? {} : obj(file, over, `arm ${name}`)));
  if (!Array.isArray(checksRaw)) fail(file, `"checks" must be a list`);
  const checks = (checksRaw as unknown[]).map((c) => check(file, c, Object.keys(arms)));
  if (role === "check" && !checks.length) fail(file, `a scenario with role "check" needs at least one check`);
  if (role === "calibration" && checks.length) fail(file, `a calibration scenario states no checks: it is the data the fit uses`);
  return { id, title: str(file, raw, "title"), role: role as Scenario["role"], ...(fitReference ? { fitReference } : {}), ...(split ? { split } : {}), ...(references ? { references } : {}), arms, checks };
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

/** The arm a scenario without `arms` has. */
export const mainArm = (s: Scenario): Deployment => s.arms[MAIN_ARM] ?? fail(s.id, `the scenario has arms; name one`);

/** True when a check of the scenario is a timing check that is meant to run with fitted parameters unless it says otherwise. */
export const usesCalibration = (s: Scenario): boolean => s.checks.some((c) => c.kind === "calibrated" || c.kind === "directional");

/** The timing parameters a check runs with. */
export const paramsOf = (s: Scenario, c: Check): "defaults" | "fitted" => c.params ?? (usesCalibration(s) ? "fitted" : "defaults");

/** True when any check of the scenario runs with fitted parameters, so a fit to a reference must exist. */
export const needsFit = (s: Scenario): boolean => s.checks.some((c) => paramsOf(s, c) === "fitted");

/**
 * The (session, round) keys of the requests of a subset, by arrival order of the main arm. A subset
 * other than `all` needs the scenario's `split`.
 */
export function subsetKeys(s: Scenario, subset: Subset): Set<string> | null {
  if (subset === "all") return null;
  if (!s.split) throw new Error(`${s.id}: a check on the ${subset} requests needs "split: { calibration_requests }" in the scenario`);
  const rows = (s.arms[MAIN_ARM] ?? Object.values(s.arms)[0]!).requests.slice().sort((a, b) => a.at - b.at || a.session - b.session || a.round - b.round);
  const picked = subset === "calibration" ? rows.slice(0, s.split.calibrationRequests) : rows.slice(s.split.calibrationRequests);
  return new Set(picked.map((r) => `s${r.session}/r${r.round}`));
}
