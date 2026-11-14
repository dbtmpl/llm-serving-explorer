import { describe, expect, it } from "vitest";
import { GPUS } from "../../hardware/catalog.js";
import { H100, LLAMA_70B, LLAMA_8B, replica, run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { attnFlops, flopsPerToken, recomputeRatio, seqLoad } from "../flops.js";
import { hostSeconds, stepSeconds } from "../host.js";
import { activationBytes, kvBytesPerToken, maxBatch, memoryBudget, weightBytes } from "../memory.js";
import { computeSeconds, ridge, stepCost } from "../roofline.js";
import { decodeCurve } from "../throughput.js";

describe("FLOPs per token (Kaplan et al. 2020; Vaswani et al. 2017)", () => {
  it("is 2N through the weights", () => {
    expect(flopsPerToken(LLAMA_8B)).toBe(2 * 8.03e9);
  });
  it("adds 4 · layers · heads · d_head per cached token of attention", () => {
    expect(attnFlops(LLAMA_8B, 1)).toBe(4 * 32 * 32 * 128); // 524,288
    expect(attnFlops(LLAMA_70B, 1)).toBe(4 * 80 * 64 * 128); // 2,621,440
  });
  it("prices n new tokens after p cached ones as n·2N plus attention over Σ(p + i)", () => {
    const p = 100;
    const n = 4;
    const attended = 101 + 102 + 103 + 104;
    expect(seqLoad(LLAMA_8B, p, n).flops).toBe(n * 2 * LLAMA_8B.N + 524288 * attended);
    expect(seqLoad(LLAMA_8B, p, n).kvBytes).toBe((p + n) * 131072);
  });
  it("a decode loop without a KV cache does about L_out·(L_in + L_out/2)/(L_in + L_out) times the work", () => {
    expect(recomputeRatio(2000, 500)).toBeCloseTo(450, 0);
  });
});

describe("memory (Kwon et al. 2023; vLLM engine arguments; Shoeybi et al. 2019)", () => {
  it("KV bytes per token are 2 · layers · kv_heads · d_head · 2 bytes", () => {
    expect(kvBytesPerToken(LLAMA_8B)).toBe(2 * 32 * 8 * 128 * 2); // 131,072
    expect(kvBytesPerToken(LLAMA_70B)).toBe(2 * 80 * 8 * 128 * 2); // 327,680
  });
  it("weights are parameters times bytes per parameter", () => {
    expect(weightBytes(LLAMA_8B, "bf16") / 1e9).toBeCloseTo(16.06, 2);
    expect(weightBytes(LLAMA_8B, "fp8") / 1e9).toBeCloseTo(8.03, 2);
  });
  it("the KV pool is what weights, activations and headroom leave: 80 − 16.06 − 0.74 − 8 = 55.2 GB", () => {
    expect(activationBytes(LLAMA_8B) / 1e9).toBeCloseTo(0.735, 2);
    const b = memoryBudget(replica());
    expect(b.kv / 1e9).toBeCloseTo(55.2, 1);
    expect(b.headroom / 1e9).toBeCloseTo(8, 6);
    expect(Math.abs(b.poolBlocks - 26323)).toBeLessThan(5);
    expect(b.blockBytes).toBe(16 * 131072);
  });
  it("tensor parallelism splits the weights: 70B fits on 4 H100s, barely on 2, not on 1", () => {
    expect(memoryBudget(replica({ model: LLAMA_70B, tp: 4 })).kv / 1e9).toBeCloseTo(35.66, 1);
    expect(memoryBudget(replica({ model: LLAMA_70B, tp: 2 })).kv / 1e9).toBeCloseTo(0.66, 1);
    expect(memoryBudget(replica({ model: LLAMA_70B })).fits).toBe(false);
  });
  it("the largest batch at 4,096 tokens of context is pool bytes over bytes per sequence", () => {
    expect(maxBatch(replica(), 4096)).toBe(102);
    expect(maxBatch(replica({ model: LLAMA_70B, tp: 4 }), 4096)).toBe(106);
  });
});

describe("roofline (Williams et al. 2009)", () => {
  it("the ridge point is peak compute over memory bandwidth", () => {
    expect(ridge(H100)).toBeCloseTo(295.4, 1);
    expect(ridge(GPUS.b200!)).toBeCloseTo(292.2, 1);
  });
  it("a decode step of 64 sequences at 2,048 tokens takes 9.92 ms and is memory-bound", () => {
    const bytes = weightBytes(LLAMA_8B, "bf16") + 64 * 2048 * kvBytesPerToken(LLAMA_8B);
    const c = stepCost(replica(), { tokens: 64, flops: 64 * 2 * LLAMA_8B.N, bytes }, 1, 1);
    expect(c.tMem * 1e3).toBeCloseTo(9.92, 2);
    expect(c.tCompute * 1e3).toBeCloseTo(1.04, 2);
    expect(c.tGpu).toBe(c.tMem);
    expect(c.bound).toBe("memory");
    expect(c.intensity).toBeCloseTo(30.9, 1);
  });
  it("a 2,048-token prefill is compute-bound, right of the ridge", () => {
    const l = seqLoad(LLAMA_8B, 0, 2048);
    const c = stepCost(replica(), { tokens: 2048, flops: l.flops, bytes: weightBytes(LLAMA_8B, "bf16") + l.kvBytes }, 1, 1);
    expect(c.bound).toBe("compute");
    expect(c.intensity).toBeGreaterThan(ridge(H100));
  });
  it("utilisation factors and tensor parallelism scale the rates", () => {
    const load = { tokens: 1, flops: 1e12, bytes: 1e10 };
    const base = stepCost(replica(), load, 1, 1);
    expect(stepCost(replica(), load, 0.5, 1).tMem).toBeCloseTo(2 * base.tMem, 12);
    expect(stepCost(replica(), load, 1, 0.5).tCompute).toBeCloseTo(2 * base.tCompute, 12);
    expect(stepCost(replica({ tp: 2 }), load, 1, 1).tGpu).toBeCloseTo(base.tGpu / 2, 12);
    expect(computeSeconds(replica(), 989.5e12, 1)).toBeCloseTo(1, 12);
  });
});

describe("decode throughput curve", () => {
  it("saturates at bandwidth over KV per sequence, with half-saturation where KV traffic equals weight traffic", () => {
    const c = decodeCurve(replica(), 2048, 1);
    expect(c.xInf).toBeCloseTo(12480, -1);
    expect(c.bHalf).toBeCloseTo(59.8, 1);
    expect(c.at(c.bHalf)).toBeCloseTo(c.xInf / 2, 6);
  });
});

describe("host time", () => {
  it("is a fixed part plus a part per sequence", () => {
    expect(hostSeconds(1.5, 0.05, 12)).toBeCloseTo(0.0021, 9);
  });
  it("adds to GPU time, or overlaps with it", () => {
    expect(stepSeconds(0.002, 0.008, false)).toBeCloseTo(0.01, 12);
    expect(stepSeconds(0.002, 0.008, true)).toBe(0.008);
  });
});

describe("the engine prices steps with the roofline", () => {
  it("time per output token equals the step time: 16.06 GB of weights at 3.35 TB/s × MBU 0.6 is 8.0 ms", () => {
    const w = world({ hostMsBase: 0, hostMsPerSeq: 0, returnProb: 0, outputTokens: 1500, promptTokens: 200 });
    spawnBurst(w, 1);
    run(w, 60, () => w.m.completed === 1);
    expect(w.m.tpot[0]! * 1e3).toBeGreaterThan(7.95);
    expect(w.m.tpot[0]! * 1e3).toBeLessThan(8.15);
  });
});
