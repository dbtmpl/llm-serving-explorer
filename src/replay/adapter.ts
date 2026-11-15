/**
 * Plays a replay file as a `Run`: requests appear, travel to the pod BLIS chose, wait, produce a first
 * token when BLIS says they did, stream until BLIS's last token, and finish or fail as BLIS reports.
 *
 * Everything the picture shows about a request is a function of time and the file; nothing here
 * simulates. The clock is BLIS's clock (0 is the start of the run). The only things not taken from
 * BLIS are marked as presentation:
 *   - the 0.3 s a request spends travelling from its session to the router is drawn just before
 *     BLIS's arrival time (BLIS models no such hops), and the 0.12 s from the router to the pod is
 *     drawn from the dispatch time, never past the time BLIS scheduled the request;
 *   - output tokens stream at an even rate between the first and the last token (BLIS gives
 *     those two times, not every token), pausing while a preempted request waits to resume.
 * A pod's inside is the aggregate BLIS reports: how full its KV pool is and how many requests run
 * and wait. There is no block map, no forward-pass sweep and no roofline dot because BLIS emits no
 * step-level events (see ADR 0007).
 */
import { DEFAULT_PARAMS, DISPLAY_CELLS, createWorld, memoryBudget, replicaSpec, type Params, type Pod, type Req, type RouteDecision, type Session, type SimEvent, type World } from "../sim/index.js";
import type { Run, RunWorld } from "../live/run.js";
import type { ReplayFile, ReplayRequest } from "./schema.js";

/** Catalogue entry the site draws each neutral model name with (the same architecture BLIS prices). */
export const MODEL_IDS: Record<string, string> = { "llama-3.1-8b": "llama-3.1-8b", "llama-70b": "llama-3-70b" };

/** Presentation: seconds from a session sending a request to it reaching the router (drawn before BLIS's arrival time). */
export const HOP_S = 0.3;
/** Presentation: seconds a request takes from the router to the pod, at most (it never outlasts BLIS's scheduling). */
export const TO_POD_S = 0.12;
/** Seconds of simulated time between two `step.tokens` events of one pod (each draws a few token particles). */
const TOKEN_EVENT_S = 0.1;
/** Seconds the clock keeps running after BLIS's last event before the run counts as finished. */
const TAIL_S = 0.5;
/** Throughput window, as in the live model. */
const WINDOW_S = 1;

type Phase = "appear" | "tokenize" | "toGateway" | "arrive" | "dispatch" | "enter" | "start" | "first" | "preempt" | "resume" | "last" | "drop";
/** Order in which marks at the same instant are applied. */
const ORDER: Phase[] = ["appear", "tokenize", "toGateway", "arrive", "dispatch", "enter", "start", "first", "preempt", "resume", "last", "drop"];

interface Mark {
  t: number;
  phase: Phase;
  /** Index into `file.requests`. */
  i: number;
}

/** The router's decision for one request, as BLIS's trace log recorded it. */
export interface Decision {
  reqIndex: number;
  /** Per pod, in file order: one score per scorer, or null when the pod was filtered out. */
  scores: (number[] | null)[];
  /** Weighted sum per pod (null where filtered out). */
  totals: (number | null)[];
  chosen: number;
}

export function weightedTotals(scores: (number[] | null)[], weights: number[]): (number | null)[] {
  return scores.map((row) => (row ? row.reduce((s, v, k) => s + v * weights[k]!, 0) : null));
}

export class ReplayRun implements Run {
  readonly kind = "calibrated" as const;
  readonly detail = "aggregate" as const;
  readonly file: ReplayFile;
  /** Decisions the router has made so far, newest last. */
  readonly decisions: Decision[] = [];
  private readonly w: World;
  private readonly marks: Mark[] = [];
  private cursor = 0;
  private readonly endT: number;
  private readonly lastTokenEvent: number[];
  private readonly newTokens: number[];
  private readonly sessionRounds = new Map<number, number[]>();
  /** Tokens already counted in the throughput window, per active request. */
  private readonly counted = new Map<number, number>();

