/**
 * Run the pinned BLIS on the replay scenarios and write `public/replay/<id>.json`.
 *
 *     BLIS_BIN=/path/to/blis pnpm replay:build [--only <id>] [--keep <dir>]
 *
 * What BLIS gives without a patch, and where each field comes from:
 *   - per request: the Result's `request_rows` (arrival, TTFT, end-to-end time, scheduling delay,
 *     gateway queue delay, cached tokens, instance, fate);
 *   - per pod: the Result's `server_series` (KV usage, running and waiting requests per bin);
 *   - the router's per-endpoint scores: BLIS's own log at `--log trace`, which prints every scorer's
 *     score for every endpoint of every routing decision. The Result does not carry them (the
 *     in-memory decision trace is summarised only), so the generator reads the log, and checks that
 *     the pod BLIS chose has the highest weighted sum before it writes anything.
 * It builds on `conformance/` (scenario format, translator, pinned commit) by import; nothing in
 * `src/` imports from there.
 */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lockedCommit } from "../conformance/run/blis.js";
import { BLOCK_TOKENS, CONFORMANCE_DIR, mainArm } from "../conformance/scenario.js";
import { EPP_FILES, toBlis } from "../conformance/translate/toBlis.js";
import { REPLAY_SCHEMA, parseReplay, type ReplayFate, type ReplayFile, type ReplayRequest, type ReplayScorer } from "../src/replay/schema.js";
import { REPLAY_SCENARIOS, type Expect, type ReplayScenario } from "./scenarios.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public", "replay");

interface Row {
  id: string;
  fate: string;
  drop_reason?: string;
  arrival_us: number;
  ttft_us?: number;
  e2e_us?: number;
  scheduling_delay_us?: number;
  gateway_queue_delay_us?: number;
  prompt_tokens?: number;
  cached_local_tokens?: number;
  output_tokens?: number;
  instance?: string;
  session_id?: string;
  round_index?: number;
}

interface Engine {
  id: string;
  bins: number;
  kv_cache_usage: number[];
  num_requests_running: number[];
  num_requests_waiting: number[];
}

interface Result {
  engine: { version: string };
  data: { catalog: { hash: string }; registry: { hash: string } };
  request_rows: Row[];
  reports: { engine: { cluster: { cache_hit_rate_whole_run: number; kv_capacity_tokens_per_replica: number; preemptions: number; server_series: { interval_s: number; engines: Engine[] } } } };
}

function die(msg: string): never {
  console.error(`replay:build: ${msg}`);
  process.exit(1);
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const r2 = (x: number): number => Math.round(x * 1e2) / 1e2;

/** The router's scoring plugins and their weights, from the "Pick profiles" line of the log. */
export function scorersFrom(log: string): ReplayScorer[] {
  const m = /Scorers: \[([^\]]*)\]/.exec(log);
  if (!m || !m[1]!.trim()) return [];
  return m[1]!.split(",").map((part) => {
    const mm = /^\s*([a-z0-9-]+)\/[a-z0-9-]+: ([0-9.]+)\s*$/.exec(part);
    if (!mm) throw new Error(`cannot read the scorer "${part}" from the BLIS log`);
    return { name: mm[1]!, weight: Number(mm[2]) };
  });
}

/**
 * Per request index, the raw score of each scorer for each pod, from the log. A decision starts at
 * the line that names the request (flow control: "Item dispatched", otherwise "Request admitted")
 * and runs until the next such line.
 */
export function scoresFrom(log: string, scorers: ReplayScorer[], pods: number): Map<number, (number[] | null)[]> {
  const out = new Map<number, (number[] | null)[]>();
  const index = new Map(scorers.map((s, i) => [s.name, i]));
  let cur: (number[] | null)[] | null = null;
  const start = /(?:Item dispatched\. flowKey=\S+|Request admitted .*) requestID=request_(\d+)/;
  const calc = /Calculated score .*plugin=([a-z0-9-]+)\/[a-z0-9-]+ endpoint=default\/instance-(\d+)-rank-\d+ score=([0-9.eE+-]+)/;
  for (const line of log.split("\n")) {
    if (line.includes("requestID=request_")) {
      const m = start.exec(line);
      if (m) {
        cur = Array.from({ length: pods }, () => null);
        out.set(Number(m[1]), cur);
        continue;
      }
    }
    if (cur && line.includes("Calculated score")) {
      const m = calc.exec(line);
      if (!m) continue;
      const col = index.get(m[1]!);
      if (col === undefined) throw new Error(`BLIS scored with ${m[1]}, which the router configuration does not list`);
      const pod = Number(m[2]);
      (cur[pod] ??= scorers.map(() => NaN))[col] = Number(m[3]);
    }
  }
  return out;
}

