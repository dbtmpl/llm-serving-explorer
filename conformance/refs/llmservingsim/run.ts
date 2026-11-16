/**
 * Run LLMServingSim on one arm of a scenario and reduce what it prints and writes to a `Reduced` record.
 *
 * Nothing in the simulator is patched. What is used, at its default log level (`WARNING`):
 *
 * - the per-request CSV (`--output`): arrival, end time, queuing delay and time to first token, in nanoseconds, in completion order
 *   (re-sorted here to the trace's request order); tokens in and out;
 * - the start-up line `Instance [i] : <tokens> tokens / <blocks> blocks`: the KV capacity it derived from the configuration;
 * - the summary lines `Preemptions: <n>` (printed only when it is not zero), `Total requested prompt tokens`, `NPU prefix hit prompt
 *   tokens`, `CPU prefix hit prompt tokens`;
 * - the per-interval lines `Running Instance[i]: ... Prefix Cache Hit ratio x %, (<hit tokens> / <requested tokens>)`, whose counters are
 *   cumulative. The simulator reports no per-request cached-token count, so a request's is the increase of its instance's counter
 *   over the interval in which it was admitted (arrival + queuing delay). That is only unambiguous when no interval holds two admissions that
 *   hit the cache, and then only for runs without a host tier; otherwise the per-request value is null (the aggregate hit rate is still
 *   stated). The attribution is checked: the increases must add up to the summary's total, and an interval with an increase and two or
 *   more admissions is an error.
 *
 * Needs a built checkout (`LLMSERVINGSIM_DIR`) and a Python with its requirements (`LLMSERVINGSIM_PYTHON`, default `python3`; `LLMSERVINGSIM_PYTHONPATH`
 * is added to `PYTHONPATH`, for a Chakra that is not pip-installed).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NO_AGGREGATES, microseconds, sortRows, type Aggregates, type Reduced, type RequestRow } from "../../record.js";
import type { Scenario } from "../../scenario.js";
import type { GenerateContext } from "../reference.js";
import type { LssInput } from "./translate.js";

export interface LssRaw {
  csv: string;
  /** Standard output with colour codes removed. */
  log: string;
  /** `git rev-parse HEAD` of the checkout that produced it. */
  commit: string;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function checkoutOf(context: GenerateContext): string {
  const dir = context.settings.LLMSERVINGSIM_DIR;
  if (!dir) throw new Error("name a built LLMServingSim checkout at the commit in conformance/refs/llmservingsim/lock with LLMSERVINGSIM_DIR=<path> (see conformance/README.md)");
  if (!existsSync(path.join(dir, "serving", "__main__.py"))) throw new Error(`${dir} is not an LLMServingSim checkout (serving/__main__.py is missing)`);
  if (!existsSync(path.join(dir, "astra-sim", "build", "astra_analytical", "build", "AnalyticalAstra", "bin", "AnalyticalAstra"))) throw new Error(`${dir} is not built: the analytical ASTRA-Sim binary is missing (see conformance/README.md)`);
  return dir;
}

export function commitOf(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Run the simulator on the input. Throws with its own message when it fails. */
export function runLss(input: LssInput, context: GenerateContext): LssRaw {
  const dir = checkoutOf(context);
  const python = context.settings.LLMSERVINGSIM_PYTHON ?? "python3";
  // the simulator reads the trace and the configuration relative to the checkout's root, so they live in a scratch directory inside it
  mkdirSync(path.join(dir, "outputs"), { recursive: true });
  const work = mkdtempSync(path.join(dir, "outputs", "conformance-"));
  const rel = (f: string): string => path.relative(dir, path.join(work, f));
  try {
    writeFileSync(path.join(work, "workload.jsonl"), input.workload);
    writeFileSync(path.join(work, "cluster.json"), JSON.stringify(input.cluster, null, 2));
    const args = ["-m", "serving", "--cluster-config", rel("cluster.json"), "--dataset", rel("workload.jsonl"), "--output", path.join(work, "result.csv"), "--run-id", path.basename(work), ...input.args];
    let stdout: string;
    try {
      stdout = execFileSync(python, args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1 << 28,
        env: { ...process.env, PYTHONPATH: [context.settings.LLMSERVINGSIM_PYTHONPATH, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), TERM: "dumb", NO_COLOR: "1", FORCE_COLOR: "0", COLUMNS: "400", LANG: "C.UTF-8" }
      });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message: string };
      throw new Error(`${input.scenarioFile}: LLMServingSim failed:\n${(err.stderr ?? "").slice(-3000) || (err.stdout ?? "").replace(ANSI, "").slice(-3000) || err.message}`);
    }
    const raw: LssRaw = { csv: readFileSync(path.join(work, "result.csv"), "utf8"), log: stdout.replace(ANSI, ""), commit: commitOf(dir) };
    if (context.keep) {
      mkdirSync(context.keep, { recursive: true });
      for (const f of ["workload.jsonl", "cluster.json", "result.csv"]) copyFileSync(path.join(work, f), path.join(context.keep, f));
      writeFileSync(path.join(context.keep, "stdout.log"), raw.log);
    }
    return raw;
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(path.join(dir, "astra-sim", "inputs", "runs", path.basename(work)), { recursive: true, force: true });
  }
}

