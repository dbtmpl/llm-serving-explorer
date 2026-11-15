import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReplayRun, HOP_S } from "../adapter.js";
import { parseReplay, type ReplayFile } from "../schema.js";

const DIR = path.resolve(__dirname, "../../../public/replay");
const files: ReplayFile[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => parseReplay(JSON.parse(readFileSync(path.join(DIR, f), "utf8"))));
const get = (id: string) => files.find((f) => f.id === id)!;

interface Seen {
  kind: string;
  t: number;
  podId?: number;
  reqId?: number;
}

/** Play a whole file in steps of `dt` simulated seconds and return every event the picture would have been given. */
function play(file: ReplayFile, dt: number): { run: ReplayRun; events: Seen[] } {
  const run = new ReplayRun(file);
  const events: Seen[] = [];
  while (!run.finished) {
    run.advance(dt);
    for (const e of run.world.events.splice(0)) events.push({ kind: e.kind, t: e.t, podId: e.podId, reqId: e.reqId });
  }
  return { run, events };
}

describe.each(files.map((f) => [f.id, f] as const))("replay of %s", (_id, file) => {
  const { run, events } = play(file, 0.013);
  const byKind = (kind: string) => new Map(events.filter((e) => e.kind === kind).map((e) => [e.reqId!, e]));

  it("emits the first and the last token of every completed request at the times the file gives", () => {
    const first = byKind("req.firstToken");
    const done = byKind("req.done");
    for (const r of file.requests.filter((x) => x.fate === "completed")) {
      expect(first.get(r.id + 1)?.t, `first token of request ${r.id}`).toBeCloseTo(r.firstToken!, 9);
      expect(done.get(r.id + 1)?.t, `last token of request ${r.id}`).toBeCloseTo(r.lastToken!, 9);
    }
    expect(done.size).toBe(file.totals.completed);
  });

  it("routes every request to the pod the file names, when the file says the router sent it", () => {
    const routed = byKind("req.routed");
    for (const r of file.requests.filter((x) => x.fate === "completed")) {
      const e = routed.get(r.id + 1)!;
      expect(e.podId, `pod of request ${r.id}`).toBe(r.pod);
      expect(e.t).toBeCloseTo(r.dispatch!, 9);
      expect(byKind("req.firstToken").get(r.id + 1)!.podId).toBe(r.pod);
    }
  });

  it("fails exactly the shed requests, when the file says they left the router", () => {
    const failed = byKind("req.failed");
    expect(failed.size).toBe(file.totals.shed);
    for (const r of file.requests.filter((x) => x.fate === "shed")) expect(failed.get(r.id + 1)?.t).toBeCloseTo(r.droppedAt!, 9);
  });

  it("produces the same events at the same times whatever the step size", () => {
    const again = play(file, 0.37).events.filter((e) => e.kind !== "step.tokens");
    expect(again).toEqual(events.filter((e) => e.kind !== "step.tokens"));
  });

  it("ends with nothing in flight, every token counted and BLIS's own summary numbers", () => {
    const w = run.world;
    expect(w.reqs.size).toBe(0);
    expect(w.gatewayQueue.length).toBe(0);
    expect(w.m.completed).toBe(file.totals.completed);
    expect(w.m.failed).toBe(file.totals.shed);
    expect(w.m.tokensOut).toBe(file.requests.reduce((s, r) => s + (r.fate === "completed" ? r.outputTokens : 0), 0));
    expect(w.m.preemptions).toBe(file.requests.filter((r) => r.preemptedAt !== null).length);
    const ttfts = file.requests.filter((r) => r.fate === "completed").map((r) => r.firstToken! - r.arrival);
    expect(w.m.ttft.slice().sort((a, b) => a - b)).toEqual(ttfts.sort((a, b) => a - b));
  });

  it("follows the pod series for KV fill", () => {
    const fresh = new ReplayRun(file);
    const h = file.series.intervalS;
    const k = Math.min(5, file.series.pods[0]!.kv.length - 2);
    fresh.advance((k + 0.5) * h);
    file.series.pods.forEach((s, pod) => {
      const pool = fresh.world.pods[pod]!.budget.poolBlocks;
      expect(fresh.world.pods[pod]!.usedBlocks / pool).toBeCloseTo(s.kv[k]!, 3);
    });
  });
});

