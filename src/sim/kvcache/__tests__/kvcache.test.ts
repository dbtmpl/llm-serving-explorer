import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "../../core/params.js";
import { kvBytesPerToken } from "../../cost/memory.js";
import { kinds, replica, run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { BLOCK_TOKENS, blocksFor } from "../blocks.js";
import { leastRecentlyUsed } from "../eviction.js";
import { DISPLAY_CELLS } from "../hbm.js";
import { preemptNewest } from "../preemption.js";
import { blockHashPrefix } from "../prefix.js";
import { evictIdleNow } from "../forced.js";
import { adaptiveReload, reloadTimes } from "../reload.js";

describe("paged blocks (Kwon et al., SOSP 2023)", () => {
  it("a context needs ceil(tokens / 16) blocks and wastes less than one", () => {
    expect(BLOCK_TOKENS).toBe(16);
    expect(blocksFor(3000)).toBe(188);
    expect(blocksFor(16)).toBe(1);
    expect(blocksFor(17)).toBe(2);
    expect(blocksFor(0)).toBe(0);
  });
});

describe("block-hash prefix matching (vLLM automatic prefix caching)", () => {
  const reusable = blockHashPrefix.reusableTokens;
  it("reuses whole blocks only: 2,659 cached tokens serve 2,656 of a 2,786-token context", () => {
    expect(reusable(2659, 2786)).toBe(2656);
    expect(2786 - reusable(2659, 2786)).toBe(130);
  });
  it("always leaves at least one token to compute, for the logits at the last position", () => {
    expect(reusable(3200, 3200)).toBe(3184);
    expect(reusable(16, 16)).toBe(0);
  });
  it("reuses nothing from an empty cache or a partial first block", () => {
    expect(reusable(0, 5000)).toBe(0);
    expect(reusable(15, 5000)).toBe(0);
  });
});

describe("LRU eviction (CachedAttention; vLLM)", () => {
  it("evicts the entry used longest ago", () => {
    const entries = [{ sid: 1, lastUsed: 4 }, { sid: 2, lastUsed: 9 }, { sid: 3, lastUsed: 2 }];
    expect(leastRecentlyUsed.pickVictim(entries)!.sid).toBe(3);
  });
  it("has no victim among no candidates", () => {
    expect(leastRecentlyUsed.pickVictim([])).toBeNull();
  });
});

describe("adaptive reload (LMCache)", () => {
  it("loads when the copy is faster than the prefill, and recomputes otherwise", () => {
    // 393 MB from DRAM at 20 GB/s is 20 ms; prefilling 3,000 tokens takes about 100 ms
    expect(adaptiveReload.shouldLoad(0.02, 0.1)).toBe(true);
    // the same bytes over a 1 Gbit/s link take 3.1 s
    expect(adaptiveReload.shouldLoad(3.1, 0.1)).toBe(false);
    expect(adaptiveReload.shouldLoad(0.1, 0.1)).toBe(true);
  });
});

describe("preemption (vLLM scheduler)", () => {
  const a = { id: "a", admitT: 1.0 };
  const b = { id: "b", admitT: 1.4 };
  const c = { id: "c", admitT: 2.2 };
  it("preempts the most recently admitted sequence", () => {
    expect(preemptNewest.pickVictim([a, b, c], a)).toBe(c);
  });
  it("preempts nobody when the newest sequence is the one asking", () => {
    expect(preemptNewest.pickVictim([a, b, c], c)).toBeNull();
  });
});

describe("the KV cache in the engine", () => {
  it("idle sessions move HBM → DRAM → SSD → shared pool → dropped, and returning ones are loaded back", () => {
    const w = world({ promptTokens: 24000, outputTokens: 40, maxPods: 1, dramGB: 8, ssdGB: 16, remoteGB: 12, returnProb: 0.6, thinkTimeS: 8, maxTurns: 4, scaleDownIdleS: 1e9 });
    spawnBurst(w, 60, 20);
    run(w, 400, () => w.reqs.size === 0 && w.t > 60 && ![...w.sessions.values()].some((s) => s.state === "thinking"));
    const moves = w.events.filter((e) => e.kind === "kv.move");
    expect(moves.some((e) => e.from === "hbm" && e.to === "dram")).toBe(true);
    expect(moves.some((e) => e.from === "dram" && e.to === "ssd")).toBe(true);
    expect(moves.some((e) => e.from === "ssd" && e.to === "remote")).toBe(true);
    expect(kinds(w).has("kv.drop")).toBe(true);
    expect(kinds(w).has("kv.reload")).toBe(true);
    expect(w.m.cachedTokens).toBeGreaterThan(0);
    expect(w.m.failed).toBe(0);
    // the conversation store has every turn, whatever happened to the KV
    expect(w.store.turns).toBe(w.m.completed);
  });
  it("conserves blocks: every tier's counter equals the sum of its entries, and no tier exceeds its capacity", () => {
    const w = world({ promptTokens: 24000, outputTokens: 40, maxPods: 1, dramGB: 8, ssdGB: 16, remoteGB: 12, returnProb: 0.6, thinkTimeS: 8, maxTurns: 4, scaleDownIdleS: 1e9 });
    spawnBurst(w, 60, 20);
    for (let i = 0; i < 40; i++) {
      run(w, 5);
      const pod = w.pods[0];
      if (!pod) continue;
      const held = { hbm: 0, dram: 0, ssd: 0 };
      for (const e of pod.entries.values()) held[e.tier] += e.blocks;
      expect(held.hbm).toBe(pod.usedBlocks);
      expect(held.dram).toBe(pod.dramBlocks);
      expect(held.ssd).toBe(pod.ssdBlocks);
      expect(pod.usedBlocks).toBeLessThanOrEqual(pod.budget.poolBlocks);
      expect(pod.dramBlocks * pod.budget.blockBytes).toBeLessThanOrEqual(8e9);
      expect(pod.ssdBlocks * pod.budget.blockBytes).toBeLessThanOrEqual(16e9);
      expect(w.remoteBytes).toBeLessThanOrEqual(12e9);
      expect([...w.remote.values()].reduce((n, r) => n + r.bytes, 0)).toBe(w.remoteBytes);
      expect(pod.cells.filter((c) => c !== 0).length).toBe(DISPLAY_CELLS - pod.freeCells);
    }
  });
  it("a follow-up turn reuses its cached history and prefills only the new tokens", () => {
    const w = world({ returnProb: 1, maxTurns: 3, thinkTimeS: 1, followTokens: 100 });
    spawnBurst(w, 5);
    run(w, 120, () => w.m.completed === 15);
    expect(w.m.completed).toBe(15);
    const followUps = w.events.filter((e) => e.kind === "req.admitted" && (e.turn as number) > 1);
    expect(followUps.length).toBe(10);
    for (const e of followUps) expect((e.lIn as number) - (e.cached as number)).toBeLessThan(200);
  });
  it("without prefix caching nothing is reused", () => {
    const w = world({ prefixCaching: false, returnProb: 1, maxTurns: 2, thinkTimeS: 1 });
    spawnBurst(w, 5);
    run(w, 120, () => w.m.completed === 10);
    expect(w.m.cachedTokens).toBe(0);
  });
  it("a scaled-down pod takes its node tiers with it; the session is rebuilt from text", () => {
    const w = world({ returnProb: 1, maxTurns: 2, thinkTimeS: 6, scaleDownIdleS: 1 });
    spawnBurst(w, 1);
    run(w, 60, () => w.m.completed === 2);
    expect(w.m.completed).toBe(2);
    expect(kinds(w).has("scale.down")).toBe(true);
    expect(w.events.filter((e) => e.kind === "req.admitted").at(-1)!.cached).toBe(0);
  });
});

describe("forced eviction (used only by the step-through walkthrough)", () => {
  /** One finished request whose session goes idle, with caching on. */
  const idleWorld = (over = {}) => {
    const w = world({ returnProb: 0, maxPods: 1, ...over });
    spawnBurst(w, 1);
    run(w, 60, () => w.m.completed === 1);
    w.events.length = 0;
    return w;
  };
  it("moves the idle session's KV from HBM to DRAM and emits the same kv.move a real eviction does", () => {
    const w = idleWorld();
    const pod = w.pods[0]!;
    const e = pod.entries.get(1)!;
    expect(e.tier).toBe("hbm");
    const blocks = e.blocks;
    const cells = e.cells.length;
    expect(evictIdleNow(w, 1, pod.id)).toBe(true);
    const moves = w.events.filter((x) => x.kind === "kv.move");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ sid: 1, podId: pod.id, from: "hbm", to: "dram", tokens: e.tokens });
    expect((moves[0]!.cells as number[]).length).toBe(cells);
    expect(e.tier).toBe("dram");
    expect(pod.usedBlocks).toBe(0);
    expect(pod.dramBlocks).toBe(blocks);
    expect(w.m.evictions).toBe(1);
  });
  it("drops the KV when no tier has room, and the session is then rebuilt from text", () => {
    const w = idleWorld({ dramGB: 0, ssdGB: 0, remoteGB: 0 });
    expect(evictIdleNow(w, 1)).toBe(true);
    expect(w.events.some((x) => x.kind === "kv.drop" && x.sid === 1)).toBe(true);
    expect(w.pods[0]!.entries.has(1)).toBe(false);
  });
  it("does nothing for a session that is running, unknown, or not in GPU memory", () => {
    const w = world({ returnProb: 0, maxPods: 1 });
    spawnBurst(w, 1);
    run(w, 4, () => w.reqs.size > 0 && w.pods[0]?.entries.get(1)?.active === true);
    expect(w.pods[0]!.entries.get(1)?.active).toBe(true);
    expect(evictIdleNow(w, 1)).toBe(false);
    expect(evictIdleNow(w, 99)).toBe(false);
    run(w, 60, () => w.m.completed === 1);
    expect(evictIdleNow(w, 1, 12345)).toBe(false);
    expect(evictIdleNow(w, 1)).toBe(true);
    expect(evictIdleNow(w, 1)).toBe(false);
  });
});

describe("reload estimate", () => {
  it("matches the documented example: 3,000 tokens from DRAM load, over a 1 Gbit/s link they are recomputed", () => {
    const spec = replica();
    const bytes = 3000 * kvBytesPerToken(spec.model);
    const dram = reloadTimes({ ...DEFAULT_PARAMS, dramGBs: 20 }, spec, "dram", bytes, 3000);
    expect(dram.loadSeconds).toBeCloseTo(0.0197, 3);
    expect(dram.recomputeSeconds).toBeGreaterThan(0.05);
    expect(dram.recomputeSeconds).toBeLessThan(0.15);
    expect(dram.loads).toBe(true);
    const slow = reloadTimes({ ...DEFAULT_PARAMS, remoteGbps: 1 }, spec, "remote", bytes, 3000);
    expect(slow.loadSeconds).toBeCloseTo(3.1, 1);
    expect(slow.loads).toBe(false);
  });
});
