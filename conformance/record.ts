/**
 * The one comparable record both simulators are reduced to.
 *
 * Per-request rows keyed by (session, round), plus the few numbers that belong to a whole run. Times
 * are carried for the record and for later phases; phase 1 compares none of them.
 */
import type { Metric, Scalar } from "./scenario.js";

export type Fate = "completed" | "shed" | "unservable" | "timed_out" | "other";

export interface RequestRow {
  session: number;
  round: number;
  /** Whole prompt, history included. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the prefix cache; null when the simulator does not report it. */
  cachedTokens: number | null;
  /** Zero-based index of the replica that served it; null when it never reached one. */
  pod: number | null;
  arrivalS: number;
  firstTokenS: number | null;
  lastTokenS: number | null;
  fate: Fate;
  /** Times this request lost its KV memory and was recomputed; null when not reported per request. */
  preemptions: number | null;
}

export interface Reduced {
  simulator: "typescript" | "blis";
  scenario: string;
  /** KV blocks one replica holds, of 16 tokens each. */
  kvBlocksPerReplica: number;
  requests: RequestRow[];
  /** Preemptions over the whole run. */
  preemptions: number;
  /** Per replica: requests it received, indexed by replica. */
  requestsPerPod: number[];
  /** Run-level numbers a simulator reports beyond the rows; null where it reports none. */
  aggregates: Aggregates;
}

export interface Aggregates {
  /** Share of prompt tokens served from the GPU prefix cache. */
  prefixHitRate: number | null;
  /** Share of prompt tokens served from host memory. */
  cpuTierHitRate: number | null;
  /** Mean seconds of a prefill-to-decode KV hand-over. */
  kvTransferMeanS: number | null;
  /** Tokens one sequence gains per decode step under speculative decoding. */
  specTokensPerStep: number | null;
  /** Requests sent through the prefill pool. */
  prefillPoolRequests: number | null;
  /** Replicas that served at least one request. */
  peakReplicas: number | null;
}

export const NO_AGGREGATES: Aggregates = { prefixHitRate: null, cpuTierHitRate: null, kvTransferMeanS: null, specTokensPerStep: null, prefillPoolRequests: null, peakReplicas: null };

export interface BlisProvenance {
  /** Commit of inference-sim named by `conformance/blis.lock`. */
  commit: string;
  /** `data.catalog.hash` and `data.registry.hash` of the BLIS Result. */
  catalogHash: string;
  registryHash: string;
  /** `engine.version` of the Result: the vLLM release BLIS follows. */
  engineVersion: string;
  /** Router fork version printed by `blis router-configs`. */
  routerModule: string;
}

/** What is committed under `conformance/reference/`. */
export interface Reference {
  scenario: string;
  /** Hash of the BLIS input the translators produced for every arm; a mismatch means the scenario changed since. */
  inputHash: string;
  blis: BlisProvenance;
  /** The reduced BLIS record of each arm of the scenario. */
  records: Record<string, Reduced>;
}

export const requestKey = (r: { session: number; round: number }): string => `s${r.session}/r${r.round}`;

export function sortRows(rows: RequestRow[]): RequestRow[] {
  return rows.slice().sort((a, b) => a.session - b.session || a.round - b.round);
}

/** Round to microseconds so that floating-point noise never reaches a committed file. */
export const microseconds = (seconds: number): number => Math.round(seconds * 1e6) / 1e6;

/**
 * A quantity as a record of named scalars. Comparing two simulators is then comparing two records,
 * and a difference names exactly where it is.
 */