/** Minimal CSV reader: the only quoted field is the inter-token latency list, which contains commas. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') (field += '"'), i++;
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) (row.push(field), rows.push(row));
  const header = rows.shift()!;
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

interface Tick {
  t: number;
  /** Cumulative prefix-hit tokens of the instance at the tick. */
  hit: number;
  requested: number;
}

const need = (log: string, re: RegExp, what: string): RegExpExecArray => {
  const m = re.exec(log);
  if (!m) throw new Error(`LLMServingSim's output has no ${what}; its format changed (the adapter is pinned to the commit in conformance/refs/llmservingsim/lock)`);
  return m;
};

export interface LogFacts {
  /** Blocks per instance, from the start-up lines. */
  blocks: number[];
  preemptions: number;
  requestedTokens: number | null;
  npuHitTokens: number | null;
  cpuHitTokens: number | null;
  /** Per instance: the cumulative counters at each throughput line. */
  ticks: Tick[][];
}

export function scrapeLog(log: string, instances: number, caching: boolean, hostTier: boolean): LogFacts {
  const blocks = Array.from({ length: instances }, (_, i) => Number(need(log, new RegExp(`Instance \\[${i}\\] : \\d+ tokens / (\\d+) blocks`), `KV capacity line of instance ${i}`)[1]));
  const preemptions = /^Preemptions:\s+(\d+)\s*$/m.exec(log);
  need(log, /Total requests:\s+\d+/, "summary (Total requests)");
  let requestedTokens: number | null = null;
  let npuHitTokens: number | null = null;
  let cpuHitTokens: number | null = null;
  if (caching) {
    requestedTokens = Number(need(log, /Total requested prompt tokens:\s+(\d+)/, "prefix-cache summary")[1]);
    npuHitTokens = Number(need(log, /NPU prefix hit prompt tokens:\s+(\d+)/, "prefix-cache summary")[1]);
    if (hostTier) cpuHitTokens = Number(need(log, /CPU prefix hit prompt tokens:\s+(\d+)/, "host-tier prefix-cache summary")[1]);
  }
  const ticks: Tick[][] = Array.from({ length: instances }, () => []);
  let t = 0;
  for (const line of log.split("\n")) {
    const head = /^\[([\d.]+)s\] Avg prompt throughput/.exec(line);
    if (head) t = Number(head[1]);
    const inst = /Running Instance\[(\d+)\]: (\d+) reqs, Waiting: (\d+) reqs.*Prefix Cache Hit ratio [\d.]+ %, \((\d+) \/ (\d+)\)/.exec(line);
    if (inst) ticks[Number(inst[1])]?.push({ t, hit: Number(inst[4]), requested: Number(inst[5]) });
  }
  return { blocks, preemptions: preemptions ? Number(preemptions[1]) : 0, requestedTokens, npuHitTokens, cpuHitTokens, ticks };
}

/**
 * Per-request cached prompt tokens from the cumulative counters (see the module comment), or null where the attribution is not safe.
 * `admitted[i]` is the admission time of request i in seconds; `instance[i]` its instance.
 */
