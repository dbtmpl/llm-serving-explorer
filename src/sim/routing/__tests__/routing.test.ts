import { describe, expect, it } from "vitest";
import { run, world } from "../../testing.js";
import { spawnBurst } from "../../workload/index.js";
import { POD_QUEUE_SLACK, pickHighest, routingPolicy, type CandidateFacts } from "../index.js";
import { SCORER_WEIGHTS, TIER_AFFINITY, prefixAware, prefixAwareTerms } from "../prefixAware.js";

const facts = (over: Partial<CandidateFacts> = {}): CandidateFacts => ({ cachedFraction: 0, cacheLocation: null, kvUtilisation: 0, load: 0, capacity: 16, ...over });

describe("prefix-cache-aware routing (llm-d endpoint picker)", () => {
  const policy = routingPolicy("prefix-aware");
  it("uses llm-d's default scorer weights: prefix cache 3, KV utilisation 2, queue 2", () => {
    expect(SCORER_WEIGHTS).toEqual({ prefixCache: 3, kvUtilisation: 2, queue: 2 });
  });
  it("scores the worked example: a warm half-full pod (4.5) beats a cold empty one (4.0)", () => {
    const warm = facts({ cachedFraction: 0.9, cacheLocation: "hbm", kvUtilisation: 0.6, load: 8 });
    const cold = facts();
    expect(policy.score(warm)).toBeCloseTo(3 * 0.9 + 2 * 0.4 + 2 * 0.5, 12);
    expect(policy.score(cold)).toBeCloseTo(4, 12);
    expect(policy.score(warm)).toBeGreaterThan(policy.score(cold));
  });
  it("lets load override affinity: the same warm pod at 14 of 16 requests (3.75) loses", () => {
    const busy = facts({ cachedFraction: 0.9, cacheLocation: "hbm", kvUtilisation: 0.6, load: 14 });
    expect(policy.score(busy)).toBeCloseTo(3.75, 12);
    expect(policy.score(busy)).toBeLessThan(policy.score(facts()));
  });
  it("flips exactly where the other pod's lead on the two load terms passes the cache term (3 for a full HBM copy)", () => {
    // pod A holds the whole prompt in HBM with a 75%-full pool; pod B is empty. Lead of B on the load terms: 2 · 0.75 + 2 · load/16.
    const a = (load: number) => policy.score(facts({ cachedFraction: 1, cacheLocation: "hbm", kvUtilisation: 0.75, load }));
    const b = policy.score(facts());
    expect(a(11)).toBeGreaterThan(b); // lead 2.875 < 3
    expect(a(12)).toBeCloseTo(b, 12); // lead 3.0: a tie, which the first candidate wins
    expect(a(13)).toBeLessThan(b); // lead 3.125 > 3
    // with 96% of the prompt cached the cache term is 2.88, so the flip is earlier
    const partial = (load: number) => policy.score(facts({ cachedFraction: 0.96, cacheLocation: "hbm", kvUtilisation: 0.75, load }));
    expect(partial(11)).toBeGreaterThan(b); // lead 2.875 < 2.88
    expect(partial(12)).toBeLessThan(b); // lead 3.0 > 2.88
    // the queue term alone can never outweigh a full copy: its largest lead is 2 (an idle pod against one at capacity)
    expect(policy.score(facts({ cachedFraction: 1, cacheLocation: "hbm", load: 15 }))).toBeGreaterThan(b);
  });
  it("values a cached copy less the further down the tiers it sits", () => {
    const at = (cacheLocation: CandidateFacts["cacheLocation"]) => policy.score(facts({ cachedFraction: 1, cacheLocation }));
    expect(at("hbm")).toBeGreaterThan(at("dram"));
    expect(at("dram")).toBeGreaterThan(at("ssd"));
    expect(at("ssd")).toBeGreaterThan(at("remote"));
    expect(at("remote")).toBeGreaterThan(at(null));
    expect(TIER_AFFINITY.hbm).toBe(1);
  });
});

