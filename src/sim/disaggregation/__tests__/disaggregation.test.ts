import { describe, expect, it } from "vitest";
import { run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { DECIDER, linkBytesPerSecond, nextPodRole, transferSeconds } from "../index.js";

describe("decode-first decider (llm-d)", () => {
  it("uses the prefill pool only when more than the threshold is uncached on the decode pod", () => {
    expect(DECIDER.usePrefillPool(3000, 512)).toBe(true);
    expect(DECIDER.usePrefillPool(127, 512)).toBe(false);
    expect(DECIDER.usePrefillPool(512, 512)).toBe(false);
  });
});

describe("splitting the fleet", () => {
  it("assigns roles so that about the configured share of pods prefill, with at least one", () => {
    const roles: string[] = [];
    let prefill = 0;
    for (let live = 0; live < 6; live++) {
      const role = nextPodRole(prefill, live, 0.34);
      if (role === "prefill") prefill++;
      roles.push(role);
    }
    expect(roles).toEqual(["prefill", "decode", "decode", "decode", "prefill", "decode"]);
  });
});

describe("KV hand-over", () => {
  it("takes bytes over link bandwidth: 393 MB over 100 Gbit/s is 31 ms", () => {
    expect(linkBytesPerSecond(100)).toBe(12.5e9);
    expect(transferSeconds(3000 * 131072, 100) * 1e3).toBeCloseTo(31.5, 1);
  });
});

describe("disaggregation in the engine", () => {
  it("prefills on one pool, hands the KV over, and decodes on another", () => {
    const w = world({ disagg: true, returnProb: 1, maxTurns: 2, thinkTimeS: 1, scaleDownIdleS: 1e9 });
    spawnBurst(w, 20);
    run(w, 200, () => w.m.completed === 40);
    expect(w.m.completed).toBe(40);
    const roles = new Set(w.pods.map((p) => p.role));
    expect(roles.has("prefill") && roles.has("decode")).toBe(true);
    expect(w.events.filter((e) => e.kind === "kv.transfer").length).toBe(20);
    for (const pod of w.pods) if (pod.role === "prefill") expect(pod.tokensOut).toBe(0);
  });
  it("follow-up turns find their history on the decode pod and skip the prefill pool", () => {
    const w = world({ disagg: true, returnProb: 1, maxTurns: 2, thinkTimeS: 1, scaleDownIdleS: 1e9 });
    spawnBurst(w, 20);
    run(w, 200, () => w.m.completed === 40);
    expect(w.events.filter((e) => e.kind === "req.routed" && e.via === "decode-only").length).toBe(20);
  });
});
