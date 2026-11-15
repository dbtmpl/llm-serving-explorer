/**
 * The one comparable record both simulators are reduced to.
 *
 * Per-request rows keyed by (session, round), plus the few numbers that belong to a whole run. Times
 * are carried for the record and for later phases; phase 1 compares none of them.
 */
import type { Scalar } from "./scenario.js";

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
}

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
  /** Hash of the BLIS input the translators produced; a mismatch means the scenario changed since. */
  inputHash: string;
  blis: BlisProvenance;
  record: Reduced;
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
    default:
      throw new Error(`unknown quantity ${name}`);
  }
  return out;
}
