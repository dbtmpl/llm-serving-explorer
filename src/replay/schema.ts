/**
 * The replay file: one BLIS run of a fixed scenario, reduced to what the site animates.
 *
 * `replay/generate.ts` writes it from the pinned BLIS (`pnpm replay:build`), the adapter in
 * `adapter.ts` plays it, and `parseReplay` is the one place that says what a valid file is. Times
 * are seconds on BLIS's clock (the run starts at 0). Nothing here is computed by the TypeScript
 * model: every number is something BLIS reported, except the three marked "derived".
 */

export const REPLAY_SCHEMA = 1;

/** Where the replay files are served from, relative to the site root. */
export const REPLAY_DIR = "replay";

/** What the scenario runs on, in BLIS's terms. */
export interface ReplayParams {
  /** Neutral model name, see `MODEL_IDS` in `adapter.ts` for the catalogue entry that draws it. */
  model: string;
  gpu: string;
  /** GPUs per pod (tensor parallelism). */
  tp: number;
  /** Pods (BLIS "instances"). */
  replicas: number;
  routing: "prefix-aware" | "least-loaded" | "round-robin";
  maxNumSeqs: number;
  maxNumBatchedTokens: number;
  gpuMemoryUtilisation: number;
  prefixCaching: boolean;
  /** Seconds a request may wait at the router before it is shed; 0 = never. */
  queueDeadlineS: number;
  /** KV blocks of one pod, as BLIS sized the pool. */
  kvBlocksPerReplica: number;
  /** Tokens per KV block. */
  blockTokens: number;
}

export interface ReplayBlis {
  /** Full commit hash of inference-sim that produced the run (conformance/refs/blis/lock). */
  commit: string;
  /** The vLLM release BLIS follows. */
  engineVersion: string;
  /** Version of the llm-d router fork inside BLIS. */
  routerModule: string;
  catalogHash: string;
  registryHash: string;
}

/** One scoring plugin of the router and its weight in the sum. */
export interface ReplayScorer {
  name: string;
  weight: number;
}

export type ReplayFate = "completed" | "shed" | "dropped";

export interface ReplayRequest {
  /** Index in arrival order. */
  id: number;
  session: number;
  round: number;
  /** Arrival at the gateway. */
  arrival: number;
  /** Whole prompt, history included. */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens BLIS served from the prefix cache. */
  cachedTokens: number;
  fate: ReplayFate;
  /** Pod index the router picked; null when the request never reached one. */
  pod: number | null;
  /** When the router sent it to the pod: arrival plus the time it was held at the router. */
  dispatch: number | null;
  /**
   * When the engine first scheduled it: arrival plus BLIS's scheduling delay. BLIS reports the time
   * of the last scheduling, so for a preempted request (see `resumedAt`) the first one is not
   * reported and this is `dispatch`.
   */
  start: number | null;
  /** Time of the first output token (arrival + BLIS's TTFT). */
  firstToken: number | null;
  /** Time of the last output token (arrival + BLIS's end-to-end time). */
  lastToken: number | null;
  /**
   * Set when the engine preempted the request and later scheduled it again: BLIS's scheduling
   * delay then lands after the first token. The time it was scheduled again (reported by BLIS).
   */
  resumedAt: number | null;
  /**
   * Derived: when the preemption happened, found from the step in the pod's waiting-requests series
   * (to within one series bin). BLIS counts preemptions but does not time them. Null when the series
   * does not show it unambiguously.
   */
  preemptedAt: number | null;
  /** Derived: when a shed request left the router, arrival plus the queue deadline (BLIS reports the drop, not its time). */
  droppedAt: number | null;
  /**
   * The router's scores for this decision: one list per pod, in the order of `scorers`, each the
   * plugin's own score in [0, 1]; the weighted sum is the pod's total. A pod that the router's
   * filter removed before scoring has null. The whole field is null when BLIS did not score (no
   * scorer configured) or the request was never routed.
   */
  scores: (number[] | null)[] | null;
}

/** BLIS's per-pod time series (`server_series`), one value per bin of `intervalS` from time 0. */
export interface ReplaySeries {
  intervalS: number;
  pods: { kv: number[]; running: number[]; waiting: number[] }[];
}

export interface ReplayTotals {
  /** Preemptions over the whole run and all pods; BLIS does not say when or to which request. */
  preemptions: number;
  /** BLIS's prefix cache hit rate over the run, in [0, 1]. */
  cacheHitRate: number;
  completed: number;
  shed: number;
  /** BLIS's time of the last event. */
  endS: number;
}

export interface ReplayFile {
  schema: typeof REPLAY_SCHEMA;
  id: string;
  /** Short name for the scenario picker. The explanation lives in src/content/replay.md under the same id. */
  title: string;
  blis: ReplayBlis;
  params: ReplayParams;
  /** Router scoring plugins in the order `ReplayRequest.scores` lists them; empty for round-robin. */
  scorers: ReplayScorer[];
  requests: ReplayRequest[];
  series: ReplaySeries;
  totals: ReplayTotals;
}

const fail = (what: string): never => {
  throw new Error(`replay file: ${what}`);
};

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);

