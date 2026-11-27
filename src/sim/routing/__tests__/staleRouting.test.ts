import { describe, expect, it } from "vitest";
import { setParam } from "../../engine/tick.js";
import { run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { ageDiscountedLoad } from "../ageDiscounted.js";
import { MIN_LOAD_FLOOR, OVERLOAD_PENALTY, boundedLoadCap } from "../boundedLoadAffinity.js";
import { pickHighest, routingPolicy, type CandidateFacts } from "../index.js";
import { prefixAware } from "../prefixAware.js";

const facts = (over: Partial<CandidateFacts> = {}): CandidateFacts => ({
  cachedFraction: 0,
  cacheLocation: null,
  kvUtilisation: 0,
  load: 0,
  capacity: 16,
  ...over
});

describe("bounded-load affinity routing (Mirrokni et al., SODA 2018)", () => {
  const policy = routingPolicy("bounded-load-affinity");

  it("matches the worked example: sheds overflow once load exceeds (1+ε)·max(mean, 1)", () => {
    // 4 pods: Pod A warm (75% HBM, kvUtil=0.2, load=4); Pods B-D cold & empty (load=0)
    const mean = (4 + 0 + 0 + 0) / 4; // 1.0
    const eps = 0.5;
    expect(boundedLoadCap(mean, eps)).toBeCloseTo(1.5, 12);
    expect(boundedLoadCap(0, eps)).toBeCloseTo((1 + eps) * MIN_LOAD_FLOOR, 12);

    const podA = facts({
      cachedFraction: 0.75,
      cacheLocation: "hbm",
      kvUtilisation: 0.2,
      load: 4,
      meanObservedLoad: mean,
      boundedLoadEpsilon: eps
    });
    const podB = facts({ load: 0, meanObservedLoad: mean, boundedLoadEpsilon: eps });

    expect(policy.score(podA)).toBeCloseTo(5.35 - OVERLOAD_PENALTY, 12);
    expect(policy.score(podB)).toBeCloseTo(4.0, 12);
    expect(policy.score(podB)).toBeGreaterThan(policy.score(podA));

    // At load = 1 <= 1.5, Pod A keeps its unpenalised prefix-aware score
    const podAWithinCap = facts({
      cachedFraction: 0.75,
      cacheLocation: "hbm",
      kvUtilisation: 0.2,
      load: 1,
      meanObservedLoad: 0.25,
      boundedLoadEpsilon: eps
    });
    expect(policy.score(podAWithinCap)).toBeCloseTo(5.725, 12);
    expect(policy.score(podAWithinCap)).toBeGreaterThan(policy.score(podB));
  });

  it("ranks among overloaded pods by base score when all exceed the cap", () => {
    const a = facts({ cachedFraction: 0.8, cacheLocation: "hbm", load: 5, meanObservedLoad: 2, boundedLoadEpsilon: 0.5 });
    const b = facts({ cachedFraction: 0.0, cacheLocation: null, load: 5, meanObservedLoad: 2, boundedLoadEpsilon: 0.5 });
    expect(policy.score(a)).toBeLessThan(0);
    expect(policy.score(b)).toBeLessThan(0);
    expect(policy.score(a)).toBeGreaterThan(policy.score(b));
  });

  it("is deterministic and consumes no random state", () => {
    const s1 = policy.score(facts({ cachedFraction: 0.5, cacheLocation: "hbm", load: 3, meanObservedLoad: 1.5 }));
    const s2 = policy.score(facts({ cachedFraction: 0.5, cacheLocation: "hbm", load: 3, meanObservedLoad: 1.5 }));
    expect(s1).toBe(s2);
    expect(pickHighest([s1, 4.0], 0).index).toBe(1);
  });
});

describe("age-discounted routing (Dahlin, IEEE TPDS 2000)", () => {
  const policy = routingPolicy("age-discounted");

  it("matches the worked example: discounts stale peer load exponentially with age", () => {
    expect(ageDiscountedLoad(1, 6, 0, 0.2)).toBeCloseTo(7, 12);
    expect(ageDiscountedLoad(1, 6, 0.4, 0.2)).toBeCloseTo(1 + 6 * Math.exp(-2), 12);

    const fresh = facts({
      cachedFraction: 0.75,
      cacheLocation: "hbm",
      kvUtilisation: 0.2,
      load: 7,
      ownLoad: 1,
      peerLoad: 6,
      peerStateAgeS: 0,
      ageDecayS: 0.2
    });
    const stale = facts({
      cachedFraction: 0.75,
      cacheLocation: "hbm",
      kvUtilisation: 0.2,
      load: 7,
      ownLoad: 1,
      peerLoad: 6,
      peerStateAgeS: 0.4,
      ageDecayS: 0.2
    });

    expect(policy.score(fresh)).toBeCloseTo(4.975, 12);
    expect(policy.score(stale)).toBeCloseTo(2.25 + 1.6 + 2 * (1 - (1 + 6 * Math.exp(-2)) / 16), 12);
    expect(policy.score(stale)).toBeGreaterThan(policy.score(fresh));
  });

  it("converges to ownLoad when age >> decay and falls back to load when ownLoad is absent", () => {
    expect(ageDiscountedLoad(2, 10, 10, 0.2)).toBeCloseTo(2, 12);
    const noOwn = facts({ cachedFraction: 0.5, cacheLocation: "hbm", kvUtilisation: 0.2, load: 5 });
    expect(policy.score(noOwn)).toBeCloseTo(prefixAware.score(noOwn), 12);
  });
});

describe("active-active stale-state engine", () => {
  function runBurstOnWarmFleet(over: Record<string, unknown>) {
    const w = world({
      minPods: 4,
      maxPods: 4,
      routerReplicas: 4,
      sharedPrefixTokens: 1536,
      sharedPrefixGroups: 1,
      promptTokens: 2048,
      outputTokens: 128,
      overlap: true,
      dramGB: 0,
      ssdGB: 0,
      remoteGB: 0,
      returnProb: 0,
      ...over
    });
    // Warm up the 4 pods and seed pod-1 with the shared system-prompt prefix
    run(w, 4);
    spawnBurst(w, 1, 0);
    run(w, 2, () => w.m.completed === 1);
    const seedPod = w.lastRoute!.chosen;
    w.events.length = 0;

    // Send a concurrent burst (> capacity=16) within a single 200ms blind window
    spawnBurst(w, 32, 0.12);
    const maxObservedPodQueue = { value: 0 };
    const routedToPod = new Map<number, number>();
    for (let i = 0; i < 160; i++) {
      run(w, 0.05);
      for (const p of w.pods) {
        const load = p.running.length + p.waiting.length + p.inbound;
        if (load > maxObservedPodQueue.value) maxObservedPodQueue.value = load;
      }
      if (w.m.completed === 33) break;
    }
    for (const e of w.events) {
      if (e.kind === "req.routed") {
        routedToPod.set(e.podId!, (routedToPod.get(e.podId!) ?? 0) + 1);
      }
    }
    return { w, seedPod, routedToPod, maxLoad: maxObservedPodQueue.value };
  }

  it("prefix-aware with 200 ms sync lag herds onto the warm pod harder than 20 ms sync lag or bounded-load affinity", () => {
    const stale = runBurstOnWarmFleet({ routing: "prefix-aware", syncIntervalS: 0.2 });
    const tight = runBurstOnWarmFleet({ routing: "prefix-aware", syncIntervalS: 0.02 });
    const bounded = runBurstOnWarmFleet({ routing: "bounded-load-affinity", syncIntervalS: 0.2, boundedLoadEpsilon: 0.5 });

    const staleOnWarm = stale.routedToPod.get(stale.seedPod) ?? 0;
    const tightOnWarm = tight.routedToPod.get(tight.seedPod) ?? 0;
    const boundedOnWarm = bounded.routedToPod.get(bounded.seedPod) ?? 0;

    expect(staleOnWarm).toBeGreaterThan(tightOnWarm);
    expect(staleOnWarm).toBeGreaterThan(boundedOnWarm);
    expect(stale.maxLoad).toBeGreaterThan(tight.maxLoad);
    expect(stale.maxLoad).toBeGreaterThan(bounded.maxLoad);
    expect(stale.w.events.some((e) => e.kind === "router.sync")).toBe(true);
  });

  it("age-discounted stays sticky on a warm pod when stale peer load has aged out", () => {
    const policyPrefix = routingPolicy("prefix-aware");
    const policyAged = routingPolicy("age-discounted");
    // Suppose peer snapshot says peerLoad=12 from 0.8s ago (e.g. peers finished), ownLoad=0, capacity=16
    const warm = facts({
      cachedFraction: 0.75,
      cacheLocation: "hbm",
      kvUtilisation: 0.1,
      load: 12,
      ownLoad: 0,
      peerLoad: 12,
      peerStateAgeS: 0.8,
      ageDecayS: 0.2
    });
    const cold = facts({ load: 0, ownLoad: 0, peerLoad: 0, peerStateAgeS: 0.8, ageDecayS: 0.2 });
    // Under prefix-aware, 2*(1 - 12/16) = 0.5 vs cold 2 -> loses if cache < 1.5+0.2=1.7; with kvUtil=0.3:
    const warmBusyKv = { ...warm, kvUtilisation: 0.4 };
    expect(policyPrefix.score(warmBusyKv)).toBeLessThan(policyPrefix.score(cold));
    expect(policyAged.score(warmBusyKv)).toBeGreaterThan(policyAged.score(cold));
  });

  it("shares system-prompt prefix hits across distinct sessions in the same group without leaking counters", () => {
    const w = world({
      minPods: 2,
      maxPods: 2,
      routerReplicas: 4,
      syncIntervalS: 0.2,
      sharedPrefixTokens: 1536,
      sharedPrefixGroups: 1,
      promptTokens: 2048,
      outputTokens: 64,
      returnProb: 0
    });
    run(w, 4);
    // First session warms pod-1
    spawnBurst(w, 1, 0);
    run(w, 5, () => w.m.completed === 1);
    // Second session (distinct sid=2, same group 0) hits the shared prefix
    spawnBurst(w, 1, 0);
    run(w, 5, () => w.m.completed === 2);

    const admitted = w.events.filter((e) => e.kind === "req.admitted");
    expect(admitted).toHaveLength(2);
    expect(admitted[1]!.cached).toBe(1536);

    // Every replica's ownInFlight map must be completely drained (0 leak)
    const totalTracked = w.ownInFlight.reduce((sum, m) => sum + [...m.values()].reduce((a, b) => a + b, 0), 0);
    expect(totalTracked).toBe(0);
  });

  it("cleans up ownInFlight on shedding and live routerReplicas topology changes", () => {
    const w = world({
      minPods: 2,
      maxPods: 2,
      routerReplicas: 4,
      syncIntervalS: 0.2,
      sharedPrefixTokens: 1536,
      promptTokens: 2048,
      outputTokens: 300,
      shedAfterS: 0.2,
      returnProb: 0
    });
    run(w, 4);
    spawnBurst(w, 60, 0.1);
    run(w, 1);
    setParam(w, "routerReplicas", 2);
    run(w, 1);
    setParam(w, "routerReplicas", 8);
    run(w, 60, () => w.reqs.size === 0);

    expect(w.reqs.size).toBe(0);
    expect(w.m.completed + w.m.failed).toBe(60);
    const totalTracked = w.ownInFlight.reduce((sum, m) => sum + [...m.values()].reduce((a, b) => a + b, 0), 0);
    expect(totalTracked).toBe(0);
  });

  it("leaves default behaviour completely untouched when routerReplicas=1, syncIntervalS=0, sharedPrefixTokens=0", () => {
    const w = world({ minPods: 2, maxPods: 2, returnProb: 0 });
    run(w, 4);
    spawnBurst(w, 4, 0.2);
    run(w, 20, () => w.m.completed === 4);
    expect(w.events.some((e) => e.kind === "router.sync")).toBe(false);
    expect([...w.sessions.values()].every((s) => s.prefixGroup === undefined)).toBe(true);
    expect(w.lastRoute?.routerReplica).toBeUndefined();
  });
});
