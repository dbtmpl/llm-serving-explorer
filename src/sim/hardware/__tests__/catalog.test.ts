import { describe, expect, it } from "vitest";
import { CITATIONS } from "../../citations.js";
import { BYTES_PER_PARAM, GPUS, MODELS } from "../catalog.js";

describe("hardware catalog", () => {
  it("every model and GPU names a source in the citation registry", () => {
    for (const m of Object.values(MODELS)) expect(CITATIONS[m.source], m.id).toBeDefined();
    for (const g of Object.values(GPUS)) expect(CITATIONS[g.source], g.id).toBeDefined();
  });
  it("entries are keyed by their own id", () => {
    for (const [key, m] of Object.entries(MODELS)) expect(m.id).toBe(key);
    for (const [key, g] of Object.entries(GPUS)) expect(g.id).toBe(key);
  });
  it("model shapes are consistent: heads times head size is the hidden size", () => {
    for (const m of Object.values(MODELS)) {
      expect(m.nH * m.dH).toBe(m.d);
      expect(m.nKv).toBeLessThanOrEqual(m.nH);
    }
  });
  it("the memory a driver reports is cited, and a listed NVIDIA part reports more than its decimal-GB name", () => {
    for (const g of Object.values(GPUS)) expect(CITATIONS[g.memorySource], g.id).toBeDefined();
    expect(GPUS.h100!.memory / 1e9).toBeCloseTo(85.03, 2); // 79.19 GiB
    expect(GPUS.h200!.memory / 2 ** 30).toBeCloseTo(139.8, 1);
    expect(GPUS.mi300x!.memory).toBe(GPUS.mi300x!.hbm); // no measured figure cited: the datasheet value
  });
  it("parameter counts follow from the architecture: embedding and head, then attention and feed-forward per layer", () => {
    for (const m of Object.values(MODELS)) {
      const attn = 2 * m.d * m.nH * m.dH + 2 * m.d * m.nKv * m.dH;
      const perLayer = attn + 3 * m.d * m.dFf;
      const n = 2 * m.vocab * m.d + m.nL * perLayer;
      expect(m.N / n, m.id).toBeGreaterThan(0.999);
      expect(m.N / n, m.id).toBeLessThan(1.001);
    }
  });
  it("uses decimal gigabytes and dense peak compute", () => {
    expect(GPUS.h100!.hbm).toBe(80e9);
    expect(GPUS.h100!.peak).toBe(989.5e12);
    expect(BYTES_PER_PARAM).toEqual({ bf16: 2, fp8: 1 });
  });
});