  constructor(file: ReplayFile) {
    this.file = file;
    const p = file.params;
    const params: Params = {
      ...DEFAULT_PARAMS,
      model: MODEL_IDS[p.model] ?? p.model,
      gpu: p.gpu,
      precision: "bf16",
      tp: p.tp,
      gpuMemUtil: p.gpuMemoryUtilisation,
      maxNumSeqs: p.maxNumSeqs,
      tokenBudget: p.maxNumBatchedTokens,
      prefixCaching: p.prefixCaching,
      routing: p.routing,
      minPods: p.replicas,
      maxPods: p.replicas,
      shedAfterS: p.queueDeadlineS,
      dramGB: 0,
      ssdGB: 0,
      remoteGB: 0,
      arrivalRate: 0,
      returnProb: 0,
      disagg: false
    };
    this.w = createWorld(params);
    this.w.startedAt = 0;
    const spec = replicaSpec(params);
    for (let k = 0; k < p.replicas; k++) {
      const budget = memoryBudget(spec);
      // the KV pool is BLIS's; the rest of the memory box is the catalogue's weights and the model's estimate
      const kv = (p.kvBlocksPerReplica * budget.blockBytes) / Math.max(1, p.tp);
      const pod: Pod = {
        id: k,
        slot: k,
        role: "both",
        state: "ready",
        born: 0,
        stateSince: 0,
        loadProgress: 1,
        spec,
        budget: { ...budget, kv, poolBlocks: p.kvBlocksPerReplica, headroom: Math.max(0, budget.hbm - budget.weights - budget.activations - budget.graphs - kv) },
        waiting: [],
        running: [],
        inbound: 0,
        stepStart: 0,
        stepEnd: 0,
        plan: null,
        last: null,
        steps: 0,
        entries: new Map(),
        cells: new Int32Array(DISPLAY_CELLS),
        freeCells: DISPLAY_CELLS,
        usedBlocks: 0,
        dramBlocks: 0,
        ssdBlocks: 0,
        idleSince: 0,
        tokensOut: 0,
        decodeDur: 0
      };
      this.w.pods.push(pod);
    }
    // what each follow-up added to the history: its prompt minus the previous prompt and answer
    this.newTokens = file.requests.map((r) => r.inputTokens);
    for (const r of file.requests) {
      const rounds = this.sessionRounds.get(r.session) ?? [];
      rounds.push(r.id);
      this.sessionRounds.set(r.session, rounds);
    }
    for (const ids of this.sessionRounds.values()) {
      for (let k = 1; k < ids.length; k++) {
        const prev = file.requests[ids[k - 1]!]!;
        this.newTokens[ids[k]!] = Math.max(1, file.requests[ids[k]!]!.inputTokens - prev.inputTokens - prev.outputTokens);
      }
    }
    this.lastTokenEvent = Array.from({ length: p.replicas }, () => -1);
    for (const r of file.requests) this.addMarks(r);
    this.marks.sort((a, b) => a.t - b.t || ORDER.indexOf(a.phase) - ORDER.indexOf(b.phase) || a.i - b.i);
    this.endT = file.totals.endS + TAIL_S;
  }

  get world(): RunWorld {
    return this.w;
  }

  /** Whether the clock has passed the last thing BLIS reported. */
  get finished(): boolean {
    return this.w.t >= this.endT - 1e-9;
  }

  /** Where in the run the clock is, 0 to 1. */
  get progress(): number {
    return Math.min(1, this.w.t / this.endT);
  }

  get durationS(): number {
    return this.endT;
  }

  /** The seconds a request occupies the router before BLIS sends it on. */
  private enterAt(r: ReplayRequest): number {
    return Math.min(r.dispatch! + TO_POD_S, Math.max(r.start!, r.dispatch!));
  }

  private addMarks(r: ReplayRequest): void {
    const h = Math.min(HOP_S, r.arrival);
    const m = (t: number, phase: Phase) => this.marks.push({ t, phase, i: r.id });
    m(r.arrival - h, "appear");
    m(r.arrival - (2 * h) / 3, "tokenize");
    m(r.arrival - h / 3, "toGateway");
    m(r.arrival, "arrive");
    if (r.fate !== "completed") {
      m(r.droppedAt!, "drop");
      return;
    }
    m(r.dispatch!, "dispatch");
    m(this.enterAt(r), "enter");
    m(r.start!, "start");
    m(r.firstToken!, "first");
    if (r.preemptedAt !== null) {
      m(r.preemptedAt, "preempt");
      m(r.resumedAt!, "resume");
    }
    m(r.lastToken!, "last");
  }

  /** Seconds the request spends preempted, as [from, to), or null when it is not (or not placed in time). */
  private pause(r: ReplayRequest): [number, number] | null {
    return r.preemptedAt !== null && r.resumedAt !== null ? [r.preemptedAt, r.resumedAt] : null;
  }

