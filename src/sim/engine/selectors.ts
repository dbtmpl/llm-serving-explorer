/**
 * Read-only summaries of a world, for the interface and for tests.
 */
import type { World } from "../core/types.js";
import { THROUGHPUT_WINDOW_S, UNITS } from "./constants.js";

/** Seconds since the first request was sent; 0 while none has been. This is the clock the page shows. */
export const elapsed = (w: Pick<World, "t" | "startedAt">): number => (w.startedAt === null ? 0 : w.t - w.startedAt);

/** Output tokens emitted during the last second. */
export function tokensPerSecond(w: Pick<World, "t" | "tokWindow">): number {
  let n = 0;
  for (const b of w.tokWindow) if (b.t >= w.t - THROUGHPUT_WINDOW_S) n += b.n;
  return n;
}

/** Share of ready pods' KV pools that is allocated, in [0, 1]. */
export function kvFill(w: Pick<World, "pods">): number {
  let used = 0;
  let pool = 0;
  for (const pod of w.pods) {
    if (pod.state !== "ready") continue;
    used += pod.usedBlocks;
    pool += pod.budget.poolBlocks;
  }
  return pool ? used / pool : 0;
}

/** Upper median of a list; 0 for an empty one. */
export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Cost of a million output tokens: GPU-seconds paid for, at the hourly price, over tokens emitted.
 *
 * Example: 16 GPUs for 60 s at $2.50 per GPU-hour is $0.67; for 500,000 tokens that is $1.33/M.
 */
export function costPerMTok(w: Pick<World, "m" | "params">): number {
  return w.m.tokensOut ? ((w.m.gpuSeconds * w.params.pricePerGpuHour) / UNITS.SECONDS_PER_HOUR / w.m.tokensOut) * UNITS.TOKENS_PER_MILLION : 0;
}
