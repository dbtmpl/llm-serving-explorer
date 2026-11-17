import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "../../core/params.js";
import type { Params } from "../../core/params.js";
import { spawnBurst } from "../../workload/index.js";
import { restartFleet } from "../../engine/fleet.js";
import { setParam } from "../../engine/tick.js";
import { run, world } from "../../testing.js";
import { fitOf, fitsWith, fixesFor } from "../fit.js";

const p = (over: Partial<Params>): Params => ({ ...DEFAULT_PARAMS, ...over });

describe("fitOf", () => {
  it("the defaults fit with room to spare", () => {
    const f = fitOf(p({}));
    expect(f.fits).toBe(true);
    expect(f.tight).toBe(false);
    expect(f.poolTokens).toBe(f.budget.poolBlocks * 16);
  });
  it("70B in BF16 does not fit on one H100 or one H200", () => {
    expect(fitOf(p({ model: "llama-3.1-70b" })).fits).toBe(false);
    expect(fitOf(p({ model: "llama-3.1-70b", gpu: "h200" })).fits).toBe(false);
  });
  it("reports the bytes per GPU that the pool cannot cover, and what the engine may use", () => {
    const f = fitOf(p({ model: "llama-3.1-70b" }));
    expect(f.needBytes).toBeGreaterThan(f.usableBytes);
    expect(f.usableBytes).toBe(f.budget.device - f.budget.headroom);
  });
  it("70B in FP8 on one H100 fits but holds only a few requests", () => {
    const f = fitOf(p({ model: "llama-3.1-70b", precision: "fp8" }));
    expect(f.fits).toBe(true);
    expect(f.budget.poolBlocks).toBe(773);
    expect(f.tight).toBe(true); // 3.9 average requests: just below the line for "very small"
    expect(f.poolRequests).toBeGreaterThan(3);
  });
  it("treats an unknown model or GPU (a replay's) as fitting", () => {
    expect(fitOf(p({ model: "something-else" })).fits).toBe(true);
  });
});

describe("fixesFor", () => {
  it("offers only changes that make 70B BF16 on one H100 fit, comfortable ones first", () => {
    const base = p({ model: "llama-3.1-70b" });
    const fixes = fixesFor(base);
    expect(fixes.length).toBeGreaterThan(1);
    for (const f of fixes) expect(fitsWith(base, f.changes), JSON.stringify(f.changes)).toBe(true);
    const kinds = fixes.map((f) => f.kind);
    expect(kinds).toContain("tp");
    expect(kinds).toContain("precision");
    expect(kinds).toContain("model");
    // once a fix leaves little room, no comfortable one follows it
    const firstTight = fixes.findIndex((f) => !f.comfortable);
    if (firstTight >= 0) expect(fixes.slice(firstTight).every((f) => !f.comfortable)).toBe(true);
    // FP8 on this GPU holds fewer than 5 average requests, so it is a poorer way out than 2 GPUs per pod
    const fp8 = fixes.find((f) => f.kind === "precision")!;
    expect(fp8.poolTokens).toBeLessThan(5 * (3000 + 150));
    expect(fixes.find((f) => f.kind === "tp")!.value).toBe("2");
  });
  it("on an H200, FP8 is a comfortable way out and a GPU switch is not offered to a smaller GPU", () => {
    const fixes = fixesFor(p({ model: "llama-3.1-70b", gpu: "h200" }));
    expect(fixes.find((f) => f.kind === "precision")!.comfortable).toBe(true);
    expect(fixes.some((f) => f.kind === "gpu" && f.changes.gpu === "h100")).toBe(false);
  });
  it("offers nothing to a configuration that fits comfortably, except bigger or smaller options that also fit", () => {
    for (const f of fixesFor(p({}))) expect(fitsWith(p({}), f.changes)).toBe(true);
  });
});

describe("recovery from a model that does not fit", () => {
  const ways: [string, Partial<Params>][] = [
    ["use 4 GPUs per pod", { tp: 4 }],
    ["use FP8 and an H200", { precision: "fp8", gpu: "h200" }],
    ["go back to the 8B model", { model: "llama-3.1-8b" }],
    ["raise memory utilisation on an H200 enough to fit", { gpu: "h200", gpuMemUtil: 0.98 }]
  ];
  for (const [name, fix] of ways) {
    it(`requests queued while nothing fits complete once you ${name}`, () => {
      const w = world({ promptTokens: 400, outputTokens: 40 });
      spawnBurst(w, 6);
      run(w, 2);
      setParam(w, "model", "llama-3.1-70b");
      run(w, 20);
      expect(w.pods.some((x) => x.state === "failed")).toBe(true);
      expect(w.pods.some((x) => x.state === "ready")).toBe(false);
      expect(w.m.completed).toBe(0);
      expect(w.gatewayQueue.length).toBeGreaterThan(0);
      for (const [k, v] of Object.entries(fix)) setParam(w, k as keyof Params, v as never);
      expect(fitOf(w.params).fits).toBe(true);
      run(w, 300, () => w.reqs.size === 0);
      expect(w.pods.some((x) => x.state === "failed")).toBe(false);
      expect(w.m.completed).toBeGreaterThanOrEqual(6);
      expect(w.reqs.size).toBe(0);
    });
  }
  it("every fix offered for a failed world gets its requests served", () => {
    for (const base of [{ model: "llama-3.1-70b" }, { model: "llama-3.1-70b", gpu: "h200" }] as Partial<Params>[]) {
      for (const fix of fixesFor(p(base))) {
        const w = world({ ...base, promptTokens: 400, outputTokens: 40 });
        spawnBurst(w, 4);
        run(w, 10);
        expect(w.m.completed).toBe(0);
        for (const [k, v] of Object.entries(fix.changes)) setParam(w, k as keyof Params, v as never);
        run(w, 400, () => w.reqs.size === 0);
        expect(w.reqs.size, JSON.stringify(fix.changes)).toBe(0);
        expect(w.m.completed, JSON.stringify(fix.changes)).toBeGreaterThanOrEqual(4);
      }
    }
  });
  it("a restart reports how many requests it sent back to the router", () => {
    const w = world({ promptTokens: 400, outputTokens: 400 });
    spawnBurst(w, 5);
    run(w, 3);
    w.events.length = 0;
    restartFleet(w);
    const e = w.events.find((x) => x.kind === "fleet.restart")!;
    expect(e.requeued).toBe(5);
    expect(w.gatewayQueue.length).toBe(5);
  });
});

describe("a pool that barely fits", () => {
  const cases: [string, number][] = [
    ["a single request", 1],
    ["a burst of 20", 20]
  ];
  for (const [name, n] of cases) {
    it(`70B in FP8 on one H100 serves ${name} to the end with the default workload`, () => {
      const w = world({ model: "llama-3.1-70b", precision: "fp8" });
      spawnBurst(w, n);
      run(w, 600, () => w.reqs.size === 0 && w.m.completed >= n);
      expect(w.m.completed).toBeGreaterThanOrEqual(n);
      expect(w.m.failed).toBe(0);
    });
  }
});