  /** Output tokens BLIS's request has produced by time `t`: one at the first token, then an even rate to the last, none during a pause. */
  outAt(r: ReplayRequest, t: number): number {
    if (t < r.firstToken!) return 0;
    if (t >= r.lastToken!) return r.outputTokens;
    const pause = this.pause(r);
    const run = r.lastToken! - r.firstToken! - (pause ? pause[1] - pause[0] : 0);
    const spent = t - r.firstToken! - (pause ? Math.max(0, Math.min(t, pause[1]) - pause[0]) : 0);
    return Math.min(r.outputTokens, 1 + Math.floor(((r.outputTokens - 1) * Math.max(0, spent)) / Math.max(1e-9, run)));
  }

  /** Series value of a pod at time `t`, interpolated between the middles of the bins. */
  seriesAt(pod: number, key: "kv" | "running" | "waiting", t: number): number {
    const s = this.file.series;
    const v = s.pods[pod]![key];
    const x = t / s.intervalS - 0.5;
    const i = Math.max(0, Math.min(v.length - 1, Math.floor(x)));
    const j = Math.min(v.length - 1, i + 1);
    const f = Math.max(0, Math.min(1, x - i));
    return v[i]! + (v[j]! - v[i]!) * f;
  }

  private emit(kind: string, data: Omit<SimEvent, "t" | "kind"> = {}): void {
    this.w.events.push({ t: this.w.t, kind, ...data });
  }

  private session(r: ReplayRequest): Session {
    let s = this.w.sessions.get(r.session);
    if (!s) {
      s = { id: r.session, hue: (r.session * 137.508) % 360, turn: 0, ctxTokens: 0, reqId: null, state: "active", nextTurnAt: 0, born: this.w.t, lastPod: -1, lastTtft: 0, lastTpot: 0 };
      this.w.sessions.set(r.session, s);
      this.emit("session.new", { sid: r.session });
    }
    return s;
  }

  private podOf(r: ReplayRequest): Pod {
    return this.w.pods[r.pod!]!;
  }

