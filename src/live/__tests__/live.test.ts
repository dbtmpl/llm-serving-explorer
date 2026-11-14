import { describe, expect, it } from "vitest";
import { GPUS, MODELS, attnFlops, decodeCurve, kvBytesPerToken, maxBatch, memoryBudget, recomputeRatio, ridge, seqLoad, stepCost, weightBytes, type ReplicaSpec } from "../model.js";
import { DEFAULT_PARAMS, advance, createWorld, setParam, spawnBurst, type World } from "../sim.js";

const m8 = MODELS["llama-3.1-8b"]!;
const m70 = MODELS["llama-3-70b"]!;
const h100 = GPUS.h100!;
const spec = (over: Partial<ReplicaSpec> = {}): ReplicaSpec => ({ model: m8, gpu: h100, precision: "bf16", tp: 1, gpuMemUtil: 0.9, ...over });

describe("model.ts reproduces the numbers printed in the reference notes", () => {
  it("KV bytes per token (2.7)", () => {
    expect(kvBytesPerToken(m8)).toBe(131072);
    expect(kvBytesPerToken(m70)).toBe(327680);
  });
  it("attention FLOPs per token of context (2.2)", () => {
    expect(attnFlops(m8, 1)).toBe(524288);
    expect(attnFlops(m70, 1)).toBe(2621440);
  });
  it("memory budgets (2.9)", () => {
    expect(memoryBudget(spec()).kv / 1e9).toBeCloseTo(55.2, 1);
    expect(memoryBudget(spec({ model: m70, tp: 4 })).kv / 1e9).toBeCloseTo(35.66, 1);
    expect(memoryBudget(spec({ model: m70, tp: 2 })).kv / 1e9).toBeCloseTo(0.66, 1);
    expect(memoryBudget(spec({ model: m70 })).fits).toBe(false);
    expect(maxBatch(spec(), 4096)).toBe(102);
    expect(maxBatch(spec({ model: m70, tp: 4 }), 4096)).toBe(106);
    expect(Math.abs(memoryBudget(spec()).poolBlocks - 26323)).toBeLessThan(5);
  });
  it("ridge points (2.5)", () => {
    expect(ridge(h100)).toBeCloseTo(295.4, 1);
    expect(ridge(GPUS.b200!)).toBeCloseTo(292.2, 1);
  });
  it("decode step floor at B=64, L=2048 is 9.92 ms and memory-bound (2.6)", () => {
    const bytes = weightBytes(m8, "bf16") + 64 * 2048 * kvBytesPerToken(m8);
    const c = stepCost(spec(), { tokens: 64, flops: 64 * 2 * m8.N, bytes }, 1, 1);
    expect(c.tGpu * 1e3).toBeCloseTo(9.92, 2);
    expect(c.bound).toBe("memory");
    expect(c.intensity).toBeCloseTo(30.9, 1);
  });
  it("a 2,048-token prefill is compute-bound, far right of the ridge", () => {
    const l = seqLoad(m8, 0, 2048);
    const c = stepCost(spec(), { tokens: 2048, flops: l.flops, bytes: weightBytes(m8, "bf16") + l.kvBytes }, 1, 1);
    expect(c.bound).toBe("compute");
    expect(c.intensity).toBeGreaterThan(ridge(h100));
  });
  it("batch-throughput curve (2.12) and recompute ratio (3.3)", () => {
    const c = decodeCurve(spec(), 2048, 1);
    expect(c.bHalf).toBeCloseTo(59.8, 1);
    expect(c.xInf).toBeCloseTo(12480, -1);
    expect(recomputeRatio(2000, 500)).toBeCloseTo(450, 0);
  });
});

function run(w: World, seconds: number, until?: () => boolean): void {
  for (let i = 0; i < seconds / 0.05; i++) {
    advance(w, 0.05);
    if (until?.()) return;
  }
}
const kinds = (w: World) => new Set(w.events.map((e) => e.kind));

