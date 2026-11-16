/**
 * How far the model is from a reference, check by check, and the distribution of those distances.
 *
 * The count of checks that hold is a count of things the suite invented (a tolerance is a line drawn
 * by a person); the deviation is the underlying offset, and the headline of the parity summary is its
 * distribution. A deviation is defined for every check (`compare.ts`, `Deviation`):
 *
 * - a quantity or metric: the signed relative difference (model - reference) / reference;
 * - decisions (pod chosen, requests shed, cached tokens per request, discrete counts): the share of the individual values that differ,
 *   and for integers per row the largest relative difference;
 * - a directional check: the ratio of the two effects (model / reference), and whether both move the expected way.
 *
 * Groups, each check in exactly one (`groupOf`):
 *
 * - `capacity`: capacity and KV accounting: KV blocks per replica, prefix and host-tier hit rates.
 * - `decisions`: every `exact` check, and the counts `peak_replicas`, `completed`, `preemptions`.
 * - `timings_defaults`: the same, for a check that runs the model with the site's default parameters (`params: defaults`), no fit, so that the
 *   distance of the unfitted model from a reference is not pooled with the distance after a fit.
 * - `timings`: time to first token (mean, percentiles, follow-up), time per token, end to end, throughput, KV hand-over time, tokens per speculative step.
 * - `effects`: directional checks.
 *
 * For a distribution, a check's number is |relative deviation|, the share of decisions that differ, or |effect ratio - 1|.
 * A check whose deviation has no finite value (the reference is zero and the model is not) is `unbounded`: it counts in no
 * "within" bin and makes the maximum unbounded.
 */
import { absoluteDeviation, type Comparison, type Deviation, type Outcome } from "./compare.js";
import type { Check, Metric, Scalar } from "./scenario.js";

export const GROUPS = ["capacity", "decisions", "timings_defaults", "timings", "effects"] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_LABEL: Record<Group, string> = {
  capacity: "Capacity and KV accounting",
  decisions: "Decisions",
  timings_defaults: "Timings, default parameters (no fit)",
  timings: "Timings and rates (fitted, held out)",
  effects: "Directional effects"
};

/** The thresholds the distribution counts comparisons within, as fractions. */
export const THRESHOLDS = [0.01, 0.05, 0.1, 0.25] as const;

const KV_METRICS: readonly Metric[] = ["prefix_hit_rate", "cpu_tier_hit_rate"];
const DECISION_METRICS: readonly Metric[] = ["peak_replicas", "completed", "preemptions"];

export function groupOf(check: Check): Group {
  switch (check.kind) {
    case "capacity":
      return "capacity";
    case "exact":
      return "decisions";
    case "directional":
      return "effects";
    case "calibrated":
      return KV_METRICS.includes(check.metric) ? "capacity" : DECISION_METRICS.includes(check.metric) ? "decisions" : check.params === "defaults" ? "timings_defaults" : "timings";
  }
}

const METRIC_LABEL: Record<Metric, string> = {
  ttft_mean_s: "mean time to first token",
  ttft_p50_s: "median time to first token",
  ttft_p99_s: "99th percentile time to first token",
  tpot_mean_s: "mean time per output token",
  e2e_mean_s: "mean end-to-end time",
  e2e_p50_s: "median end-to-end time",
  e2e_p99_s: "99th percentile end-to-end time",
  tpot_p50_s: "median time per output token",
  tpot_p99_s: "99th percentile time per output token",
  throughput_tokens_per_s: "throughput",
  kv_transfer_mean_s: "mean KV hand-over time",
  spec_tokens_per_step: "tokens per speculative step",
  followup_ttft_mean_s: "mean time to first token of follow-up turns",
  prefix_hit_rate: "prefix-cache hit rate",
  cpu_tier_hit_rate: "host-tier hit rate",
  preemptions: "preemptions",
  peak_replicas: "replicas used",
  completed: "requests completed"
};

const QUANTITY_LABEL: Record<string, string> = {
  kv_blocks_per_replica: "KV blocks per replica",
  prefix_cached_tokens: "cached prefix tokens per request",
  routed_pod: "pod chosen per request",
  requests_per_pod: "requests per pod",
  session_pod_changes: "pod changes per session",
  preemptions: "preemptions",
  request_fate: "fate of each request",
  prefill_pool_requests: "requests sent to the prefill pool"
};

/** What a check compares, in words. */
export function whatOf(check: Check): string {
  if (check.kind === "exact" || check.kind === "capacity") return QUANTITY_LABEL[check.quantity]!;
  return METRIC_LABEL[check.metric] + (check.kind === "directional" ? `, ${check.baseline} to ${check.intervention}` : "");
}

const thousands = (x: number, digits = 0): string => x.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const sig = (x: number, n = 3): number => Number(x.toPrecision(n));

/** A value of a metric as people read it: milliseconds below ten seconds, seconds above, tokens per second, percent for rates. */
export function formatMetric(metric: Metric, v: number | null): string {
  if (v === null) return "none";
  if (metric.endsWith("_s") && metric !== "throughput_tokens_per_s") return v < 10 ? `${thousands(sig(v * 1000))} ms` : `${sig(v, 4)} s`;
  if (metric === "throughput_tokens_per_s") return `${thousands(Math.round(v))} tok/s`;
  if (metric.endsWith("hit_rate")) return `${thousands(v * 100, 1)}%`;
  return String(sig(v, 4));
}

const percent = (x: number): string => {
  const p = x * 100;
  return `${p >= 0 ? "+" : "-"}${Math.abs(p) < 0.1 && p !== 0 ? Math.abs(p).toPrecision(1) : Math.abs(p).toFixed(1)}%`;
};