function reduce(rs: ReplayScenario, result: Result, log: string, binary: string): ReplayFile {
  const s = rs.scenario;
  const d = mainArm(s);
  const cluster = result.reports.engine.cluster;
  if (cluster.kv_capacity_tokens_per_replica % BLOCK_TOKENS) throw new Error(`${s.id}: KV capacity is not a whole number of blocks`);
  const scorers = scorersFrom(log);
  const scores = scorers.length ? scoresFrom(log, scorers, d.replicas) : new Map<number, (number[] | null)[]>();
  const requests: ReplayRequest[] = [];
  const rows = [...result.request_rows].sort((a, b) => Number(a.id.slice(8)) - Number(b.id.slice(8)));
  if (rows.length !== d.requests.length) throw new Error(`${s.id}: BLIS returned ${rows.length} rows for ${d.requests.length} requests`);
  rows.forEach((row, i) => {
    if (row.id !== `request_${i}`) throw new Error(`${s.id}: expected row request_${i}, got ${row.id}`);
    const asked = d.requests[i]!;
    if (row.session_id !== `s${asked.session}` || (row.round_index ?? 0) !== asked.round) throw new Error(`${s.id}: ${row.id} is ${row.session_id}/${row.round_index}, expected s${asked.session}/${asked.round}`);
    const arrival = row.arrival_us / 1e6;
    let fate: ReplayFate;
    if (row.fate === "completed") fate = "completed";
    else if (row.fate === "dropped" && row.drop_reason === "gateway_expired") fate = "shed";
    else if (row.fate === "dropped") fate = "dropped";
    else throw new Error(`${s.id}: ${row.id} has fate "${row.fate}", which the replay does not draw`);
    const done = fate === "completed";
    const pod = done ? Number(row.instance!.replace("instance_", "")) : null;
    const decision = scores.get(i) ?? null;
    if (done && scorers.length && !decision) throw new Error(`${s.id}: no scores found in the BLIS log for ${row.id}`);
    if (decision && pod !== null) {
      // the pod BLIS routed to must have the highest weighted total (ties allowed: the picker breaks them)
      const totals = decision.map((sc) => (sc ? sc.reduce((sum, v, k) => sum + v * scorers[k]!.weight, 0) : -Infinity));
      if (totals[pod]! < Math.max(...totals) - 1e-9) throw new Error(`${s.id}: ${row.id} went to pod ${pod} but the scores in the log are ${totals.join(", ")}`);
      for (const sc of decision) if (sc && sc.some((v) => !Number.isFinite(v))) throw new Error(`${s.id}: ${row.id} has a missing scorer value`);
    }
    const startAt = done ? arrival + row.scheduling_delay_us! / 1e6 : 0;
    const firstAt = done ? arrival + row.ttft_us! / 1e6 : 0;
    // BLIS reports the last scheduling: after the first token, it is the time a preempted request resumed
    const resumed = done && startAt > firstAt + 1e-6;
    requests.push({
      id: i,
      session: asked.session,
      round: asked.round,
      arrival: r6(arrival),
      inputTokens: row.prompt_tokens ?? 0,
      outputTokens: done ? row.output_tokens ?? asked.outputTokens : 0,
      cachedTokens: row.cached_local_tokens ?? 0,
      fate,
      pod,
      dispatch: done ? r6(arrival + (row.gateway_queue_delay_us ?? 0) / 1e6) : null,
      start: done ? r6(resumed ? arrival + (row.gateway_queue_delay_us ?? 0) / 1e6 : startAt) : null,
      firstToken: done ? r6(arrival + row.ttft_us! / 1e6) : null,
      lastToken: done ? r6(arrival + row.e2e_us! / 1e6) : null,
      resumedAt: resumed ? r6(startAt) : null,
      preemptedAt: null,
      droppedAt: done ? null : r6(arrival + d.queueDeadlineS),
      scores: done && decision ? decision.map((sc) => (sc ? sc.map((v) => Math.round(v * 1e6) / 1e6) : null)) : null
    });
  });
  const series = cluster.server_series;
  const engines = [...series.engines].sort((a, b) => Number(a.id.slice(9)) - Number(b.id.slice(9)));
  if (engines.length !== d.replicas) throw new Error(`${s.id}: the series has ${engines.length} engines for ${d.replicas} replicas`);
  const interval = series.interval_s;
  pausesFrom(requests, engines, interval);
  const endS = Math.max(...requests.map((r) => r.lastToken ?? r.droppedAt ?? r.arrival));
  const bins = Math.min(...engines.map((e) => e.bins), Math.ceil(endS / series.interval_s) + 1);
  return parseReplay({
    schema: REPLAY_SCHEMA,
    id: s.id,
    title: s.title,
    blis: {
      commit: lockedCommit(),
      engineVersion: result.engine.version,
      routerModule: execFileSync(binary, ["router-configs"], { encoding: "utf8" }).split("\n")[0]!.trim(),
      catalogHash: result.data.catalog.hash,
      registryHash: result.data.registry.hash
    },
    params: {
      model: d.model,
      gpu: d.gpu,
      tp: d.engine.tp,
      replicas: d.replicas,
      routing: d.routing,
      maxNumSeqs: d.engine.maxNumSeqs,
      maxNumBatchedTokens: d.engine.maxNumBatchedTokens,
      gpuMemoryUtilisation: d.engine.gpuMemoryUtilisation,
      prefixCaching: d.engine.prefixCaching,
      queueDeadlineS: d.queueDeadlineS,
      kvBlocksPerReplica: cluster.kv_capacity_tokens_per_replica / BLOCK_TOKENS,
      blockTokens: BLOCK_TOKENS
    },
    scorers,
    requests,
    series: {
      intervalS: series.interval_s,
      pods: engines.map((e) => ({ kv: e.kv_cache_usage.slice(0, bins).map(r4), running: e.num_requests_running.slice(0, bins).map(r2), waiting: e.num_requests_waiting.slice(0, bins).map(r2) }))
    },
    totals: {
      preemptions: cluster.preemptions,
      cacheHitRate: r4(cluster.cache_hit_rate_whole_run),
      completed: requests.filter((r) => r.fate === "completed").length,
      shed: requests.filter((r) => r.fate === "shed").length,
      endS: r6(endS)
    }
  });
}

