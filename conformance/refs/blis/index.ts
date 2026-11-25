/**
 * BLIS (inference-sim) as a reference: a discrete-event simulator that runs the real llm-d router in
 * front of a Go translation of vLLM's scheduler. Needs its binary only to generate references.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Provenance, ReferenceFile, Reduced } from "../../record.js";
import type { Scenario } from "../../scenario.js";
import { MECHANISMS, type GenerateContext, type Reference } from "../reference.js";
import { GPU_NAMES, MODEL_NAMES } from "./names.js";
import { reduceBlis, runBlisInput, lockedCommit, type BlisRaw } from "./run.js";
import { ALL_EPP_FILES, EPP_DIR, scenarioInputHash, toBlis, type BlisInput } from "./translate.js";

const binaryOf = (context: GenerateContext): string => {
  const binary = context.settings.BLIS_BIN;
  if (!binary) throw new Error("name the BLIS binary with --blis <path> or BLIS_BIN=<path>. Build it from the commit in conformance/refs/blis/lock (see conformance/README.md).");
  if (!existsSync(binary)) throw new Error(`the BLIS binary ${binary} does not exist. Build it from the commit in conformance/refs/blis/lock (see conformance/README.md).`);
  return binary;
};

export const blis: Reference<BlisInput, BlisRaw> = {
  id: "blis",
  name: "BLIS",
  kind: "simulator",
  evidence:
    "Decisions of llm-d and vLLM as simulated: BLIS runs the llm-d router's own code and a Go port of vLLM 0.34's scheduler, so agreement shows the TypeScript model makes the same routing, admission, preemption and KV-accounting decisions in the situations a scenario constructs. It is a simulator, not a cluster: its timings come from fitted coefficients and nothing in it ran on a GPU.",
  supports: {
    models: Object.keys(MODEL_NAMES),
    gpus: Object.keys(GPU_NAMES),
    mechanisms: MECHANISMS,
    quantities: ["kv_blocks_per_replica", "prefix_cached_tokens", "routed_pod", "requests_per_pod", "session_pod_changes", "preemptions", "request_fate", "prefill_pool_requests"],
    metrics: [
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
    ],
    arms: true
  },
  lock: lockedCommit,
  translate: toBlis,
  run: (input, context) => runBlisInput(input.scenarioFile, input, binaryOf(context), context.keep),
  reduce: (s: Scenario, arm: string, raw: BlisRaw): Reduced => reduceBlis(s, arm, raw.result),
  inputHash: scenarioInputHash,
  prepare(context) {
    const binary = binaryOf(context);
    const src = context.settings.BLIS_SRC;
    if (src) {
      const head = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      // the weekly upstream job builds a newer commit on purpose (BLIS_UPSTREAM=1) and the references it writes name that commit
      if (context.settings.BLIS_UPSTREAM) context.settings.BLIS_COMMIT = head;
      else if (head !== lockedCommit()) throw new Error(`BLIS_SRC is at ${head} but conformance/refs/blis/lock names ${lockedCommit()}`);
    }
    // the router configurations the translators ship must be the ones this binary's llm-d router ships
    for (const file of ALL_EPP_FILES) {
      const shipped = execFileSync(binary, ["router-configs", "--file", file], { encoding: "utf8" });
      const ours = readFileSync(path.join(EPP_DIR, file), "utf8");
      if (shipped !== ours) {
        const msg = `conformance/refs/blis/epp/${file} differs from the file this BLIS ships (blis router-configs --file ${file})`;
        if (context.settings.BLIS_UPSTREAM) console.warn(`warning: ${msg}; continuing with upstream drift check`);
        else throw new Error(`${msg}; copy the new one and re-run`);
      }
    }
  },
  generate(s: Scenario, context: GenerateContext): ReferenceFile {
    const records: Record<string, Reduced> = {};
    let provenance: Provenance | undefined;
    for (const arm of Object.keys(s.arms)) {
      const raw = this.run(this.translate(s, arm), { ...context, ...(context.keep ? { keep: path.join(context.keep, arm) } : {}) });
      provenance ??= {
        // the weekly upstream job regenerates against a newer commit than the pin and says so here
        lock: context.settings.BLIS_COMMIT ?? lockedCommit(),
        catalogHash: raw.result.data.catalog.hash,
        registryHash: raw.result.data.registry.hash,
        engineVersion: raw.result.engine.version,
        routerModule: raw.routerModule
      };
      records[arm] = this.reduce(s, arm, raw);
    }
    return { scenario: s.id, reference: "blis", inputHash: this.inputHash(s), provenance: provenance!, records };
  },
  provenanceProblem(provenance) {
    if (provenance.lock !== lockedCommit()) return "made by another BLIS commit than conformance/refs/blis/lock; regenerate";
    for (const k of ["catalogHash", "registryHash"]) if (!/^[0-9a-f]{64}$/.test(provenance[k] ?? "")) return `provenance.${k} is not a SHA-256`;
    return null;
  }
};