function checkRequest(r: ReplayRequest, i: number, scorers: number, pods: number): void {
  const at = `requests[${i}]`;
  if (r.id !== i) fail(`${at}.id must be ${i}`);
  for (const k of ["session", "round", "arrival", "inputTokens", "outputTokens", "cachedTokens"] as const) if (!isNum(r[k])) fail(`${at}.${k} must be a number`);
  for (const k of ["dispatch", "start", "firstToken", "lastToken", "droppedAt", "resumedAt", "preemptedAt"] as const) if (!isNumOrNull(r[k])) fail(`${at}.${k} must be a number or null`);
  if (!["completed", "shed", "dropped"].includes(r.fate)) fail(`${at}.fate is "${String(r.fate)}"`);
  if (r.pod !== null && (!Number.isInteger(r.pod) || r.pod < 0 || r.pod >= pods)) fail(`${at}.pod is ${String(r.pod)}, outside 0..${pods - 1}`);
  if (r.fate === "completed") {
    if (r.pod === null || r.dispatch === null || r.start === null || r.firstToken === null || r.lastToken === null) fail(`${at} is completed but misses a pod or a time`);
    if (!(r.arrival <= r.dispatch! && r.dispatch! <= r.start! + 1e-9 && r.start! <= r.firstToken! && r.firstToken! <= r.lastToken!)) fail(`${at}: times must run arrival <= dispatch <= start <= firstToken <= lastToken`);
    if (r.resumedAt !== null && !(r.firstToken! <= r.resumedAt && r.resumedAt <= r.lastToken!)) fail(`${at}: resumedAt must lie between the first and the last token`);
    if (r.preemptedAt !== null && (r.resumedAt === null || !(r.firstToken! <= r.preemptedAt && r.preemptedAt < r.resumedAt))) fail(`${at}: preemptedAt must lie between the first token and resumedAt`);
  } else if (r.droppedAt === null) fail(`${at} is ${r.fate} but has no droppedAt`);
  if (r.scores) {
    if (r.scores.length !== pods) fail(`${at}.scores must list every pod`);
    for (const row of r.scores) if (row !== null && (row.length !== scorers || !row.every(isNum))) fail(`${at}.scores rows must have one number per scorer`);
  }
}

/** Validate a parsed JSON value as a replay file; throws a message naming the first problem. */
export function parseReplay(value: unknown): ReplayFile {
  const f = value as ReplayFile;
  if (!f || typeof f !== "object") return fail("not an object");
  if (f.schema !== REPLAY_SCHEMA) fail(`schema must be ${REPLAY_SCHEMA}`);
  if (typeof f.id !== "string" || !/^[a-z0-9-]+$/.test(f.id)) fail("id must be lower-case words joined by hyphens");
  if (typeof f.title !== "string" || !f.title) fail("title is missing");
  if (!/^[0-9a-f]{40}$/.test(f.blis?.commit ?? "")) fail("blis.commit must be a full 40-character hash");
  for (const k of ["engineVersion", "routerModule", "catalogHash", "registryHash"] as const) if (typeof f.blis[k] !== "string" || !f.blis[k]) fail(`blis.${k} is missing`);
  const p = f.params;
  for (const k of ["tp", "replicas", "maxNumSeqs", "maxNumBatchedTokens", "gpuMemoryUtilisation", "queueDeadlineS", "kvBlocksPerReplica", "blockTokens"] as const) if (!isNum(p?.[k])) fail(`params.${k} must be a number`);
  if (!["prefix-aware", "least-loaded", "round-robin"].includes(p.routing)) fail(`params.routing is "${String(p.routing)}"`);
  if (typeof p.model !== "string" || typeof p.gpu !== "string" || typeof p.prefixCaching !== "boolean") fail("params.model, gpu or prefixCaching is missing");
  if (!Array.isArray(f.scorers) || !f.scorers.every((s) => typeof s.name === "string" && isNum(s.weight))) fail("scorers must be a list of {name, weight}");
  if (!Array.isArray(f.requests) || !f.requests.length) fail("requests must be a non-empty list");
  f.requests.forEach((r, i) => checkRequest(r, i, f.scorers.length, p.replicas));
  for (let i = 1; i < f.requests.length; i++) if (f.requests[i]!.arrival < f.requests[i - 1]!.arrival) fail("requests must be in arrival order");
  const s = f.series;
  if (!isNum(s?.intervalS) || s.intervalS <= 0 || s.pods?.length !== p.replicas) fail("series needs an interval and one entry per pod");
  const bins = s.pods[0]!.kv.length;
  for (const sp of s.pods) {
    if (sp.kv.length !== bins || sp.running.length !== bins || sp.waiting.length !== bins) fail("every series must have the same number of bins");
    if (![...sp.kv, ...sp.running, ...sp.waiting].every(isNum)) fail("series values must be numbers");
  }
  const t = f.totals;
  for (const k of ["preemptions", "cacheHitRate", "completed", "shed", "endS"] as const) if (!isNum(t?.[k])) fail(`totals.${k} must be a number`);
  return f;
}