/**
 * Time each preemption from the pods' waiting-requests series. A preempted request waits again until
 * `resumedAt`; the series counts everything that waits, so subtracting the requests whose waiting
 * is known (dispatch to start) leaves the paused ones, whose number steps up at each preemption.
 * vLLM preempts the newest running request first, so the k-th step up belongs to the k-th newest
 * preempted request of the pod. A step the series does not show cleanly leaves `preemptedAt` null.
 */
function pausesFrom(requests: ReplayRequest[], engines: Engine[], h: number): void {
  engines.forEach((e, pod) => {
    const mine = requests.filter((r) => r.pod === pod && r.fate === "completed");
    const paused = mine.filter((r) => r.resumedAt !== null).sort((a, b) => b.arrival - a.arrival);
    if (!paused.length) return;
    const bins = e.bins;
    const residual = Array.from({ length: bins }, (_, i) => {
      let known = 0;
      for (const r of mine) {
        if (r.resumedAt !== null) continue;
        const lo = Math.max(r.dispatch!, i * h);
        const hi = Math.min(r.start!, (i + 1) * h);
        if (hi > lo) known += (hi - lo) / h;
      }
      return Math.max(0, e.num_requests_waiting[i]! - known);
    });
    const edges: number[] = [];
    for (let i = 1; i < bins - 1; i++) {
      const rise = residual[i]! - residual[i - 1]!;
      if (rise < 0.35) continue;
      // `residual[i]` averages the bin: the part of it spent at the higher level is the share of the step
      const after = Math.max(residual[i + 1]!, residual[i]!);
      const frac = Math.min(1, (residual[i]! - residual[i - 1]!) / Math.max(1e-9, after - residual[i - 1]!));
      const steps = Math.max(1, Math.round(after - residual[i - 1]!));
      for (let k = 0; k < steps; k++) edges.push((i + 1) * h - frac * h);
    }
    if (edges.length !== paused.length) return;
    paused.forEach((r, k) => {
      const at = edges[k]!;
      if (at > r.firstToken! && at < r.resumedAt!) r.preemptedAt = r6(at);
    });
  });
}

