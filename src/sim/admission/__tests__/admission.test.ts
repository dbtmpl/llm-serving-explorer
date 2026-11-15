import { describe, expect, it } from "vitest";
import { blocksFor } from "../../kvcache/blocks.js";
import { run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { admissionRule, type AdmissionRequest } from "../index.js";

const request = (over: Partial<AdmissionRequest> = {}): AdmissionRequest => ({ promptTokens: 20000, generatedTokens: 0, outputTokens: 150, maxTokensCap: 4096, cachedTokens: 0, tokenBudget: 8192, ...over });

describe("admission rules", () => {
  it("on-demand secures only the tokens of the next step (PagedAttention, vLLM)", () => {
    const rule = admissionRule("on-demand");
    expect(rule.tokensToSecure(request())).toBe(8192);
    expect(blocksFor(rule.tokensToSecure(request()))).toBe(512);
    // a follow-up with most of its context cached secures the cached part plus the remainder
    expect(rule.tokensToSecure(request({ promptTokens: 2786, cachedTokens: 2656 }))).toBe(2786);
    expect(rule.outputReservation(request())).toBe(150);
    expect(rule.allocatesPrefillPerChunk).toBe(true);
  });
  it("on-demand lets a waiting request in only if its whole sequence fits, though it allocates one chunk (vLLM scheduler_reserve_full_isl)", () => {
    const rule = admissionRule("on-demand");
    expect(rule.tokensToFit(request())).toBe(20000); // 1,250 blocks, against 512 allocated on admission
    // a preempted request's input sequence is its prompt plus what it had generated
    expect(rule.tokensToFit(request({ promptTokens: 16000, generatedTokens: 12800 }))).toBe(28800);
    for (const id of ["on-demand", "prompt", "reserve"] as const) {
      const r = admissionRule(id);
      expect(r.tokensToFit(request())).toBeGreaterThanOrEqual(r.tokensToSecure(request()));
    }
  });
  it("whole-prompt secures the full prompt and grows outputs on demand", () => {
    const rule = admissionRule("prompt");
    expect(rule.tokensToSecure(request())).toBe(20000);
    expect(blocksFor(rule.tokensToSecure(request()))).toBe(1250);
    expect(rule.allocatesPrefillPerChunk).toBe(false);
  });
  it("reserve-to-completion secures the prompt plus max_tokens (Orca baseline, TensorRT-LLM GuaranteedNoEvict)", () => {
    const rule = admissionRule("reserve");
    expect(rule.tokensToSecure(request({ promptTokens: 3000 }))).toBe(3000 + 4096);
    // an answer longer than the cap is still fully covered
    expect(rule.outputReservation(request({ outputTokens: 5000 }))).toBe(5000);
    expect(rule.allocatesPrefillPerChunk).toBe(false);
  });
});

describe("admission in the engine", () => {
  it("on-demand allocation preempts under overload without thrashing; reserving to completion never preempts", () => {
    const base = { promptTokens: 36000, outputTokens: 3000, maxPods: 1, maxNumSeqs: 16, returnProb: 0 };
    const onDemand = world({ ...base, admission: "on-demand" });
    spawnBurst(onDemand, 16);
    run(onDemand, 2500, () => onDemand.m.completed + onDemand.m.failed === 16);
    expect(onDemand.m.completed).toBe(16);
    // 16 sequences of 39,000 tokens need 2,438 blocks each, about 39,000 in all against a pool of 27,928: some are
    // preempted, but each waits until its whole context fits (it used to be 100 to 150 times)
    expect(onDemand.m.preemptions).toBeGreaterThanOrEqual(1);
    expect(onDemand.m.preemptions).toBeLessThanOrEqual(16);

    const reserve = world({ ...base, admission: "reserve" });
    spawnBurst(reserve, 16);
    run(reserve, 2500, () => reserve.m.completed + reserve.m.failed === 16);
    expect(reserve.m.completed).toBe(16);
    expect(reserve.m.preemptions).toBe(0);
  });
  it("a preempted request waits until its whole context fits instead of being preempted again on its first chunk", () => {
    // two sequences of 32,000 tokens each in a pool of about 3,600 blocks (57,600 tokens): the newest is
    // preempted once and re-admitted only after the other finishes
    const w = world({ promptTokens: 16000, outputTokens: 16000, maxPods: 1, maxNumSeqs: 12, gpuMemUtil: 0.3, returnProb: 0 });
    spawnBurst(w, 2);
    run(w, 600, () => w.m.completed + w.m.failed === 2);
    expect(w.m.completed).toBe(2);
    expect(w.m.preemptions).toBe(1);
  });
  it("a request whose context can never fit the pool is failed, not queued forever", () => {
    // 70B on two H100s keeps about 7.9 GB of KV, 24,000 tokens at 327,680 bytes each
    const w = world({ model: "llama-3-70b", tp: 2, promptTokens: 40000 });
    spawnBurst(w, 1);
    run(w, 10);
    expect(w.pods[0]!.state).toBe("ready");
    expect(w.m.failed).toBe(1);
  });
});