  private apply(mark: Mark): void {
    const w = this.w;
    const r = this.file.requests[mark.i]!;
    const id = r.id + 1;
    const req = w.reqs.get(id);
    const h = Math.min(HOP_S, r.arrival);
    switch (mark.phase) {
      case "appear": {
        const s = this.session(r);
        s.state = "active";
        s.reqId = id;
        const fresh = this.newTokens[r.id]!;
        const created: Req = {
          id,
          sid: r.session,
          lIn: r.inputTokens,
          newTokens: fresh,
          lOut: r.outputTokens,
          stage: "send",
          stageStart: r.arrival - h,
          stageEnd: r.arrival - (2 * h) / 3,
          podId: -1,
          prefillDone: 0,
          prefillTarget: r.inputTokens,
          cached: 0,
          out: 0,
          tCreate: r.arrival,
          tFirst: 0,
          admitT: 0,
          preemptions: 0,
          promptIdx: r.session + r.round,
          kvReady: 0,
          counted: false,
          fromPod: -1
        };
        w.reqs.set(id, created);
        w.seen.tokenizer = true;
        this.emit("req.new", { sid: r.session, reqId: id, lIn: r.inputTokens, turn: r.round });
        break;
      }
      case "tokenize":
        if (!req) break;
        req.stage = "tokenize";
        req.stageStart = r.arrival - (2 * h) / 3;
        req.stageEnd = r.arrival - h / 3;
        this.emit("req.tokenized", { sid: r.session, reqId: id, lIn: r.inputTokens, newTokens: this.newTokens[r.id]! });
        break;
      case "toGateway":
        if (!req) break;
        req.stage = "toGateway";
        req.stageStart = r.arrival - h / 3;
        req.stageEnd = r.arrival;
        w.seen.gateway = true;
        break;
      case "arrive":
        if (!req) break;
        req.stage = "queued";
        req.stageStart = r.arrival;
        req.stageEnd = r.dispatch ?? r.droppedAt ?? r.arrival;
        if (r.fate !== "completed" || r.dispatch! > r.arrival) w.gatewayQueue.push(id);
        break;
      case "dispatch": {
        if (!req) break;
        const q = w.gatewayQueue.indexOf(id);
        if (q >= 0) w.gatewayQueue.splice(q, 1);
        const pod = this.podOf(r);
        req.stage = "toPod";
        req.podId = pod.id;
        req.stageStart = r.dispatch!;
        req.stageEnd = this.enterAt(r);
        pod.inbound++;
        this.decide(r);
        break;
      }
      case "enter": {
        if (!req) break;
        const pod = this.podOf(r);
        pod.inbound = Math.max(0, pod.inbound - 1);
        req.stage = "waiting";
        pod.waiting.push(id);
        break;
      }
      case "start": {
        if (!req) break;
        const pod = this.podOf(r);
        pod.waiting = pod.waiting.filter((x) => x !== id);
        pod.running.push(id);
        req.stage = "prefill";
        req.stageStart = r.start!;
        req.stageEnd = r.firstToken!;
        req.cached = r.cachedTokens;
        req.prefillDone = r.cachedTokens;
        req.admitT = r.start!;
        if (!req.counted) {
          req.counted = true;
          w.m.promptTokens += r.inputTokens;
          w.m.cachedTokens += r.cachedTokens;
        }
        break;
      }
      case "first": {
        if (!req) break;
        req.stage = "decode";
        req.stageStart = r.firstToken!;
        req.stageEnd = r.lastToken!;
        req.prefillDone = req.prefillTarget;
        req.out = 1;
        req.tFirst = r.firstToken!;
        this.counted.set(id, 1);
        const pod = this.podOf(r);
        pod.tokensOut += 1;
        w.m.tokensOut += 1;
        w.tokWindow.push({ t: w.t, n: 1 });
        w.m.ttft.push(r.firstToken! - r.arrival);
        this.emit("req.firstToken", { podId: pod.id, sid: r.session, reqId: id, ttft: r.firstToken! - r.arrival });
        break;
      }
      case "preempt": {
        if (!req) break;
        const pod = this.podOf(r);
        pod.running = pod.running.filter((x) => x !== id);
        pod.waiting.push(id);
        req.stage = "waiting";
        req.preemptions++;
        w.m.preemptions++;
        this.emit("req.preempted", { podId: pod.id, sid: r.session, reqId: id, cells: [] });
        break;
      }
      case "resume": {
        if (!req) break;
        const pod = this.podOf(r);
        pod.waiting = pod.waiting.filter((x) => x !== id);
        pod.running.push(id);
        req.stage = "decode";
        break;
      }
      case "last": {
        if (!req) break;
        const pod = this.podOf(r);
        pod.running = pod.running.filter((x) => x !== id);
        const delta = r.outputTokens - (this.counted.get(id) ?? 0);
        if (delta > 0) {
          pod.tokensOut += delta;
          w.m.tokensOut += delta;
          w.tokWindow.push({ t: w.t, n: delta });
        }
        this.counted.delete(id);
        req.out = r.outputTokens;
        w.reqs.delete(id);
        w.m.completed++;
        const tpot = r.outputTokens > 1 ? (r.lastToken! - r.firstToken!) / (r.outputTokens - 1) : 0;
        w.m.tpot.push(tpot);
        this.finishSession(r, pod, r.firstToken! - r.arrival, tpot);
        this.emit("step.tokens", { podId: pod.id, sids: [r.session] });
        this.emit("req.done", { podId: pod.id, sid: r.session, reqId: id, ttft: r.firstToken! - r.arrival, tpot, out: r.outputTokens });
        break;
      }
      case "drop": {
        const q = w.gatewayQueue.indexOf(id);
        if (q >= 0) w.gatewayQueue.splice(q, 1);
        w.reqs.delete(id);
        w.m.failed++;
        const s = w.sessions.get(r.session);
        if (s) {
          s.reqId = null;
          s.state = "idle";
        }
        this.emit("req.failed", { sid: r.session, reqId: id, why: "shed at the router" });
        break;
      }
    }
  }

  private finishSession(r: ReplayRequest, pod: Pod, ttft: number, tpot: number): void {
    const s = this.w.sessions.get(r.session);
    if (!s) return;
    const rounds = this.sessionRounds.get(r.session)!;
    const next = rounds[rounds.indexOf(r.id) + 1];
    s.reqId = null;
    s.ctxTokens = r.inputTokens + r.outputTokens;
    s.turn++;
    s.lastPod = pod.id;
    s.lastTtft = ttft;
    s.lastTpot = tpot;
    s.state = next === undefined ? "idle" : "thinking";
    s.nextTurnAt = next === undefined ? 0 : this.file.requests[next]!.arrival;
  }

