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
  it("on-demand allocation preempts and thrashes under overload; reserving to completion never preempts", () => {
    const base = { promptTokens: 36000, outputTokens: 3000, maxPods: 1, maxNumSeqs: 16, returnProb: 0 };
    const onDemand = world({ ...base, admission: "on-demand" });
    spawnBurst(onDemand, 16);
    run(onDemand, 2500, () => onDemand.m.completed + onDemand.m.failed === 16);
    expect(onDemand.m.completed).toBe(16);
    expect(onDemand.m.preemptions).toBeGreaterThan(10);

    const reserve = world({ ...base, admission: "reserve" });
    spawnBurst(reserve, 16);
    run(reserve, 2500, () => reserve.m.completed + reserve.m.failed === 16);
    expect(reserve.m.completed).toBe(16);
    expect(reserve.m.preemptions).toBe(0);
    expect(reserve.t).toBeLessThan(onDemand.t);
  });
  it("a request whose context can never fit the pool is failed, not queued forever", () => {
    const w = world({ model: "llama-3-70b", tp: 2, promptTokens: 8000 });
    spawnBurst(w, 1);
    run(w, 10);
    expect(w.pods[0]!.state).toBe("ready");
    expect(w.m.failed).toBe(1);
  });
});