/** Refuse a run that did not show what its scenario is for. */
function expectations(f: ReplayFile, rows: Row[], x: Expect): void {
  const fail = (msg: string): never => {
    throw new Error(`${f.id}: the run does not show what the scenario is for: ${msg}`);
  };
  const routed = f.requests.filter((r) => r.pod !== null);
  if (x.podsUsed && new Set(routed.map((r) => r.pod)).size < x.podsUsed) fail(`fewer than ${x.podsUsed} pods were used`);
  if (x.stickyFollowUps !== undefined) {
    const last = new Map<number, number | null>();
    let sticky = 0;
    for (const r of f.requests) {
      if (r.round > 0 && r.pod !== null && last.get(r.session) === r.pod) sticky++;
      last.set(r.session, r.pod);
    }
    if (sticky < x.stickyFollowUps) fail(`only ${sticky} follow-ups returned to their pod (wanted ${x.stickyFollowUps})`);
  }
  for (const [fate, n] of Object.entries(x.fates ?? {})) {
    const got = f.requests.filter((r) => r.fate === fate).length;
    if (got < n!) fail(`${got} requests ${fate}, wanted at least ${n}`);
  }
  if (x.heldAtRouter !== undefined) {
    const held = rows.filter((r) => (r.gateway_queue_delay_us ?? 0) > 0).length + f.requests.filter((r) => r.fate === "shed").length;
    if (held < x.heldAtRouter) fail(`only ${held} requests were held at the router`);
  }
  if (x.engineQueued !== undefined) {
    const q = f.requests.filter((r) => r.start !== null && r.dispatch !== null && r.start - r.dispatch > 0.1).length;
    if (q < x.engineQueued) fail(`only ${q} requests waited in a pod's queue`);
  }
  if (x.preemptions !== undefined && f.totals.preemptions < x.preemptions) fail(`${f.totals.preemptions} preemptions, wanted at least ${x.preemptions}`);
  if (x.preemptions !== undefined && f.requests.some((r) => r.resumedAt !== null && r.preemptedAt === null)) fail("a preemption could not be placed in time from the series");
}

/** One request per line keeps a regenerated file reviewable as a diff. */
function format(f: ReplayFile): string {
  const lines = (xs: unknown[]) => xs.map((x) => `    ${JSON.stringify(x)}`).join(",\n");
  const { requests, series, ...head } = f;
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, "");
  return `${headJson},\n  "requests": [\n${lines(requests)}\n  ],\n  "series": {\n    "intervalS": ${series.intervalS},\n    "pods": [\n${lines(series.pods)}\n    ]\n  }\n}\n`;
}

export function build(rs: ReplayScenario, binary: string, keep?: string): ReplayFile {
  const input = toBlis(rs.scenario);
  const dir = keep ?? mkdtempSync(path.join(tmpdir(), `replay-${rs.scenario.id}-`));
  mkdirSync(dir, { recursive: true });
  try {
    for (const [file, text] of Object.entries(input.files)) {
      const target = path.join(dir, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    const logPath = path.join(dir, "blis.log");
    const fd = openSync(logPath, "w");
    try {
      execFileSync(binary, [...input.args, "--server-series-interval-s", String(rs.seriesIntervalS), "--log", "trace"], { cwd: dir, stdio: ["ignore", "ignore", fd], maxBuffer: 1 << 28 });
    } catch (e) {
      throw new Error(`${rs.scenario.id}: blis replay failed (see ${logPath}): ${(e as Error).message}`);
    } finally {
      closeSync(fd);
    }
    const result = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")) as Result;
    const file = reduce(rs, result, readFileSync(logPath, "utf8"), binary);
    expectations(file, result.request_rows, rs.expect);
    return file;
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const binary = arg("blis") ?? process.env.BLIS_BIN;
  if (!binary) die("name the BLIS binary with BLIS_BIN=<path> (build it from the commit in conformance/blis.lock; see conformance/README.md).");
  if (!existsSync(binary)) die(`the BLIS binary ${binary} does not exist.`);
  // the router configurations the translator ships must be the ones this binary's router ships
  for (const file of new Set(Object.values(EPP_FILES))) {
    const shipped = execFileSync(binary, ["router-configs", "--file", file], { encoding: "utf8" });
    if (shipped !== readFileSync(path.join(CONFORMANCE_DIR, "translate", "epp", file), "utf8")) die(`conformance/translate/epp/${file} differs from the file this BLIS ships`);
  }
  const only = arg("only");
  mkdirSync(OUT_DIR, { recursive: true });
  for (const rs of REPLAY_SCENARIOS) {
    if (only && rs.scenario.id !== only) continue;
    const keep = arg("keep") ? path.join(arg("keep")!, rs.scenario.id) : undefined;
    const file = build(rs, binary, keep);
    const text = format(file);
    parseReplay(JSON.parse(text));
    const out = path.join(OUT_DIR, `${file.id}.json`);
    writeFileSync(out, text);
    console.log(`wrote ${path.relative(ROOT, out)}  ${(text.length / 1024).toFixed(1)} KiB  ${file.requests.length} requests, ${file.totals.completed} completed, ${file.totals.shed} shed, ${file.totals.preemptions} preemptions`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