  /** The router's decision for a request: what the log recorded, shaped for the picture and the inspector. */
  private decide(r: ReplayRequest): void {
    const f = this.file;
    const pods = this.w.pods;
    const weights = f.scorers.map((s) => s.weight);
    const scores = r.scores ?? pods.map(() => null);
    const totals = r.scores ? weightedTotals(r.scores, weights) : pods.map(() => null);
    this.decisions.push({ reqIndex: r.id, scores, totals, chosen: r.pod! });
    if (this.decisions.length > 200) this.decisions.shift();
    const column = (name: string) => f.scorers.findIndex((s) => s.name === name);
    const cacheCol = column("prefix-cache-scorer");
    const kvCol = column("kv-cache-utilization-scorer");
    const load = (pod: number) => pods[pod]!.running.length + pods[pod]!.waiting.length + pods[pod]!.inbound;
    const decision: RouteDecision = {
      t: this.w.t,
      sid: r.session,
      reqId: r.id + 1,
      chosen: r.pod!,
      policy: f.params.routing,
      capacity: f.params.maxNumSeqs,
      cursor: 0,
      candidates: pods.map((p, k) => {
        const row = scores[k] ?? null;
        return { podId: p.id, load: load(k), cache: row && cacheCol >= 0 ? row[cacheCol]! : 0, tier: row && cacheCol >= 0 && row[cacheCol]! > 0 ? ("hbm" as const) : null, kvUtilisation: row && kvCol >= 0 ? 1 - row[kvCol]! : 0, score: totals[k] ?? 0 };
      })
    };
    this.w.lastRoute = decision;
    this.w.routeLog.push(decision);
    if (this.w.routeLog.length > 32) this.w.routeLog.shift();
    const chosen = decision.candidates[r.pod!]!;
    this.emit("req.routed", { podId: r.pod!, sid: r.session, reqId: r.id + 1, cache: chosen.cache, tier: chosen.tier, load: chosen.load, n: pods.length, via: "blis", role: "both" });
  }

  advance(dt: number): void {
    const w = this.w;
    const to = Math.min(w.t + dt, this.endT);
    if (to <= w.t) return;
    while (this.cursor < this.marks.length && this.marks[this.cursor]!.t <= to + 1e-12) {
      const mark = this.marks[this.cursor++]!;
      w.t = Math.max(w.t, mark.t);
      this.apply(mark);
    }
    w.t = to;
    this.refresh();
  }

  /** Continuous quantities at the current time: prompt and answer progress, tokens in the throughput window, the pods' KV fill, token particles. */
  private refresh(): void {
    const w = this.w;
    const t = w.t;
    const perPod = new Map<number, number[]>();
    let moved = 0;
    for (const req of w.reqs.values()) {
      const r = this.file.requests[req.id - 1]!;
      if (req.stage === "prefill") {
        const u = Math.max(0, Math.min(1, (t - r.start!) / Math.max(1e-9, r.firstToken! - r.start!)));
        req.prefillDone = Math.round(r.cachedTokens + (r.inputTokens - r.cachedTokens) * u);
      } else if (req.stage === "decode") {
        const out = this.outAt(r, t);
        const seen = this.counted.get(req.id) ?? 0;
        if (out > seen) {
          moved += out - seen;
          this.counted.set(req.id, out);
          const pod = this.podOf(r);
          pod.tokensOut += out - seen;
          w.m.tokensOut += out - seen;
        }
        req.out = out;
        (perPod.get(r.pod!) ?? perPod.set(r.pod!, []).get(r.pod!)!).push(r.session);
      }
    }
    if (moved) w.tokWindow.push({ t, n: moved });
    while (w.tokWindow.length && w.tokWindow[0]!.t < t - 2 * WINDOW_S) w.tokWindow.shift();
    for (const pod of w.pods) {
      pod.usedBlocks = Math.round(Math.max(0, Math.min(1, this.seriesAt(pod.id, "kv", t))) * pod.budget.poolBlocks);
      const sids = perPod.get(pod.id);
      if (sids && t - this.lastTokenEvent[pod.id]! >= TOKEN_EVENT_S) {
        this.lastTokenEvent[pod.id] = t;
        this.emit("step.tokens", { podId: pod.id, sids });
      }
    }
  }

  /** The request the file lists at this index. */
  request(index: number): ReplayRequest {
    return this.file.requests[index]!;
  }

  /** All requests of one session, in round order. */
  sessionRequests(session: number): ReplayRequest[] {
    return (this.sessionRounds.get(session) ?? []).map((i) => this.file.requests[i]!);
  }

  /** The decision for the request with this index, if the router has made it yet. */
  decisionFor(index: number): Decision | undefined {
    for (let k = this.decisions.length - 1; k >= 0; k--) if (this.decisions[k]!.reqIndex === index) return this.decisions[k];
    return undefined;
  }

  /** The series' running and waiting counts for a pod now, as BLIS reported them (rounded to whole requests). */
  podCounts(pod: number): { running: number; waiting: number; kv: number } {
    const t = this.w.t;
    return { running: this.seriesAt(pod, "running", t), waiting: this.seriesAt(pod, "waiting", t), kv: this.seriesAt(pod, "kv", t) };
  }
}