export function deviationText(d: Deviation): string {
  switch (d.kind) {
    case "relative":
      return d.value === null ? "unbounded (reference is zero)" : percent(d.value);
    case "decisions":
      return `${d.differing} of ${d.total} differ (${(d.share * 100).toFixed(0)}%)${d.maxRelative ? `; largest ${(d.maxRelative * 100).toFixed(0)}%` : ""}`;
    case "effect":
      return `${d.ratio === null ? "unbounded (reference effect is zero)" : `ratio ${sig(d.ratio)}`}${d.directionMatches ? "" : ", direction differs"}`;
  }
}

export function toleranceText(check: Check): string {
  switch (check.kind) {
    case "exact":
      return "equal";
    case "capacity":
    case "calibrated":
      return `${check.relTol * 100}%`;
    case "directional":
      return `effect ratio ${check.band[0]} to ${check.band[1]}`;
  }
}

/** The values the two sides had, as people read them. For per-request decisions, which do not fit in a cell, a dash. */
function sides(o: Outcome): { ours: string; reference: string } {
  const c = o.check;
  if (c.kind === "capacity") return { ours: `${thousands(o.typescript.value as number)} blocks`, reference: `${thousands(o.referenceValues.value as number)} blocks` };
  if (c.kind === "calibrated") return { ours: formatMetric(c.metric, o.typescript.value as number | null), reference: formatMetric(c.metric, o.referenceValues.value as number | null) };
  if (c.kind === "directional") {
    const show = (e: Scalar): string => (e === null || typeof e !== "number" ? "none" : c.effect === "ratio" ? `${sig(e * 100, 2)}% of baseline` : formatMetric(c.metric, e));
    return { ours: show(o.typescript.effect!), reference: show(o.referenceValues.effect!) };
  }
  if (c.quantity === "requests_per_pod") return { ours: Object.values(o.typescript).join("/"), reference: Object.values(o.referenceValues).join("/") };
  if (Object.keys(o.typescript).length === 1 && "value" in o.typescript) return { ours: String(o.typescript.value), reference: String(o.referenceValues.value) };
  return { ours: "per request", reference: "per request" };
}

/** One row of the report, the summary and the README's table of failing checks. */
export interface CheckRow {
  scenario: string;
  check: string;
  reference: string;
  kind: Check["kind"];
  group: Group;
  what: string;
  ours: string;
  theirs: string;
  deviation: Deviation;
  /** The deviation as one non-negative number (`absoluteDeviation`); null when unbounded. */
  absDeviation: number | null;
  deviationText: string;
  tolerance: string;
  holds: boolean;
  /** Only when it does not hold. */
  cause: string | null;
  byDesign: boolean;
}

export function rowOf(scenario: string, c: Comparison, reference: string): CheckRow {
  const o = c.perReference[reference]!;
  const known = c.check.knownDifferences.find((k) => k.reference === reference);
  const holds = !Object.keys(o.differences).length;
  const { ours, reference: theirs } = sides(o);
  const abs = absoluteDeviation(o.deviation);
  return {
    scenario,
    check: c.check.id,
    reference,
    kind: c.check.kind,
    group: groupOf(c.check),
    what: whatOf(c.check),
    ours,
    theirs,
    deviation: o.deviation,
    absDeviation: abs === null ? null : sig(abs, 4),
    deviationText: deviationText(o.deviation),
    tolerance: toleranceText(c.check),
    holds,
    cause: holds ? null : (known?.cause ?? null),
    byDesign: !holds && (known?.byDesign ?? false)
  };
}

export interface Distribution {
  /** Comparisons in the group. */
  n: number;
  /** Median and maximum of the absolute deviations; the maximum is null when any is unbounded. */
  median: number | null;
  max: number | null;
  unbounded: number;
  /** How many have |deviation| at or below each threshold, keyed "1", "5", "10", "25" (percent). */
  within: Record<string, number>;
}

export function distributionOf(values: (number | null)[]): Distribution {
  const bounded = values.filter((v): v is number => v !== null);
  const sorted = values.map((v) => v ?? Infinity).sort((a, b) => a - b);
  const mid = sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.ceil((sorted.length - 1) / 2)]!) / 2 : null;
  return {
    n: values.length,
    median: mid === null || !Number.isFinite(mid) ? null : sig(mid, 4),
    max: bounded.length < values.length ? null : bounded.length ? sig(Math.max(...bounded), 4) : null,
    unbounded: values.length - bounded.length,
    within: Object.fromEntries(THRESHOLDS.map((t) => [String(t * 100), bounded.filter((v) => v <= t + 1e-12).length]))
  };
}

export interface DeviationSummary {
  definition: string;
  groups: Record<Group, Distribution>;
  /** All groups pooled: one number per check. */
  overall: Distribution;
  /** The deviation direction matters for the effects: how many directional checks move the other way in one of the two. */
  directionMismatches: number;
}

export const DEVIATION_DEFINITION =
  "One deviation per check the reference covers: |model - reference| / reference for a quantity or metric, the share of individual decisions that differ for exact checks, |effect ratio - 1| for directional checks. Medians and maxima are over those numbers; 'within x%' counts the checks at or below x%.";

export function summariseDeviations(rows: CheckRow[]): DeviationSummary {
  const groups = Object.fromEntries(GROUPS.map((g) => [g, distributionOf(rows.filter((r) => r.group === g).map((r) => r.absDeviation))])) as Record<Group, Distribution>;
  return {
    definition: DEVIATION_DEFINITION,
    groups,
    overall: distributionOf(rows.map((r) => r.absDeviation)),
    directionMismatches: rows.filter((r) => r.deviation.kind === "effect" && !r.deviation.directionMatches).length
  };
}
