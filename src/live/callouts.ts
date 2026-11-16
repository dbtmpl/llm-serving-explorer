/**
 * Short explanations that appear next to the node where something just happened.
 * The wording lives in src/content/step-through.md; this file decides which entry an event maps
 * to, which variant to use, and the values to fill in. `title`, `body` and `detail` of a Callout
 * are already-filled markdown, rendered with <Rich>.
 */
import { diveConcepts, stepText, type DiveConcept } from "../content/index.js";
import { fmtGB, fmtInt, fmtMs } from "./format.js";
import type { Scene, Target } from "./render.js";
import { POD_QUEUE_SLACK, SCORER_WEIGHTS, TIER_AFFINITY, fitOf, prefixAwareTerms, replicaSpec, type SimEvent, type World } from "../sim/index.js";

export interface Callout {
  key: string;
  /** id of the entry in src/content/step-through.md this text came from */
  content: string;
  target: Target;
  /**
   * What step-through frames and highlights, when that is narrower than `target`: for example a
   * part of a pod (`{ type: "pod", id, part: "gpu" }`) while the callout stays attached to the pod.
   * Defaults to `target`. A pod target with a `part` already means that part.
   */
  focus?: Target;
  /** markdown (inline); where in the system this step happens (step-through only) */
  at?: string;
  /** markdown (inline) */
  title: string;
  /** markdown */
  body: string;
  /** markdown; a second paragraph, shown in step-through mode */
  detail?: string;
  /** the theory behind this step: the concepts of its `dive` field, shown as "Dive deeper" in the step-through box */
  dive: DiveConcept[];
  tone: "info" | "prefill" | "decode" | "dram" | "ssd" | "remote" | "evict";
  /** shown only the first time it happens */
  once?: boolean;
  /** minimum seconds between repeats (default 2.5) */
  every?: number;
  /**
   * Step-through: the step is held only once this is true. Until then the clock keeps running (or,
   * with `hold`, only the animation does) and later steps wait behind it.
   */
  until?: (w: World, scene: Scene) => boolean;
  /** with `until`: stop the simulation clock while waiting and let only the animation run */
  hold?: boolean;
  /** the animation keeps playing while this step is held (the simulation clock stays stopped) */
  animate?: boolean;
  /** pressing Next on this step forces the eviction of this idle session from GPU memory */
  evict?: { sid: number; podId: number };
  /** the last box of a followed session: Next follows another session */
  last?: boolean;
  /** when the step was queued, in simulated and animation seconds (set by the interface; gives `until` a time-out) */
  queuedAt?: { t: number; vt: number };
}

/** The load of the cached pod at which an idle pod, whose KV pool is empty, first outscores it, with a pool `kvUse` in use. */
export function overtakeLoad(capacity: number, kvUse: number): number {
  const cached = (load: number) => prefixAwareTerms({ cachedFraction: 1, cacheLocation: "hbm", kvUtilisation: kvUse, load, capacity });
  const total = (t: ReturnType<typeof cached>) => t.cache.term + t.kv.term + t.queue.term;
  const idle = total(prefixAwareTerms({ cachedFraction: 0, cacheLocation: null, kvUtilisation: 0, load: 0, capacity }));
  let load = 0;
  while (load < capacity && total(cached(load)) >= idle) load++;
  return load;
}

/** The numbers that explain the routing score in words (the detail of `req.routed`); all come from the model. */
export function scoreFacts(w: World) {
  const slots = w.params.maxNumSeqs;
  const cap = slots + POD_QUEUE_SLACK;
  const loadMax = SCORER_WEIGHTS.kvUtilisation + SCORER_WEIGHTS.queue;
  const exampleKv = 0.75;
  return {
    cap,
    slots,
    slack: POD_QUEUE_SLACK,
    wCache: SCORER_WEIGHTS.prefixCache,
    wKv: SCORER_WEIGHTS.kvUtilisation,
    wQueue: SCORER_WEIGHTS.queue,
    loadMax,
    lead96: (SCORER_WEIGHTS.prefixCache * 0.96).toFixed(2),
    exampleKv: exampleKv * 100,
    exampleLoad: overtakeLoad(cap, exampleKv),
    affHbm: TIER_AFFINITY.hbm,
    affDram: TIER_AFFINITY.dram,
    affSsd: TIER_AFFINITY.ssd,
    affRemote: TIER_AFFINITY.remote
  };
}

