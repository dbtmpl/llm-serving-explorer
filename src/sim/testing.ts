/**
 * Helpers shared by the unit tests of the simulation modules.
 */
import { DEFAULT_PARAMS, type Params } from "./core/params.js";
import type { World } from "./core/types.js";
import { createWorld } from "./core/world.js";
import { GPUS, MODELS, type ReplicaSpec } from "./hardware/catalog.js";
import { advance } from "./engine/tick.js";

const STEP_S = 0.05;

/** Advance a world for up to `seconds`, stopping early once `until` holds. */
export function run(w: World, seconds: number, until?: () => boolean): void {
  for (let i = 0; i < seconds / STEP_S; i++) {
    advance(w, STEP_S);
    if (until?.()) return;
  }
}

/** The kinds of event a world has logged. */
export const kinds = (w: World): Set<string> => new Set(w.events.map((e) => e.kind));

/** A world with the default parameters plus overrides. */
export const world = (over: Partial<Params> = {}, seed?: number): World => createWorld({ ...DEFAULT_PARAMS, ...over }, seed);

export const LLAMA_8B = MODELS["llama-3.1-8b"]!;
export const LLAMA_70B = MODELS["llama-3.1-70b"]!;
export const H100 = GPUS.h100!;

/** Llama 3.1 8B in BF16 on one H100 at 0.9 memory utilisation, plus overrides. */
export const replica = (over: Partial<ReplicaSpec> = {}): ReplicaSpec => ({ model: LLAMA_8B, gpu: H100, precision: "bf16", tp: 1, gpuMemUtil: 0.9, ...over });
