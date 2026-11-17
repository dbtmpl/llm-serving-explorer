import { describe, expect, it } from "vitest";
import { GPUS } from "../../hardware/catalog.js";
import { H100, LLAMA_70B, LLAMA_8B, replica, run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { attnFlops, flopsPerToken, recomputeRatio, seqLoad } from "../flops.js";
import { hostSeconds, stepSeconds } from "../host.js";
import { activationBytes, graphBytes, graphCaptureSizes, kvBytesPerToken, maxBatch, memoryBudget, weightBytes } from "../memory.js";
import { commSeconds, computeSeconds, largestCapture, launchSeconds, ridge, stepCost, type StepTiming } from "../roofline.js";

/** Efficiency 1 everywhere and no launch cost: the bare roofline. */
const IDEAL: StepTiming = { mbu: 1, mfu: 1, commEff: 1, commLatencyUs: 0, launchUs: 0, launchEagerUs: 0 };
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
  it("the KV pool is what weights, activations, CUDA graphs and the runtime overhead leave of the requested share", () => {
    expect(activationBytes(LLAMA_8B) / 1e9).toBeCloseTo(0.604, 3); // 8,192-token forward pass, 256 sequences
    const b = memoryBudget(replica());
    expect(b.device).toBe(85_029_158_912); // 79.19 GiB, what the driver reports for an H100 sold as 80 GB
    expect(b.hbm).toBe(80e9); // the label
    expect(b.kv / 1e9).toBeCloseTo(76.53 - 16.06 - 0.604 - 0.126 - 0.7, 2); // 59.04 GB: activations at the 8,192-token default, graphs for 256 sequences, 0.7 GB outside PyTorch
    expect(b.headroom / 1e9).toBeCloseTo(8.5, 2); // device minus ceil(0.9 * device)
    expect(b.poolBlocks).toBe(28150); // BLIS, for 12 sequences: see conformance/scenarios/kv-budget-8b-h100.yaml
    expect(b.blockBytes).toBe(16 * 131072);
  });
  it("vLLM requests ceil(driver-reported memory × utilisation), so a larger reported figure gives a larger pool", () => {
    const h200 = GPUS.h200!;
    expect(memoryBudget(replica({ gpu: h200 })).device).toBe(150_109_880_320);
    expect(memoryBudget(replica({ gpu: h200 })).headroom).toBe(150_109_880_320 - Math.ceil(150_109_880_320 * 0.9));
  });
  it("activations keep the whole residual stream on each GPU but only 1/tp of the feed-forward width", () => {
    // forward pass: 8192 · (2·8192 + 2·28672/4) · 2; the sampler's 256 rows are smaller than it here
    expect(activationBytes(LLAMA_70B, 4)).toBe(8192 * (2 * 8192 + (2 * 28672) / 4) * 2);
    expect(activationBytes(LLAMA_70B, 4)).toBeLessThan(activationBytes(LLAMA_70B, 1));
  });
  it("activations follow the engine's settings: a 2,048-token step is a quarter of the forward pass, and the sampler's rows can decide", () => {
    // 4090 run: 2,048 tokens, 256 sequences: forward 151.0 MB, sampler 2048·4096·2 + 256·128256·10 = 345.1 MB
    expect(activationBytes(LLAMA_8B, 1, 2048, 256)).toBe(2048 * 4096 * 2 + 256 * 128256 * 10);
    expect(activationBytes(LLAMA_8B, 1, 2048, 256)).toBeGreaterThan(2048 * (2 * 4096 + 2 * 14336) * 2);
    // rows are min(tokens, sequences)
    expect(activationBytes(LLAMA_8B, 1, 64, 256)).toBe(Math.max(64 * (2 * 4096 + 2 * 14336) * 2, 64 * 4096 * 2 + 64 * 128256 * 10));
    // fewer sequences, smaller sampler
    expect(activationBytes(LLAMA_8B, 1, 2048, 128)).toBeLessThan(activationBytes(LLAMA_8B, 1, 2048, 256));
  });
  it("CUDA graphs: vLLM's capture list, one shared pool, at least 1 MiB for every further graph", () => {
    expect(graphCaptureSizes(256, 2048)).toHaveLength(51); // the RTX 4090 run's list (meta.json), 1 .. 512
    expect(graphCaptureSizes(128, 2048)).toHaveLength(35); // the RTX PRO 6000 run's list, 1 .. 256
    expect(graphCaptureSizes(12, 8192)).toEqual([1, 2, 4, 8, 16, 24]);
    // 128 sequences: 35 piecewise sizes and 19 full ones (those up to 128): (35 + 19 - 2) MiB plus a 256-token forward pass
    expect(graphBytes(LLAMA_8B, 1, 128, 2048)).toBe(256 * (2 * 4096 + 2 * 14336) * 2 + 52 * 2 ** 20);
    // more sequences, more graphs
    expect(graphBytes(LLAMA_8B, 1, 256, 2048)).toBeGreaterThan(graphBytes(LLAMA_8B, 1, 128, 2048));
  });
  it("tensor parallelism splits the weights: 70B fits on 4 H100s, barely on 2, not on 1", () => {
    expect(memoryBudget(replica({ model: LLAMA_70B, tp: 4 })).kv / 1e9).toBeCloseTo(39.93, 1);
    expect(memoryBudget(replica({ model: LLAMA_70B, tp: 2 })).kv / 1e9).toBeCloseTo(4.40, 1);
    expect(memoryBudget(replica({ model: LLAMA_70B })).fits).toBe(false);
  });
  it("70B on four H200s: 75,150 blocks (BLIS, at 12 sequences: see its scenario)", () => {
    expect(memoryBudget(replica({ model: LLAMA_70B, tp: 4, gpu: GPUS.h200! })).poolBlocks).toBe(75150);
  });
  it("the largest batch at 4,096 tokens of context is pool bytes over bytes per sequence", () => {
    expect(maxBatch(replica(), 4096)).toBe(109);
    expect(maxBatch(replica({ model: LLAMA_70B, tp: 4 }), 4096)).toBe(118);
  });
});