/** Which field of the `req.routed` entry describes each routing policy. */
const HOW = { "prefix-aware": "how-prefix-aware", "least-loaded": "how-least-loaded", "round-robin": "how-round-robin" } as const;

export const TIER_NAME: Record<string, string> = { hbm: "HBM", dram: "DRAM", ssd: "SSD", remote: "the remote pool" };

export type Meta = Pick<Callout, "key" | "target" | "tone"> & Partial<Pick<Callout, "once" | "every" | "focus" | "until" | "hold" | "animate">>;
export type Say = Parameters<typeof stepText>;

/** Build a callout: where it goes and when (meta), and which entry of step-through.md fills it. */
export const make = (content: string, meta: Meta, values?: Say[2], pick?: Say[1]): Callout => ({ ...meta, content, ...stepText(content, pick, values), dive: diveConcepts(content) });

export function calloutFor(e: SimEvent, w: World): Callout[] {
  const pod = (part: "engine" | "gpu" | "roofline" | "tiers" = "engine"): Target => ({ type: "pod", id: e.podId!, part });
  const sess: Target = { type: "session", id: e.sid ?? 0 };
  const p = w.pods.find((x) => x.id === e.podId);
  const size = () => fmtGB(e.bytes as number, (e.bytes as number) < 1e9 ? 2 : 1);
  switch (e.kind) {
    case "req.new":
      return [make("req.new", { key: "req.new", once: true, target: sess, tone: "info" }, { sid: e.sid! })];
    case "store.read":
      return [make("store.read", { key: "store.read", once: true, target: { type: "store" }, tone: "info" }, { history: fmtInt(e.history as number), fresh: fmtInt(w.reqs.get(e.reqId!)?.newTokens ?? 0) })];
    case "req.tokenized":
      return [make("req.tokenized", { key: "tok", once: true, target: { type: "tokenizer" }, tone: "info" }, { tokens: fmtInt(e.lIn as number), history: fmtInt((e.lIn as number) - (e.newTokens as number)), fresh: fmtInt(e.newTokens as number) })];
    case "req.queued":
      if (w.pods.some((x) => x.state === "ready")) return [];
      return [make("req.queued", { key: "queued", once: true, target: { type: "gateway" }, tone: "info" }, { minPods: w.params.minPods })];
    case "scale.up": {
      const to = e.to as number;
      const demand = e.demand as number;
      const capped = to >= w.params.maxPods;
      return [
        make(
          "scale.up",
          { key: "scale.up", every: 0, target: { type: "gateway" }, tone: "info" },
          { to, demand: fmtInt(demand), perPod: e.perPod as number, ...(capped ? { maxPods: w.params.maxPods } : {}) },
          {
            title: to > 1 ? "title-many" : "title-one",
            body: [demand > 1 ? "demand-many" : "demand-one", to > 1 ? "needed-many" : "needed-one", capped && "cap"],
            detail: ["detail", w.params.disagg && "detail-disagg"]
          }
        )
      ];
    }
    case "pod.loading":
      return p ? [make("pod.loading", { key: "loading", once: true, target: pod("gpu"), tone: "info" }, { weights: fmtGB(p.budget.weights), cold: `${w.params.coldStartS} s` })] : [];
    case "pod.ready":
      return p ? [make("pod.ready", { key: "ready", once: true, target: pod("gpu"), tone: "info" }, { weights: fmtGB(p.budget.weights), work: fmtGB(p.budget.activations + p.budget.graphs), headroom: fmtGB(p.budget.headroom), kv: fmtGB(p.budget.kv), blocks: fmtInt(p.budget.poolBlocks) })] : [];
    case "pod.failed":
      return p ? [make("pod.failed", { key: `failed${e.podId}`, target: pod("gpu"), tone: "evict" }, { fixed: fmtGB(p.budget.weights + p.budget.activations + p.budget.graphs), usable: fmtGB(p.budget.device - p.budget.headroom) })] : [];
    case "req.routed": {
      const policy = w.params.routing;
      return [
        make(
          "req.routed",
          { key: "routed", once: true, target: { type: "gateway" }, tone: "info" },
          { podId: e.podId!, ...(policy === "prefix-aware" ? scoreFacts(w) : {}) },
          {
            body: [HOW[policy], e.via === "prefill" && "via-prefill", e.via === "decode-only" && "via-decode-only"],
            detail: `detail-${policy}`
          }
        )
      ];
    }
    case "req.followup":
      return [make("req.followup", { key: "followup", every: 5, target: sess, tone: "info" }, { turn: e.turn as number, sid: e.sid!, history: fmtInt(e.history as number), fresh: fmtInt(e.fresh as number) })];
    case "req.admitted": {
      const cached = e.cached as number;
      const lIn = e.lIn as number;
      if (cached > 16) return [make("req.admitted.hit", { key: `hit${e.podId}`, target: pod(), tone: "decode" }, { cached: fmtInt(cached), prompt: fmtInt(lIn), fresh: fmtInt(lIn - cached) })];
      if ((e.turn as number) > 1) return [make("req.admitted.miss", { key: `miss${e.podId}`, every: 4, target: pod(), tone: "prefill" }, { sid: e.sid!, prompt: fmtInt(lIn) })];
      return [make("req.admitted.prefill", { key: "prefill", once: true, target: pod(), tone: "prefill" }, { prompt: fmtInt(lIn) })];
    }
    case "req.firstToken":
      return [make("req.firstToken", { key: "decode", once: true, target: pod("roofline"), tone: "decode" }, { ttft: fmtMs(e.ttft as number) })];
    case "step.tokens": {
      const n = (e.sids as number[]).length;
      const out: Callout[] = [make("step.tokens.stream", { key: "stream", once: true, target: { type: "stream" }, tone: "decode" })];
      if (n >= 4) out.push(make("step.tokens.batch", { key: "batch", once: true, target: pod(), tone: "decode" }, { n }));
      return out;
    }
    case "step.spec": {
      const seqs = e.seqs as number;
      return [make("step.spec", { key: "spec", every: 20, target: pod("roofline"), tone: "decode" }, { tokens: e.tokens as number, seqs, k: e.k as number }, { title: seqs > 1 ? "title-many" : "title-one" })];
    }
    case "kv.transfer":
      return [make("kv.transfer", { key: "transfer", every: 6, target: pod(), tone: "decode" }, { sid: e.sid!, from: e.from as number, size: size(), link: w.params.linkGbps, dur: fmtMs(e.dur as number) })];
    case "step.mixed": {
      const instead = (e.decodeDur as number) > 0;
      return [
        make(
          "step.mixed",
          { key: `mixed${e.podId}`, every: 12, target: pod("roofline"), tone: "prefill" },
          { prefillTok: fmtInt(e.prefillTok as number), decodeTok: e.decodeTok as number, dur: fmtMs(e.dur as number), ...(instead ? { decodeDur: fmtMs(e.decodeDur as number) } : {}) },
          { body: instead ? "body-instead" : "body" }
        )
      ];
    }
    case "req.done":
      return [make("req.done", { key: "done", once: true, target: pod(), tone: "info" }, { tpot: fmtMs(e.tpot as number), out: e.out as number })];
    case "store.append":
      return [make("store.append", { key: "store.append", once: true, target: { type: "store" }, tone: "info" })];
    case "session.idle":
      return [make("session.idle", { key: "idle", every: 6, target: sess, tone: "info" }, { sid: e.sid!, ...(e.cached ? { size: size() } : {}) }, { body: e.cached ? "body-cached" : "body-freed" })];
    case "churn": {
      const rate = e.rate as number;
      return [
        make(
          "churn",
          { key: "churn", every: 10, target: sess, tone: "info" },
          { total: fmtInt(e.total as number), active: fmtInt(e.active as number), typing: fmtInt(e.typing as number), idle: fmtInt(e.idle as number), ...(rate > 0 ? { rate } : {}) },
          { body: [rate > 0 && "rate", "body"] }
        )
      ];
    }
    case "kv.move": {
      if (e.to === "dram") return [make("kv.move.dram", { key: `evict${e.podId}`, target: pod("tiers"), tone: "dram" }, { sid: e.sid!, idleFor: (e.idleFor as number).toFixed(1), size: size() })];
      if (e.to === "ssd") return [make("kv.move.ssd", { key: `evict${e.podId}`, target: pod("tiers"), tone: "ssd" }, { from: TIER_NAME[e.from as string]!, sid: e.sid!, size: size() })];
      return [make("kv.move.remote", { key: "toremote", every: 4, target: { type: "remote" }, tone: "remote" }, { sid: e.sid!, size: size() })];
    }
    case "kv.drop":
      return [make("kv.drop", { key: e.podId ? `evict${e.podId}` : "remotedrop", target: e.podId ? pod("tiers") : { type: "remote" }, tone: "evict" }, { sid: e.sid!, tokens: fmtInt(e.tokens as number) })];
    case "kv.reload":
      return [make("kv.reload", { key: `evict${e.podId}`, target: pod("tiers"), tone: e.from === "dram" ? "dram" : e.from === "ssd" ? "ssd" : "remote" }, { from: TIER_NAME[e.from as string]!, sid: e.sid!, size: size(), dur: fmtMs(e.dur as number), recompute: fmtMs(e.recompute as number) })];
    case "kv.skipload":
      return [make("kv.skipload", { key: `skip${e.podId}`, every: 5, target: pod("tiers"), tone: "prefill" }, { sid: e.sid!, from: TIER_NAME[e.from as string]!, dur: fmtMs(e.dur as number), tokens: fmtInt(e.tokens as number), recompute: fmtMs(e.recompute as number) })];
    case "req.preempted":
      return [make("req.preempted", { key: `pre${e.podId}`, target: pod(), tone: "evict" }, { sid: e.sid!, lost: fmtInt(e.lost as number) })];
    case "req.failed":
      return [make("req.failed", { key: "failed", target: e.podId !== undefined ? pod() : { type: "gateway" }, tone: "evict" }, { sid: e.sid!, why: e.why as string })];
    case "scale.down":
      return [make("scale.down", { key: `down${e.podId}`, target: pod(), tone: "info" }, { idle: (e.idle as number).toFixed(0) })];
    case "fleet.restart": {
      const requeued = (e.requeued as number | undefined) ?? 0;
      const inFlight = (e.inFlight as number | undefined) ?? 0;
      const fit = fitOf(w.params);
      const spec = replicaSpec(w.params);
      if (!fit.fits) return [make("fleet.restart", { key: "restart", every: 0, target: { type: "gateway" }, tone: "evict" }, { model: spec.model.label, precision: spec.precision === "fp8" ? "FP8" : "BF16", gpu: spec.gpu.label }, { body: "body-nofit" })];
      return [
        make(
          "fleet.restart",
          { key: "restart", every: 0, target: { type: "gateway" }, tone: "info" },
          { cold: w.params.coldStartS, ...(requeued > 1 ? { requeued: fmtInt(requeued) } : requeued === 0 && inFlight > 0 ? { inFlight: fmtInt(inFlight) } : {}) },
          { body: requeued > 1 ? "body-requests-many" : requeued === 1 ? "body-requests-one" : inFlight > 0 ? "body-queued" : "body-idle" }
        )
      ];
    }
    default:
      return [];
  }
}

/** Event kinds that stop the clock in step-through mode when they concern the followed session. */
export const STEP_KINDS = new Set(["req.new", "req.followup", "store.read", "req.tokenized", "req.queued", "req.routed", "req.admitted", "req.firstToken", "step.tokens", "req.done", "store.append", "req.preempted", "req.failed", "kv.move", "kv.drop", "kv.reload", "kv.skipload", "kv.transfer", "session.idle"]);
