/**
 * Public interface of the simulation. The user interface imports from here and nowhere deeper.
 */
export { CITATIONS, citeMarkdown, type Citation, type CitationKey } from "./citations.js";
export { CONCEPTS } from "./catalog.js";
export type { ApproachMeta, Concept, Fidelity } from "./approach.js";

export { DEFAULT_PARAMS, RESTART_KEYS, type Params, type Routing } from "./core/params.js";
export type { KvEntry, Metrics, Pod, PodState, Req, Role, RouteDecision, Sample, Session, SimEvent, Stage, StepInfo, Tier, World } from "./core/types.js";
export { createWorld, livePods, podLoad, replicaSpec } from "./core/world.js";

export { GPUS, MODELS, type GpuSpec, type ModelSpec, type Precision, type ReplicaSpec } from "./hardware/catalog.js";
export { attnFlops, flopsPerToken, recomputeRatio, seqLoad } from "./cost/flops.js";
export { kvBytesPerToken, maxBatch, memoryBudget, weightBytes, type MemoryBudget } from "./cost/memory.js";
export { MAX_MEM_UTIL, TIGHT_REQUESTS, fitOf, fitsWith, fixesFor, type Fit, type Fix, type FixKind } from "./cost/fit.js";
export { commSeconds, computeSeconds, launchSeconds, ridge, stepCost, type StepCost, type StepLoad, type StepTiming } from "./cost/roofline.js";
export { decodeCurve } from "./cost/throughput.js";

export { BLOCK_TOKENS, blocksFor } from "./kvcache/blocks.js";
export { DISPLAY_CELLS, activeBlocks } from "./kvcache/hbm.js";
export { tierBw, tierCapBlocks } from "./kvcache/tiers.js";
export { evictIdleNow } from "./kvcache/forced.js";
export { reloadTimes } from "./kvcache/reload.js";
export { SCORER_WEIGHTS, TIER_AFFINITY, prefixAwareTerms } from "./routing/prefixAware.js";
export { POD_QUEUE_SLACK } from "./routing/index.js";
export { MIN_OUTPUT_TOKENS, liveSessions, setSessions, spawnBurst } from "./workload/index.js";
export { loadTrace, type TraceRequest } from "./workload/trace.js";
export { advance, setParam } from "./engine/tick.js";
export { restartFleet } from "./engine/fleet.js";
export { costPerMTok, elapsed, kvFill, median, tokensPerSecond } from "./engine/selectors.js";

export { ARCHITECTURES, DEFAULT_ARCH, type Architecture } from "./presets/architectures.js";