describe("load-only policies (Envoy load balancers)", () => {
  it("round robin rotates through candidates whatever their scores", () => {
    const policy = routingPolicy("round-robin");
    const scores = [5, 1, 3];
    let cursor = 0;
    const order: number[] = [];
    for (let i = 0; i < 6; i++) {
      const choice = policy.pick(scores, cursor);
      order.push(choice.index);
      cursor = choice.cursor;
    }
    expect(order).toEqual([0, 1, 2, 0, 1, 2]);
  });
  it("least loaded picks the pod with the fewest requests and ignores the cache", () => {
    const policy = routingPolicy("least-loaded");
    const scores = [facts({ load: 5, cachedFraction: 1, cacheLocation: "hbm" }), facts({ load: 2 }), facts({ load: 9 })].map(policy.score);
    expect(policy.pick(scores, 0).index).toBe(1);
  });
  it("the first candidate wins a tie", () => {
    expect(pickHighest([2, 7, 7, 1], 0).index).toBe(1);
  });
});

describe("routing in the engine", () => {
  it("prefix-aware routing sends follow-up turns back to the pod holding their history", () => {
    const sameShare = (routing: "prefix-aware" | "round-robin") => {
      const w = world({ routing, returnProb: 1, maxTurns: 3, thinkTimeS: 1, minPods: 4, maxPods: 4, scaleDownIdleS: 1e9 });
      run(w, 5);
      spawnBurst(w, 16, 2);
      run(w, 200, () => w.m.completed === 48);
      const firstPod = new Map<number, number>();
      let same = 0;
      let later = 0;
      for (const e of w.events) {
        if (e.kind !== "req.routed") continue;
        const first = firstPod.get(e.sid!);
        if (first === undefined) firstPod.set(e.sid!, e.podId!);
        else {
          later++;
          if (first === e.podId) same++;
        }
      }
      return same / later;
    };
    expect(sameShare("prefix-aware")).toBeGreaterThan(0.9);
    expect(sameShare("round-robin")).toBeLessThan(0.6);
  });
});

describe("prefix-aware score terms", () => {
  it("add up to the score, and the example of the docstring gives 4.5", () => {
    const c = { cachedFraction: 0.9, cacheLocation: "hbm" as const, kvUtilisation: 0.6, load: 8, capacity: 16 };
    const t = prefixAwareTerms(c);
    expect(t.cache.term + t.kv.term + t.queue.term).toBeCloseTo(prefixAware.score(c), 12);
    expect(prefixAware.score(c)).toBeCloseTo(4.5, 12);
    expect(t.cache.share).toBeCloseTo(0.9, 12);
    expect(prefixAwareTerms({ ...c, cacheLocation: "dram" }).cache.share).toBeCloseTo(0.63, 12);
    expect(prefixAwareTerms({ ...c, cacheLocation: null }).cache.term).toBe(0);
  });
  it("the engine records every candidate's utilisation and the pod capacity in the decision", () => {
    const w = world({ minPods: 2, maxPods: 2 });
    run(w, 5);
    spawnBurst(w, 1);
    run(w, 3, () => w.lastRoute !== null);
    const d = w.lastRoute!;
    expect(d.reqId).toBeGreaterThan(0);
    expect(d.capacity).toBe(w.params.maxNumSeqs + POD_QUEUE_SLACK);
    expect(d.candidates).toHaveLength(2);
    for (const c of d.candidates) {
      const t = prefixAwareTerms({ cachedFraction: c.cache, cacheLocation: c.tier, kvUtilisation: c.kvUtilisation, load: c.load, capacity: d.capacity });
      expect(c.score).toBeCloseTo(t.cache.term + t.kv.term + t.queue.term, 9);
    }
    expect(w.routeLog.at(-1)).toBe(d);
  });
});
