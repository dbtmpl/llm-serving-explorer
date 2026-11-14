/**
 * Bookkeeping for the KV block pool in GPU memory (HBM) of one pod.
 */
import type { KvEntry, Pod } from "../core/types.js";
import { blocksFor } from "./blocks.js";

/**
 * Cells in the interface's picture of a pod's KV pool. A pool has tens of thousands of blocks;
 * each cell stands for `poolBlocks / DISPLAY_CELLS` of them.
 */
export const DISPLAY_CELLS = 200;

/** Multipliers that scatter a session's cells across the grid; any free block will do when memory is paged. */
const CELL_SCATTER = { session: 2654435761, index: 40503 } as const;

/** Bring an entry's display cells in line with the blocks it holds that contain tokens. */
export function syncCells(pod: Pod, e: KvEntry): void {
  const blocksPerCell = pod.budget.poolBlocks / DISPLAY_CELLS;
  // cells show blocks that hold tokens, so a reservation fills in as prefill writes it
  const filled = Math.min(e.blocks, blocksFor(Math.max(1, e.tokens)));
  const target = e.tier === "hbm" && e.blocks > 0 ? Math.max(1, Math.round(filled / blocksPerCell)) : 0;
  while (e.cells.length < target && pod.freeCells > 0) {
    let c = (Math.imul(e.sid * CELL_SCATTER.session + e.cells.length * CELL_SCATTER.index + pod.steps, 1) >>> 0) % DISPLAY_CELLS;
    while (pod.cells[c] !== 0) c = (c + 1) % DISPLAY_CELLS;
    pod.cells[c] = e.sid;
    pod.freeCells--;
    e.cells.push(c);
  }
  while (e.cells.length > target) {
    pod.cells[e.cells.pop()!] = 0;
    pod.freeCells++;
  }
}

/** Give all of an entry's HBM blocks back to the pool. Returns the display cells it occupied. */
export function releaseHbm(pod: Pod, e: KvEntry): number[] {
  const cells = e.cells.slice();
  pod.usedBlocks -= e.blocks;
  for (const c of e.cells) pod.cells[c] = 0;
  pod.freeCells += e.cells.length;
  e.cells = [];
  return cells;
}

/** Return blocks an entry holds beyond what `tokens` tokens need (an unused reservation). */
export function shrinkTo(pod: Pod, e: KvEntry, tokens: number): void {
  const extra = e.blocks - blocksFor(Math.max(1, tokens));
  if (extra > 0) {
    e.blocks -= extra;
    pod.usedBlocks -= extra;
  }
  syncCells(pod, e);
}

/** Blocks held by sequences that are running, as opposed to cached and evictable. */
export function activeBlocks(pod: Pod): number {
  let n = 0;
  for (const e of pod.entries.values()) if (e.tier === "hbm" && e.active) n += e.blocks;
  return n;
}
