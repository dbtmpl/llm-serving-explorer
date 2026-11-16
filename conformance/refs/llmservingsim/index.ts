/**
 * LLMServingSim as a reference: a Python port of vLLM's V1 scheduler and block pool (chained block hashes over token ids, tail
 * preemption with recompute, chunked prefill, optional host KV tier, prefill/decode instances) whose step latencies come from
 * per-layer kernel tables profiled on real GPUs (here an RTX PRO 6000 and an RTX 4090). Needs a built checkout only to generate references.
 */
import path from "node:path";
import type { Provenance, ReferenceFile, Reduced } from "../../record.js";
import type { Scenario } from "../../scenario.js";
import type { GenerateContext, Reference } from "../reference.js";
import { lockedCommit } from "./data.js";
import { GPU_NAMES, MODEL_NAMES } from "./names.js";
import { checkoutOf, commitOf, reduceLss, runLss, type LssRaw } from "./run.js";
import { scenarioInputHash, toLss, type LssInput } from "./translate.js";

export const llmservingsim: Reference<LssInput, LssRaw> = {
  id: "llmservingsim",
  name: "LLMServingSim",
  kind: "simulator",
  evidence:
    "A second, independent port of vLLM's V1 scheduler and block pool (admission, tail preemption with recompute, chunked prefill, prefix caching over chained block hashes, a host KV tier) whose step times come from per-layer kernel tables profiled on real GPUs; its authors validated it against real vLLM runs at about 1 to 5 percent error. Agreement shows the TypeScript model makes the same scheduling and caching decisions as a second implementation, and that its timings are within reach of profiled-kernel timings on the two GPUs profiled; it is a simulator, not a measurement. It has no llm-d router (round robin, random and least-loaded only), no shedding or autoscaling, and its KV capacity is derived from the configured memory utilisation without vLLM's activation estimate.",
  supports: {
    models: Object.keys(MODEL_NAMES),
    gpus: Object.keys(GPU_NAMES),
    mechanisms: ["multi-replica", "multi-turn", "disaggregation", "host-offload", "speculative"],
    quantities: ["kv_blocks_per_replica", "prefix_cached_tokens", "routed_pod", "requests_per_pod", "preemptions", "request_fate"],
    metrics: ["ttft_mean_s", "ttft_p50_s", "ttft_p99_s", "tpot_mean_s", "tpot_p50_s", "tpot_p99_s", "e2e_mean_s", "e2e_p50_s", "e2e_p99_s", "throughput_tokens_per_s", "prefix_hit_rate", "cpu_tier_hit_rate", "preemptions", "peak_replicas", "completed"],
    arms: true
  },
  lock: lockedCommit,
  translate: toLss,
  run: (input, context) => runLss(input, context),
  reduce: (s: Scenario, arm: string, raw: LssRaw): Reduced => reduceLss(s, arm, raw, toLss(s, arm)),
  inputHash: scenarioInputHash,
  prepare(context) {
    const dir = checkoutOf(context);
    const head = commitOf(dir);
    if (head !== lockedCommit()) throw new Error(`LLMSERVINGSIM_DIR is at ${head} but conformance/refs/llmservingsim/lock names ${lockedCommit()}`);
  },
  generate(s: Scenario, context: GenerateContext): ReferenceFile {
    const records: Record<string, Reduced> = {};
    let provenance: Provenance | undefined;
    for (const arm of Object.keys(s.arms)) {
      const input = this.translate(s, arm);
      const raw = this.run(input, { ...context, ...(context.keep ? { keep: path.join(context.keep, arm) } : {}) });
      provenance ??= { lock: raw.commit, replay: input.replay ?? "no" };
      records[arm] = reduceLss(s, arm, raw, input);
    }
    return { scenario: s.id, reference: "llmservingsim", inputHash: this.inputHash(s), provenance: provenance!, records };
  },
  provenanceProblem(p) {
    if (p.lock !== lockedCommit()) return "made by another LLMServingSim commit than conformance/refs/llmservingsim/lock; regenerate";
    return null;
  }
};
