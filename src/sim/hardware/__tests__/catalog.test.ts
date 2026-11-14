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
  it("uses decimal gigabytes and dense peak compute", () => {
    expect(GPUS.h100!.hbm).toBe(80e9);
    expect(GPUS.h100!.peak).toBe(989.5e12);
    expect(BYTES_PER_PARAM).toEqual({ bf16: 2, fp8: 1 });
  });
});