export function quantityOf(r: Reduced, name: string): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  switch (name) {
    case "kv_blocks_per_replica":
      out.value = r.kvBlocksPerReplica;
      break;
    case "prefix_cached_tokens":
      for (const row of r.requests) out[requestKey(row)] = row.cachedTokens;
      break;
    case "routed_pod": {
      // replicas are interchangeable, so only which requests share one matters: name them by first use
      const label = new Map<number, number>();
      for (const row of r.requests.slice().sort((a, b) => a.arrivalS - b.arrivalS || a.session - b.session || a.round - b.round)) {
        if (row.pod === null) continue;
        if (!label.has(row.pod)) label.set(row.pod, label.size);
      }
      for (const row of r.requests) out[requestKey(row)] = row.pod === null ? null : label.get(row.pod)!;
      break;
    }
    case "requests_per_pod": {
      const sorted = r.requestsPerPod.slice().sort((a, b) => b - a);
      sorted.forEach((n, i) => (out[`rank${i}`] = n));
      break;
    }
    case "session_pod_changes": {
      const last = new Map<number, number>();
      const changes = new Map<number, number>();
      for (const row of r.requests) {
        if (row.pod === null) continue;
        changes.set(row.session, (changes.get(row.session) ?? 0) + (last.has(row.session) && last.get(row.session) !== row.pod ? 1 : 0));
        last.set(row.session, row.pod);
      }
      for (const [s, n] of changes) out[`s${s}`] = n;
      break;
    }
    case "preemptions":
      out.value = r.preemptions;
      break;
    case "request_fate":
      for (const row of r.requests) out[requestKey(row)] = row.fate;
      break;
    case "prefill_pool_requests":
      out.value = r.aggregates.prefillPoolRequests;
      break;
    default:
      throw new Error(`unknown quantity ${name}`);
  }
  return out;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Linear-interpolated percentile (numpy's default), as BLIS reports its own. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const v = xs.slice().sort((a, b) => a - b);
  const at = (p / 100) * (v.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return v[lo]! + (v[hi]! - v[lo]!) * (at - lo);
}

/**
 * A timing or rate of a whole run, computed from the rows so both simulators are measured the same
 * way: time to first token and end to end are from arrival; time per output token is
 * `(last - first) / (output - 1)` per request, averaged; throughput is generated tokens over the
 * time from the first arrival to the last completion.
 */
export function metricOf(r: Reduced, metric: Metric): number | null {
  const done = r.requests.filter((x) => x.fate === "completed" && x.firstTokenS !== null && x.lastTokenS !== null);
  const ttft = done.map((x) => x.firstTokenS! - x.arrivalS);
  switch (metric) {
    case "ttft_mean_s":
      return mean(ttft);
    case "ttft_p50_s":
      return percentile(ttft, 50);
    case "ttft_p99_s":
      return percentile(ttft, 99);
    case "tpot_mean_s":
      return mean(done.filter((x) => x.outputTokens > 1).map((x) => (x.lastTokenS! - x.firstTokenS!) / (x.outputTokens - 1)));
    case "e2e_mean_s":
      return mean(done.map((x) => x.lastTokenS! - x.arrivalS));
    case "e2e_p50_s":
      return percentile(
        done.map((x) => x.lastTokenS! - x.arrivalS),
        50
      );
    case "throughput_tokens_per_s": {
      if (!done.length) return null;
      const span = Math.max(...done.map((x) => x.lastTokenS!)) - Math.min(...r.requests.map((x) => x.arrivalS));
      return done.reduce((a, x) => a + x.outputTokens, 0) / span;
    }
    case "followup_ttft_mean_s":
      return mean(done.filter((x) => x.round > 0).map((x) => x.firstTokenS! - x.arrivalS));
    case "completed":
      return done.length;
    case "preemptions":
      return r.preemptions;
    case "kv_transfer_mean_s":
      return r.aggregates.kvTransferMeanS;
    case "spec_tokens_per_step":
      return r.aggregates.specTokensPerStep;
    case "prefix_hit_rate":
      return r.aggregates.prefixHitRate;
    case "cpu_tier_hit_rate":
      return r.aggregates.cpuTierHitRate;
    case "peak_replicas":
      return r.aggregates.peakReplicas;
  }
}