describe("roofline (Williams et al. 2009)", () => {
  it("the ridge point is peak compute over memory bandwidth", () => {
    expect(ridge(H100)).toBeCloseTo(295.4, 1);
    expect(ridge(GPUS.b200!)).toBeCloseTo(292.2, 1);
  });
  it("a decode step of 64 sequences at 2,048 tokens takes 9.92 ms and is memory-bound", () => {
    const bytes = weightBytes(LLAMA_8B, "bf16") + 64 * 2048 * kvBytesPerToken(LLAMA_8B);
    const c = stepCost(replica(), { tokens: 64, flops: 64 * 2 * LLAMA_8B.N, bytes }, IDEAL);
    expect(c.tMem * 1e3).toBeCloseTo(9.92, 2);
    expect(c.tCompute * 1e3).toBeCloseTo(1.04, 2);
    expect(c.tGpu).toBe(c.tMem);
    expect(c.bound).toBe("memory");
    expect(c.intensity).toBeCloseTo(30.9, 1);
  });
  it("a 2,048-token prefill is compute-bound, right of the ridge", () => {
    const l = seqLoad(LLAMA_8B, 0, 2048);
    const c = stepCost(replica(), { tokens: 2048, flops: l.flops, bytes: weightBytes(LLAMA_8B, "bf16") + l.kvBytes }, IDEAL);
    expect(c.bound).toBe("compute");
    expect(c.intensity).toBeGreaterThan(ridge(H100));
  });
  it("utilisation factors and tensor parallelism scale the rates", () => {
    const load = { tokens: 1, flops: 1e12, bytes: 1e10 };
    const base = stepCost(replica(), load, IDEAL);
    expect(stepCost(replica(), load, { ...IDEAL, mbu: 0.5 }).tMem).toBeCloseTo(2 * base.tMem, 12);
    expect(stepCost(replica(), load, { ...IDEAL, mfu: 0.5 }).tCompute).toBeCloseTo(2 * base.tCompute, 12);
    // two GPUs halve the roofline; the all-reduce (zero here) would add to it
    const two = stepCost(replica({ tp: 2 }), load, IDEAL);
    expect(Math.max(two.tMem, two.tCompute)).toBeCloseTo(Math.max(base.tMem, base.tCompute) / 2, 12);
    expect(computeSeconds(replica(), 989.5e12, IDEAL)).toBeCloseTo(1, 12);
  });
  it("a step costs the roofline plus its all-reduces plus its kernel launches (they do not overlap memory and compute)", () => {
    const load = { tokens: 64, flops: 1e12, bytes: 3e10 };
    const t = { ...IDEAL, commLatencyUs: 5, launchUs: 30, launchEagerUs: 100 };
    const c = stepCost(replica({ tp: 4, model: LLAMA_70B, gpu: GPUS.h200! }), load, t);
    expect(c.tGpu).toBeCloseTo(Math.max(c.tMem, c.tCompute) + c.tComm + c.tLaunch, 15);
    expect(c.tLaunch).toBeCloseTo(80 * 30e-6, 12); // 80 layers, 64 tokens is within the capture list
  });
  it("tensor-parallel all-reduce: two per layer, 2(tp-1)/tp of the hidden state through the link, none on one GPU", () => {
    const r = replica({ tp: 4, model: LLAMA_70B, gpu: GPUS.h200! });
    // 8,192 tokens · 8,192 · 2 B = 134.2 MB; × 1.5 = 201.3 MB; over 450 GB/s at η = 0.35: 1.278 ms; 160 of them
    expect(commSeconds(r, 8192, { commEff: 0.35, commLatencyUs: 0 }) * 1e3).toBeCloseTo(160 * 1.278, 0);
    expect(commSeconds(r, 8192, { commEff: 0.35, commLatencyUs: 10 }) - commSeconds(r, 8192, { commEff: 0.35, commLatencyUs: 0 })).toBeCloseTo(160 * 10e-6, 12);
    expect(commSeconds(replica(), 8192, { commEff: 0.35, commLatencyUs: 10 })).toBe(0);
    // two GPUs move 1x the message, four 1.5x, eight 1.75x
    const per = (tp: number) => commSeconds(replica({ tp, model: LLAMA_70B, gpu: GPUS.h200! }), 1000, { commEff: 1, commLatencyUs: 0 });
    expect(per(4) / per(2)).toBeCloseTo(1.5, 12);
    expect(per(8) / per(2)).toBeCloseTo(1.75, 12);
  });
  it("a step larger than the CUDA graph capture list launches eagerly, which costs more per layer", () => {
    const r = replica({ maxNumSeqs: 64 }); // captures up to 128 tokens
    expect(largestCapture(r)).toBe(128);
    const t = { launchUs: 32, launchEagerUs: 102 };
    expect(launchSeconds(r, 128, t)).toBeCloseTo(32 * 32e-6, 12);
    expect(launchSeconds(r, 129, t)).toBeCloseTo(32 * 102e-6, 12);
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
  it("time per output token equals the step time: 16.06 GB of weights at 3.35 TB/s × MBU 0.85 is 5.64 ms, plus 32 layers launched at 32 µs", () => {
    const w = world({ hostMsBase: 0, hostMsPerSeq: 0, returnProb: 0, outputTokens: 1500, promptTokens: 200 });
    spawnBurst(w, 1);
    run(w, 60, () => w.m.completed === 1);
    expect(w.m.tpot[0]! * 1e3).toBeGreaterThan(6.6);
    expect(w.m.tpot[0]! * 1e3).toBeLessThan(6.85);
  });
});
