/**
 * Whether a configuration can serve at all, how small its KV pool is, and which single changes
 * would make it fit. The interface uses this to warn before a change is made (menus), to explain a
 * pod that cannot start (banner, restart note) and to offer the way out as buttons.
 */
import type { Params } from "../core/params.js";
import { replicaSpec } from "../core/world.js";
import { GPUS, MODELS, type Precision } from "../hardware/catalog.js";
import { BLOCK_TOKENS } from "../kvcache/blocks.js";
import { memoryBudget, type MemoryBudget } from "./memory.js";

/** A pool that holds fewer average requests than this is reported as very small. */
export const TIGHT_REQUESTS = 4;

/** Highest `gpu_memory_utilization` the settings menu offers. */
export const MAX_MEM_UTIL = 0.98;

/** What a fix changes in the interface's wording. */
export type FixKind = "util" | "precision" | "tp" | "gpu" | "model";

/** One change of settings that makes the replica fit. */
export interface Fix {
  kind: FixKind;
  /** The parameters to set (one key, so one fleet restart). */
  changes: Partial<Params>;
  /** The new value in words: a utilisation, GPU count, GPU name or model name; empty for precision. */
  value: string;
  /** KV tokens one pod holds after the change. */
  poolTokens: number;
  /** Whether that pool holds at least `TIGHT_REQUESTS` average requests. */
  comfortable: boolean;
}

export interface Fit {
  fits: boolean;
  budget: MemoryBudget;
  /** Bytes per GPU that weights, working space and CUDA graphs take. */
  needBytes: number;
  /** Bytes per GPU the engine may use (`gpu_memory_utilization` of the device). */
  usableBytes: number;
  /** Tokens of KV one pod holds. */
  poolTokens: number;
  /** Average requests (prompt plus answer) that fit in the pool at once. */
  poolRequests: number;
  /** Fits, but the pool holds fewer than `TIGHT_REQUESTS` average requests. */
  tight: boolean;
}

const known = (p: Params): boolean => !!MODELS[p.model] && !!GPUS[p.gpu];

/** The memory picture of the replica these parameters describe. Unknown model or GPU ids (a replay's) count as fitting. */
export function fitOf(p: Params): Fit {
  if (!known(p)) {
    const budget = memoryBudget(replicaSpec({ ...p, model: "llama-3.1-8b", gpu: "h100" }));
    return { fits: true, budget, needBytes: 0, usableBytes: 0, poolTokens: Infinity, poolRequests: Infinity, tight: false };
  }
  const budget = memoryBudget(replicaSpec(p));
  const poolTokens = budget.poolBlocks * BLOCK_TOKENS;
  const avg = Math.max(1, p.promptTokens + p.outputTokens);
  const poolRequests = poolTokens / avg;
  const fits = budget.fits;
  return {
    fits,
    budget,
    needBytes: budget.weights + budget.activations + budget.graphs + budget.runtime,
    usableBytes: budget.device - budget.headroom,
    poolTokens,
    poolRequests,
    tight: fits && poolRequests < TIGHT_REQUESTS
  };
}

/** Whether the parameters, with these changes applied, describe a replica that can serve. */
export const fitsWith = (p: Params, changes: Partial<Params>): boolean => fitOf({ ...p, ...changes }).fits;

const TP_OPTIONS = [1, 2, 4, 8];

/**
 * The single changes that make a replica that does not fit (or barely fits) able to serve, from the
 * catalogue. Those that leave room for several average requests come first; within each group the
 * order is smallest change first: a little more memory, lower-precision weights, more GPUs per pod,
 * another GPU, a smaller model. At most one fix of each kind is offered (its mildest form).
 */
export function fixesFor(p: Params): Fix[] {
  if (!known(p)) return [];
  const out: Fix[] = [];
  const consider = (kind: FixKind, candidates: { changes: Partial<Params>; value: string }[]): void => {
    const fitted = candidates.map((c) => ({ ...c, fit: fitOf({ ...p, ...c.changes }) })).filter((c) => c.fit.fits);
    const pick = fitted.find((c) => !c.fit.tight) ?? fitted[fitted.length - 1];
    if (pick) out.push({ kind, changes: pick.changes, value: pick.value, poolTokens: pick.fit.poolTokens, comfortable: !pick.fit.tight });
  };
  const utils: { changes: Partial<Params>; value: string }[] = [];
  for (let u = Math.round(p.gpuMemUtil * 100) + 1; u <= MAX_MEM_UTIL * 100; u++) utils.push({ changes: { gpuMemUtil: u / 100 }, value: (u / 100).toFixed(2) });
  consider("util", utils);
  if (p.precision !== "fp8") consider("precision", [{ changes: { precision: "fp8" as Precision }, value: "" }]);
  consider(
    "tp",
    TP_OPTIONS.filter((t) => t > p.tp).map((t) => ({ changes: { tp: t }, value: String(t) }))
  );
  consider(
    "gpu",
    Object.values(GPUS)
      .filter((g) => g.id !== p.gpu && g.memory > GPUS[p.gpu]!.memory)
      .sort((a, b) => a.memory - b.memory)
      .map((g) => ({ changes: { gpu: g.id }, value: g.label.replace(" SXM", "") }))
  );
  consider(
    "model",
    Object.values(MODELS)
      .filter((m) => m.N < MODELS[p.model]!.N)
      .sort((a, b) => b.N - a.N)
      .map((m) => ({ changes: { model: m.id }, value: m.label }))
  );
  return [...out.filter((f) => f.comfortable), ...out.filter((f) => !f.comfortable)];
}