describe("live simulation", () => {
  it("starts empty and builds a pod for the first request, which then completes", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, returnProb: 0 });
    expect(w.pods.length).toBe(0);
    spawnBurst(w, 1);
    run(w, 30, () => w.m.completed === 1);
    expect(w.m.completed).toBe(1);
    const order = w.events.map((e) => e.kind);
    for (const k of ["req.new", "req.tokenized", "pod.created", "pod.ready", "req.routed", "req.admitted", "req.firstToken", "req.done"]) expect(order).toContain(k);
    expect(order.indexOf("pod.ready")).toBeLessThan(order.indexOf("req.routed"));
    expect(w.m.ttft[0]!).toBeGreaterThan(DEFAULT_PARAMS.coldStartS);
  });

  it("100 requests at once scale to ceil(100 / max_num_seqs) pods and all finish", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, returnProb: 0 });
    spawnBurst(w, 100);
    run(w, 1);
    expect(w.pods.length).toBe(9);
    run(w, 120, () => w.m.completed === 100);
    expect(w.m.completed).toBe(100);
    for (const pod of w.pods) expect(pod.usedBlocks).toBeLessThanOrEqual(pod.budget.poolBlocks);
  });

  it("idle sessions are evicted HBM -> DRAM -> SSD -> remote pool -> dropped, and returning ones reload", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, promptTokens: 24000, outputTokens: 40, maxPods: 1, dramGB: 8, ssdGB: 16, remoteGB: 12, returnProb: 0.6, thinkTimeS: 8, maxTurns: 4, scaleDownIdleS: 1e9 });
    spawnBurst(w, 60, 20);
    run(w, 400, () => w.reqs.size === 0 && w.t > 60 && ![...w.sessions.values()].some((s) => s.state === "thinking"));
    const moves = w.events.filter((e) => e.kind === "kv.move");
    expect(moves.some((e) => e.from === "hbm" && e.to === "dram")).toBe(true);
    expect(moves.some((e) => e.from === "dram" && e.to === "ssd")).toBe(true);
    expect(moves.some((e) => e.from === "ssd" && e.to === "remote")).toBe(true);
    expect(kinds(w).has("kv.drop")).toBe(true);
    expect(w.remoteBytes).toBeLessThanOrEqual(12e9);
    expect([...w.remote.values()].reduce((n, r) => n + r.bytes, 0)).toBe(w.remoteBytes);
    expect(w.store.turns).toBe(w.m.completed);
    expect(kinds(w).has("kv.reload")).toBe(true);
    expect(w.m.cachedTokens).toBeGreaterThan(0);
    const pod = w.pods[0]!;
    let hbm = 0;
    let dram = 0;
    let ssd = 0;
    for (const e of pod.entries.values()) {
      if (e.tier === "hbm") hbm += e.blocks;
      else if (e.tier === "dram") dram += e.blocks;
      else ssd += e.blocks;
    }
    expect(hbm).toBe(pod.usedBlocks);
    expect(dram).toBe(pod.dramBlocks);
    expect(ssd).toBe(pod.ssdBlocks);
    expect(pod.cells.filter((c) => c !== 0).length).toBe(200 - pod.freeCells);
    expect(w.m.failed).toBe(0);
  });

  it("on-demand allocation preempts by recomputation under overload and thrashes; reserving to completion never preempts", () => {
    const base = { ...DEFAULT_PARAMS, promptTokens: 36000, outputTokens: 3000, maxPods: 1, maxNumSeqs: 16, returnProb: 0 };
    const onDemand = createWorld({ ...base, admission: "on-demand" });
    spawnBurst(onDemand, 16);
    run(onDemand, 2500, () => onDemand.m.completed + onDemand.m.failed === 16);
    expect(onDemand.m.completed).toBe(16);
    expect(onDemand.m.preemptions).toBeGreaterThan(10);

    const reserve = createWorld({ ...base, admission: "reserve" });
    spawnBurst(reserve, 16);
    run(reserve, 2500, () => reserve.m.completed + reserve.m.failed === 16);
    expect(reserve.m.completed).toBe(16);
    expect(reserve.m.preemptions).toBe(0);
    expect(reserve.t).toBeLessThan(onDemand.t);
  });

  it("static batching makes late arrivals wait for the whole batch; continuous batching does not", () => {
    const ttft = (batching: "static" | "continuous") => {
      const w = createWorld({ ...DEFAULT_PARAMS, batching, maxPods: 1, minPods: 1, returnProb: 0, outputTokens: 400 });
      run(w, 5);
      spawnBurst(w, 4);
      run(w, 1.5);
      spawnBurst(w, 1);
      run(w, 120, () => w.m.completed === 5);
      return Math.max(...w.m.ttft);
    };
    expect(ttft("static")).toBeGreaterThan(3 * ttft("continuous"));
  });

  it("disaggregated serving prefills on one pool, hands the KV over, and decodes on another", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, disagg: true, returnProb: 1, maxTurns: 2, thinkTimeS: 1, scaleDownIdleS: 1e9 });
    spawnBurst(w, 20);
    run(w, 200, () => w.m.completed === 40);
    expect(w.m.completed).toBe(40);
    const roles = new Set(w.pods.map((p) => p.role));
    expect(roles.has("prefill") && roles.has("decode")).toBe(true);
    const transfers = w.events.filter((e) => e.kind === "kv.transfer");
    expect(transfers.length).toBe(20);
    for (const pod of w.pods) if (pod.role === "prefill") expect(pod.tokensOut).toBe(0);
    // follow-up turns find their history on the decode pod and skip the prefill pool
    const second = w.events.filter((e) => e.kind === "req.routed" && e.via === "decode-only");
    expect(second.length).toBe(20);
  });

  it("speculative decoding emits more than one token per sequence per step", () => {
    const steps = (specDecode: boolean) => {
      const w = createWorld({ ...DEFAULT_PARAMS, specDecode, returnProb: 0, outputTokens: 300 });
      spawnBurst(w, 4);
      run(w, 120, () => w.m.completed === 4);
      return w.pods[0]!.steps;
    };
    expect(steps(true)).toBeLessThan(0.6 * steps(false));
  });

  it("flow control sheds requests that wait too long at the router", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, maxPods: 1, shedAfterS: 3, returnProb: 0, outputTokens: 600 });
    spawnBurst(w, 80);
    run(w, 200, () => w.reqs.size === 0);
    expect(w.m.failed).toBeGreaterThan(10);
    expect(w.m.completed + w.m.failed).toBe(80);
  });

  it("changing the model mid-run restarts the fleet and still serves every request", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, returnProb: 0 });
    spawnBurst(w, 10);
    run(w, 3);
    setParam(w, "model", "llama-3-70b");
    setParam(w, "tp", 4);
    run(w, 200, () => w.m.completed === 10);
    expect(w.m.completed).toBe(10);
    expect(w.pods.every((p) => p.spec.tp === 4)).toBe(true);
  });

  it("a 70B model on 2 x H100 loads but has no room for a batch", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, model: "llama-3-70b", tp: 2, promptTokens: 8000 });
    spawnBurst(w, 1);
    run(w, 10);
    expect(w.pods[0]!.state).toBe("ready");
    expect(w.m.failed).toBe(1);
    const one = createWorld({ ...DEFAULT_PARAMS, model: "llama-3-70b", tp: 1 });
    spawnBurst(one, 1);
    run(one, 10);
    expect(one.pods[0]!.state).toBe("failed");
  });

  it("follow-up turns reuse cached history: only the new tokens are prefilled", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, returnProb: 1, maxTurns: 3, thinkTimeS: 1, followTokens: 100 });
    spawnBurst(w, 5);
    run(w, 120, () => w.m.completed === 15);
    expect(w.m.completed).toBe(15);
    const follow = w.events.filter((e) => e.kind === "req.admitted" && (e.turn as number) > 1);
    expect(follow.length).toBe(10);
    for (const e of follow) expect((e.lIn as number) - (e.cached as number)).toBeLessThan(200);
    expect(kinds(w).has("req.followup")).toBe(true);
    expect(kinds(w).has("store.read")).toBe(true);
  });

  it("a scaled-down pod loses its node tiers; the session is rebuilt from text or the remote pool", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, returnProb: 1, maxTurns: 2, thinkTimeS: 6, scaleDownIdleS: 1 });
    spawnBurst(w, 1);
    run(w, 60, () => w.m.completed === 2);
    expect(w.m.completed).toBe(2);
    expect(kinds(w).has("scale.down")).toBe(true);
    const second = w.events.filter((e) => e.kind === "req.admitted").at(-1)!;
    expect(second.cached).toBe(0);
  });

  it("10,000 sessions at once stay within the pod cap and keep making progress", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, returnProb: 0 });
    spawnBurst(w, 10000);
    const t0 = performance.now();
    run(w, 6);
    expect(performance.now() - t0).toBeLessThan(4000);
    expect(w.sessions.size).toBe(10000);
    expect(w.pods.length).toBe(DEFAULT_PARAMS.maxPods);
    expect(w.m.completed).toBeGreaterThan(100);
    expect(w.gatewayQueue.length).toBeGreaterThan(8000);
  });

  it("speculative decoding matches Leviathan et al.: tokens per step (eq. 1) and speed-up (theorem 3.8)", () => {
    const alpha = 0.7;
    const gamma = 4;
    const c = 0.04;
    const stats = (specDecode: boolean) => {
      // one sequence, no host overhead, so a step is one target-model run (plus drafts)
      const w = createWorld({ ...DEFAULT_PARAMS, specDecode, specAccept: alpha, specK: gamma, specCost: c, hostMsBase: 0, hostMsPerSeq: 0, returnProb: 0, outputTokens: 1500, promptTokens: 200 }, 11);
      spawnBurst(w, 6, 400);
      run(w, 2000, () => w.m.completed === 6);
      const tpot = w.m.tpot.reduce((a, b) => a + b, 0) / w.m.tpot.length;
      return { tokensPerStep: w.m.tokensOut / w.pods.reduce((n, p) => n + p.steps, w.m.completed * 0) || 0, tpot, w };
    };
    const off = stats(false);
    const on = stats(true);
    const expectedTokens = (1 - alpha ** (gamma + 1)) / (1 - alpha);
    const expectedSpeedup = expectedTokens / (gamma * c + 1);
    const decodeSteps = on.w.events.filter((e) => e.kind === "step.tokens").length;
    expect(on.w.m.tokensOut / decodeSteps).toBeGreaterThan(expectedTokens * 0.93);
    expect(on.w.m.tokensOut / decodeSteps).toBeLessThan(expectedTokens * 1.07);
    expect(off.tpot / on.tpot).toBeGreaterThan(expectedSpeedup * 0.9);
    expect(off.tpot / on.tpot).toBeLessThan(expectedSpeedup * 1.1);
  });

  it("TPOT equals the engine step time, not the step time rounded up to the clock tick", () => {
    const w = createWorld({ ...DEFAULT_PARAMS, hostMsBase: 0, hostMsPerSeq: 0, returnProb: 0, outputTokens: 1500, promptTokens: 200 });
    spawnBurst(w, 1);
    run(w, 60, () => w.m.completed === 1);
    // batch 1, short context: 16.06 GB of weights at 3.35 TB/s x MBU 0.6 = 8.0 ms
    expect(w.m.tpot[0]! * 1e3).toBeGreaterThan(7.95);
    expect(w.m.tpot[0]! * 1e3).toBeLessThan(8.15);
  });
});