describe("a request on its way", () => {
  const file = get("prefix-followups");
  const r = file.requests[3]!;

  it("reaches the router at its arrival and is on a pod at the time BLIS sent it there", () => {
    const run = new ReplayRun(file);
    run.advance(r.arrival - 1e-4);
    expect(run.world.reqs.get(r.id + 1)?.stage).toBe("toGateway");
    run.advance(2e-4);
    expect(["queued", "toPod"]).toContain(run.world.reqs.get(r.id + 1)?.stage);
    run.advance(r.start! - run.world.t + 1e-4);
    expect(run.world.reqs.get(r.id + 1)?.stage).toBe("prefill");
    expect(run.world.pods[r.pod!]!.running).toContain(r.id + 1);
  });

  it("is drawn from its session a short, fixed time before it arrives", () => {
    const run = new ReplayRun(file);
    run.advance(r.arrival - HOP_S + 1e-3);
    expect(run.world.reqs.get(r.id + 1)?.stage).toBe("send");
    expect(run.world.sessions.has(r.session)).toBe(true);
  });

  it("streams tokens at an even rate between the first and the last", () => {
    const run = new ReplayRun(file);
    run.advance(r.firstToken! + 1e-4);
    expect(run.world.reqs.get(r.id + 1)!.out).toBe(1);
    run.advance((r.lastToken! - r.firstToken!) / 2 - 1e-4);
    expect(Math.abs(run.world.reqs.get(r.id + 1)!.out - r.outputTokens / 2)).toBeLessThan(2);
    run.advance(r.lastToken! - run.world.t - 1e-4);
    expect(run.world.reqs.get(r.id + 1)!.out).toBeGreaterThan(r.outputTokens - 3);
  });

  it("holds the cached prefix BLIS served and counts it once", () => {
    const f = file.requests.find((x) => x.round > 0)!;
    const run = new ReplayRun(file);
    run.advance(f.start! + 1e-3);
    expect(run.world.reqs.get(f.id + 1)!.cached).toBe(f.cachedTokens);
    run.advance(file.totals.endS);
    expect(run.world.m.cachedTokens).toBe(file.requests.reduce((s, x) => s + x.cachedTokens, 0));
  });
});

describe("the router's decision", () => {
  it("is the one in the file: BLIS's scores, with the chosen pod on top", () => {
    const file = get("prefix-followups");
    const run = new ReplayRun(file);
    run.advance(file.totals.endS);
    for (const r of file.requests) {
      const d = run.decisionFor(r.id)!;
      expect(d.scores).toEqual(r.scores);
      expect(d.chosen).toBe(r.pod);
      expect(d.totals[r.pod!]!).toBeCloseTo(Math.max(...d.totals.map((x) => x ?? -Infinity)), 6);
    }
  });
});

describe("a preempted request", () => {
  const file = get("kv-pressure");
  const r = file.requests.find((x) => x.preemptedAt !== null)!;

  it("leaves the running batch when BLIS preempted it, waits, and comes back when BLIS scheduled it again", () => {
    const run = new ReplayRun(file);
    run.advance(r.preemptedAt! - 1e-3);
    expect(run.world.pods[0]!.running).toContain(r.id + 1);
    const before = run.world.reqs.get(r.id + 1)!.out;
    run.advance(2e-3);
    expect(run.world.pods[0]!.waiting).toContain(r.id + 1);
    expect(run.world.pods[0]!.running).not.toContain(r.id + 1);
    run.advance((r.resumedAt! + r.preemptedAt!) / 2 - run.world.t);
    expect(run.world.reqs.get(r.id + 1)!.out).toBeLessThanOrEqual(before + 1);
    run.advance(r.resumedAt! - run.world.t + 1e-3);
    expect(run.world.pods[0]!.running).toContain(r.id + 1);
    expect(run.world.m.preemptions).toBe(1);
  });
});

describe("the clock", () => {
  it("is BLIS's clock: it starts at 0 and the run finishes after BLIS's last event", () => {
    const file = get("overload-shedding");
    const run = new ReplayRun(file);
    expect(run.world.t).toBe(0);
    expect(run.finished).toBe(false);
    run.advance(1e6);
    expect(run.finished).toBe(true);
    expect(run.world.t).toBeGreaterThanOrEqual(file.totals.endS);
  });
});
