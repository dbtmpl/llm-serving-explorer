/**
 * Neutral scenario to LLMServingSim input: a request trace (JSONL), a cluster configuration (JSON) and the command line.
 *
 * Token ids. The simulator's prefix cache hashes real token ids, in chains of 16-token blocks, so a trace without ids has no
 * prefix reuse at all. The scenario has token counts only, so the translator invents ids that behave as the scenario says:
 * every token the scenario introduces gets a fresh id, and a follow-up round's prompt is `previous prompt ids + previous output
 * ids + fresh ids` (what the TypeScript model and BLIS rebuild too). Sharing is then exactly what the conversation structure implies.
 * Each follow-up is written as an ordinary request at its own arrival time (open loop), not as a chained agentic `sub_requests`
 * entry, whose follow-ups the simulator would release after the previous answer finishes.
 *
 * A scenario that replays the 300 ShareGPT requests of LLMServingSim's own bench example (`data/`) takes the example's cluster
 * configuration (including its memory utilisation, which its authors calibrated to the real engine's block count) and the prefix
 * structure of the real token ids, rebuilt as synthetic ids (see `data.ts`), so that its prefix cache sees the same sharing as in its own
 * validation.
 */
import { createHash } from "node:crypto";
import { BLOCK_TOKENS, type Deployment, type Scenario } from "../../scenario.js";
import { loadPrefixData, lockedCommit, type PrefixData } from "./data.js";
import { gpuName, modelName } from "./names.js";

export interface LssInput {
  /** Scenario id, for messages. */
  scenarioFile: string;
  /** The trace, one JSON object per line, in request-id order (the simulator numbers requests by line). */
  workload: string;
  /** The `(session, round)` of each line. */
  requests: { session: number; round: number }[];
  /** Cluster configuration. */
  cluster: Record<string, unknown>;
  /** Command-line arguments after `python -m serving`, except the three paths (`--cluster-config`, `--dataset`, `--output`). */
  args: string[];
  /** Seconds between its throughput lines (`--log-interval`). */
  logIntervalS: number;
  /** Whether the trace is a replay of the example's own workload (and the cluster is the example's). */
  replay: string | null;
  inputHash: string;
}

/** Interval between the simulator's throughput lines, seconds. Prefix hits are attributed to requests by it (see `run.ts`). */
export const LOG_INTERVAL_S = 1;

const NS = 1e9;

/** The example whose workload the scenario replays, when it is exactly that. */
function replayOf(d: Deployment): PrefixData | null {
  let data: PrefixData;
  try {
    data = loadPrefixData(`${d.gpu}-${d.model}`);
  } catch {
    return null;
  }
  if (d.requests.length !== data.requests.length) return null;
  const sorted = d.requests.slice().sort((a, b) => a.at - b.at || a.session - b.session);
  const same = sorted.every((r, i) => r.round === 0 && r.session === i + 1 && r.newTokens === data.requests[i]!.inputTokens && r.outputTokens === data.requests[i]!.outputTokens);
  return same ? data : null;
}

/** Fresh token ids, never repeated. */
class Ids {
  private next = 1000;
  fresh(n: number): number[] {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.next++;
    return out;
  }
}