export function attributeHits(facts: LogFacts, admitted: number[], instance: number[], intervalS: number): (number | null)[] | null {
  const out: (number | null)[] = new Array(admitted.length).fill(null);
  let total = 0;
  for (let inst = 0; inst < facts.ticks.length; inst++) {
    const ticks = facts.ticks[inst]!;
    const mine = admitted.map((a, i) => (instance[i] === inst ? i : -1)).filter((i) => i >= 0);
    if (!mine.length) continue;
    // the window (t[k-1], t[k]] holds the admissions whose increase the k-th line reports; admissions after the last line are reported by the summary only
    const bounds = ticks.map((k) => k.t);
    const windowOf = (a: number): number => {
      const k = bounds.findIndex((b) => a <= b + 1e-9);
      return k < 0 ? ticks.length : k;
    };
    const inWindow = new Map<number, number[]>();
    for (const i of mine) inWindow.set(windowOf(admitted[i]!), [...(inWindow.get(windowOf(admitted[i]!)) ?? []), i]);
    let prev = 0;
    for (let k = 0; k <= ticks.length; k++) {
      const cum = k < ticks.length ? ticks[k]!.hit : null;
      const delta = cum === null ? null : cum - prev;
      if (cum !== null) prev = cum;
      const here = inWindow.get(k) ?? [];
      if (delta === null) {
        // after the last line: the rest of the run's total belongs to these requests
        const rest = (facts.npuHitTokens ?? 0) - total - prev;
        if (rest !== 0 || here.length) {
          if (here.length > 1 && rest > 0) return null;
          for (const i of here) out[i] = here.length === 1 ? rest : 0;
          total += rest;
        }
        continue;
      }
      if (delta > 0 && here.length !== 1) return null;
      for (const i of here) out[i] = delta;
    }
    total += prev;
  }
  if (out.some((x) => x === null)) return null;
  if (out.reduce((a, b) => a! + b!, 0) !== facts.npuHitTokens) return null;
  return out;
}

export function reduceLss(s: Scenario, arm: string, raw: LssRaw, input: LssInput): Reduced {
  const d = s.arms[arm]!;
  const csv = parseCsv(raw.csv);
  if (csv.length !== input.requests.length) throw new Error(`${s.id}: LLMServingSim returned ${csv.length} requests for ${input.requests.length} sent`);
  const instances = d.disagg ? d.replicas : d.replicas;
  const hostTier = Boolean(d.offload);
  const facts = scrapeLog(raw.log, instances, d.engine.prefixCaching, hostTier);
  const byId = csv.slice().sort((a, b) => Number(a["request id"]) - Number(b["request id"]));
  const ns = (r: Record<string, string>, k: string): number => {
    const v = Number(r[k]);
    if (!Number.isFinite(v)) throw new Error(`${s.id}: LLMServingSim's CSV has no number in "${k}"`);
    return v;
  };
  const admitted = byId.map((r) => (ns(r, "arrival") + ns(r, "queuing_delay")) / 1e9);
  const instance = byId.map((r) => ns(r, "instance id"));
  const hits = d.engine.prefixCaching && !hostTier && !d.disagg ? attributeHits(facts, admitted, instance, input.logIntervalS) : null;
  const requestsPerPod = new Array<number>(instances).fill(0);
  const rows: RequestRow[] = byId.map((r, i) => {
    if (Number(r["request id"]) !== i) throw new Error(`${s.id}: LLMServingSim's request ids are not 0..n-1`);
    const meta = input.requests[i]!;
    const arrival = ns(r, "arrival");
    requestsPerPod[instance[i]!] = (requestsPerPod[instance[i]!] ?? 0) + 1;
    return {
      session: meta.session,
      round: meta.round,
      inputTokens: ns(r, "input"),
      outputTokens: ns(r, "output"),
      cachedTokens: d.engine.prefixCaching ? (hits ? hits[i]! : null) : 0,
      pod: d.disagg ? null : instance[i]!,
      arrivalS: microseconds(arrival / 1e9),
      firstTokenS: microseconds((arrival + ns(r, "TTFT")) / 1e9),
      lastTokenS: microseconds(ns(r, "end_time") / 1e9),
      fate: "completed",
      preemptions: null
    };
  });
  const rate = (hit: number | null): number | null => (facts.requestedTokens ? (hit ?? 0) / facts.requestedTokens : d.engine.prefixCaching ? null : 0);
  const aggregates: Aggregates = {
    ...NO_AGGREGATES,
    prefixHitRate: rate(facts.npuHitTokens),
    cpuTierHitRate: hostTier ? rate(facts.cpuHitTokens) : 0,
    peakReplicas: d.disagg ? null : requestsPerPod.filter((n) => n > 0).length
  };
  return { source: "llmservingsim", scenario: s.id, kvBlocksPerReplica: facts.blocks[0]!, requests: sortRows(rows), preemptions: facts.preemptions, requestsPerPod, aggregates };
}
