/**
 * Reload decision: a session's KV sits in a lower tier. Load it back, or compute it again?
 */
import type { ApproachMeta } from "../approach.js";
import type { Params } from "../core/params.js";
import type { ReplicaSpec } from "../hardware/catalog.js";
import { seqLoad } from "../cost/flops.js";
import { computeSeconds } from "../cost/roofline.js";
import { tierBw } from "./tiers.js";

export interface ReloadPolicy extends ApproachMeta {
  shouldLoad(loadSeconds: number, recomputeSeconds: number): boolean;
}

/**
 * Adaptive loading: load only when that is faster than recomputing.
 *
 * Source: LMCache (Liu et al., 2025). Loading KV is a copy at storage or network bandwidth;
 * recomputing is a prefill at GPU compute speed. Which wins depends on the tier, the context
 * length and how busy the GPU is, so the paper argues the choice should be made per request.
 *
 *     load  ⇔  bytes / tierBandwidth  ≤  prefillFlops / (tp · peak · MFU)
 *
 * Example: 3,000 tokens of Llama 3.1 8B KV are 393 MB. From DRAM at 20 GB/s that is 20 ms; a
 * prefill of 3,000 tokens on an H100 at MFU 0.5 takes about 100 ms, so the copy is loaded. From a
 * 1 Gbit/s link it would take 3.1 s, so the context is recomputed.
 *
 * Simplification: the comparison ignores queueing for the GPU and overlap of loading with
 * compute, both of which LMCache and CacheGen (Liu et al., SIGCOMM 2024) exploit.
 */
export const adaptiveReload: ReloadPolicy = {
  id: "adaptive",
  name: "Adaptive load-or-recompute",
  summary: "Load KV from a lower tier only when copying is faster than prefilling again.",
  citations: ["lmcache2025", "liu2023"],
  fidelity: "simplified",
  shouldLoad: (loadSeconds, recomputeSeconds) => loadSeconds <= recomputeSeconds
};

/**
 * The two costs the reload decision compares, for KV of `tokens` tokens and `bytes` bytes that sits
 * in `tier`: copying it back to GPU memory, and computing it again from the stored text. Used to
 * show the decision; the engine makes the same comparison when a returning session is admitted.
 */
export function reloadTimes(params: Params, spec: ReplicaSpec, tier: "dram" | "ssd" | "remote", bytes: number, tokens: number): { loadSeconds: number; recomputeSeconds: number; loads: boolean } {
  const loadSeconds = bytes / tierBw(params)[tier];
  const recomputeSeconds = computeSeconds(spec, seqLoad(spec.model, 0, tokens).flops, params.mfu);
  return { loadSeconds, recomputeSeconds, loads: adaptiveReload.shouldLoad(loadSeconds, recomputeSeconds) };
}