export function toLss(s: Scenario, arm: string): LssInput {
  const d = s.arms[arm];
  if (!d) throw new Error(`${s.id}: no arm "${arm}"`);
  const problems: string[] = [];
  if (d.engine.tp !== 1) problems.push(`tensor parallel degree ${d.engine.tp} (only profiles at tp 1 are used)`);
  if (d.engine.gpuMemoryUtilisation <= 0 || d.engine.gpuMemoryUtilisation >= 1) problems.push("gpu_memory_utilisation outside (0, 1)");
  if (d.replicas > 1 && d.routing === "prefix-aware") problems.push("prefix-aware routing (it has only RR, RAND and LOAD)");
  if (d.autoscale || d.queueDeadlineS > 0) problems.push("autoscaling or shedding");
  if (problems.length) throw new Error(`${s.id}: LLMServingSim cannot run this scenario: ${problems.join("; ")}`);
  const model = modelName(d.model);
  const hardware = gpuName(d.gpu);

  const replay = replayOf(d);
  const base = loadPrefixData(`${d.gpu}-${d.model}`);
  const exampleInstance = (((base.cluster.nodes as Record<string, unknown>[])[0]!.instances as Record<string, unknown>[])[0]!) as Record<string, any>;
  const ids = new Ids();

  // the trace
  const order = d.requests.slice().sort((a, b) => a.at - b.at || a.session - b.session || a.round - b.round);
  const rows: { input_toks: number; output_toks: number; arrival_time_ns: number; input_tok_ids: number[]; output_tok_ids: number[] }[] = [];
  const meta: LssInput["requests"] = [];
  if (replay) {
    const idsOf: number[][] = [];
    order.forEach((r, i) => {
      const p = replay.requests[i]!;
      const input = p.parent >= 0 ? [...idsOf[p.parent]!.slice(0, p.shared), ...ids.fresh(p.inputTokens - p.shared)] : ids.fresh(p.inputTokens);
      idsOf.push(input);
      rows.push({ input_toks: p.inputTokens, output_toks: p.outputTokens, arrival_time_ns: Math.round(r.at * NS), input_tok_ids: input, output_tok_ids: ids.fresh(p.outputTokens) });
      meta.push({ session: r.session, round: r.round });
    });
  } else {
    const history = new Map<number, number[]>();
    for (const r of order) {
      const prev = history.get(r.session) ?? [];
      if (r.round > 0 && !prev.length) throw new Error(`${s.id}: session ${r.session} round ${r.round} arrives before round ${r.round - 1}`);
      const input = [...prev, ...ids.fresh(r.newTokens)];
      const output = ids.fresh(r.outputTokens);
      history.set(r.session, [...input, ...output]);
      rows.push({ input_toks: input.length, output_toks: output.length, arrival_time_ns: Math.round(r.at * NS), input_tok_ids: input, output_tok_ids: output });
      meta.push({ session: r.session, round: r.round });
    }
  }
  const workload = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

  // the cluster
  const args: string[] = [];
  let cluster: Record<string, unknown>;
  if (replay) {
    if (d.replicas !== 1 || d.disagg || d.offload || d.speculative) throw new Error(`${s.id}: a replay of the example's workload is one plain replica`);
    if (d.engine.asyncScheduling !== true) throw new Error(`${s.id}: LLMServingSim's example runs with asynchronous scheduling (its default); the scenario says it does not`);
    cluster = replay.cluster;
  } else {
    const instance = (pdType: string | null): Record<string, unknown> => ({ ...structuredClone(exampleInstance), model_name: model, hardware, pd_type: pdType, tp_size: 1, num_npus: 1, npu_mem: { ...exampleInstance.npu_mem, mem_util: d.engine.gpuMemoryUtilisation } });
    const instances = d.disagg
      ? [...Array.from({ length: d.disagg.prefillReplicas }, () => instance("prefill")), ...Array.from({ length: d.disagg.decodeReplicas }, () => instance("decode"))]
      : Array.from({ length: d.replicas }, () => instance(null));
    const node: Record<string, any> = { ...structuredClone((base.cluster.nodes as Record<string, any>[])[0]!), num_instances: instances.length, instances };
    if (d.offload) node.cpu_mem = { ...node.cpu_mem, mem_size: d.offload.cpuGB * (1e9 / 2 ** 30) };
    cluster = { ...structuredClone(base.cluster), nodes: [node] };
    // `mem_util` in the example's instance is its authors' calibration to one real engine; a scenario's own utilisation replaces it
  }
  args.push("--num-reqs", String(rows.length), "--max-num-seqs", String(d.engine.maxNumSeqs), "--max-num-batched-tokens", String(d.engine.maxNumBatchedTokens), "--block-size", String(BLOCK_TOKENS));
  args.push(d.engine.prefixCaching ? "--enable-prefix-caching" : "--no-enable-prefix-caching");
  args.push("--request-routing-policy", d.routing === "least-loaded" ? "LOAD" : "RR");
  // vLLM's default since 0.11 and the simulator's: host work overlaps the GPU step. The scenario states it; the simulator is told the same.
  args.push(d.engine.asyncScheduling ? "--async-scheduling" : "--no-async-scheduling");
  if (d.offload) args.push("--prefix-storage", "CPU");
  if (d.speculative) args.push("--num-speculative-tokens", String(d.speculative.k), "--spec-acceptance-rate", String((d.speculative.acceptanceLength - 1) / d.speculative.k));
  args.push("--log-interval", String(LOG_INTERVAL_S), "--log-level", "WARNING", "--network-backend", "analytical");

  const inputHash = createHash("sha256").update(JSON.stringify({ lock: lockedCommit(), workload, cluster, args, meta })).digest("hex");
  return { scenarioFile: s.id, workload, requests: meta, cluster, args, logIntervalS: LOG_INTERVAL_S, replay: replay ? replay.id : null, inputHash };
}

/** Hash of everything handed to the simulator for every arm. */
export function scenarioInputHash(s: Scenario): string {
  const h = createHash("sha256");
  for (const arm of Object.keys(s.arms).sort()) h.update(toLss(s, arm).inputHash);
  return h.digest("hex");
}
