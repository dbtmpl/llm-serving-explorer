/**
 * The step-through script: which steps one followed session goes through, in which order, and
 * what each one highlights. The wording is in src/content/step-through.md; callouts.ts builds the
 * short callout of a single event (also used by "explain" mode), this file turns the events of one
 * session into the longer walkthrough.
 *
 * A step that teaches a concept is shown the first time the walkthrough meets it (`Script.shown`);
 * later turns of the same session get the short variant or skip it.
 */
import { DISPLAY_CELLS, kvBytesPerToken, prefixAwareTerms, reloadTimes, replicaSpec, ridge, type Routing, type RouteDecision, type SimEvent, type World } from "../sim/index.js";
import { fill, stepField } from "../content/index.js";
import { TIER_NAME, calloutFor, make, type Callout } from "./callouts.js";
import { fmtGB, fmtInt, fmtMs } from "./format.js";
import type { Target } from "./render.js";

/** What the walkthrough has already said, so a later turn does not repeat it. Plain data: it is cloned with each step. */
export interface Script {
  /** ids of entries shown in full */
  shown: Set<string>;
  /** requests that have been admitted to a pod at least once */
  admitted: Set<number>;
  /** fleet steps shown while the followed request waits for a pod */
  waiting: Set<string>;
  /** the followed request has been sent to a pod, so later fleet events are not about waiting for one */
  routed: boolean;
  /** fleet steps that happened before the request reached the router; shown once it is queued there */
  deferred: Callout[];
  /** the walkthrough has forced the eviction of the followed session and the next kv event is its result */
  forcing: boolean;
}

export const newScript = (): Script => ({ shown: new Set(), admitted: new Set(), waiting: new Set(), routed: false, deferred: [], forcing: false });

/** A step that waits for a visual condition is released after this many seconds anyway (simulated, or animation for `hold`). */
export const GATE_TIMEOUT_S = 6;

/** The answer is being written: wait for this many tokens, so the gauge has settled left of the ridge. */
const DECODE_TOKENS_SHOWN = 4;

const decodeUnderway = (reqId: number): Callout["until"] => (w) => {
  const r = w.reqs.get(reqId);
  return !r || r.out >= Math.min(DECODE_TOKENS_SHOWN, r.lOut);
};

const tierSize = (gb: number) => (gb > 0 ? `${gb} GB` : "off");

/** The pod that holds an idle copy of the session's KV in GPU memory, if there is one (so the eviction can be shown). */
const holdsIdle = (w: World, sid: number, podId?: number): boolean => w.pods.some((p) => (podId === undefined || p.id === podId) && p.entries.get(sid)?.tier === "hbm" && !p.entries.get(sid)!.active);

type Candidate = RouteDecision["candidates"][number];

/** The terms of the prefix-aware score of one candidate, formatted for a table row. */
const termsOf = (c: Candidate, capacity: number) => prefixAwareTerms({ cachedFraction: c.cache, cacheLocation: c.tier, kvUtilisation: c.kvUtilisation, load: c.load, capacity });

const TABLE_ROWS = 6;

/**
 * How a routing decision reads, as values for the `walk.picked` entry: the table with one row per
 * candidate and the words that explain it. Null when the decision is no longer in the log.
 */
function routeValues(e: SimEvent, w: World, policy: Routing) {
  let d: RouteDecision | undefined;
  for (const x of w.routeLog) if (x.reqId === e.reqId) d = x;
  if (!d) return null;
  const chosen = d.candidates.find((c) => c.podId === d.chosen);
  if (!chosen) return null;
  const two = (v: number) => v.toFixed(2);
  const n = d.candidates.length;
  const decision = d;
  // the chosen pod first, then the best of the rest, so a long list stays readable
  const rest = d.candidates.filter((c) => c !== chosen).sort((a, b) => b.score - a.score);
  const shown = [chosen, ...rest.slice(0, TABLE_ROWS - 1)].sort((a, b) => a.podId - b.podId);
  const scored = policy === "prefix-aware" || policy === "bounded-load-affinity" || policy === "age-discounted";
  const tablePolicy = scored ? "prefix-aware" : policy;
  const row = (c: Candidate): string => {
    const win = c === chosen ? "-chosen" : "";
    const base = { podId: c.podId };
    if (scored) {
      const t = termsOf(c, decision.capacity);
      return fill(stepField("walk.picked", `row-${tablePolicy}${win}`), { ...base, c: two(t.cache.share), m: two(t.kv.share), q: two(t.queue.share), score: two(c.score) });
    }
    return fill(stepField("walk.picked", `row-${tablePolicy}${win}`), { ...base, load: c.load });
  };
  const table = [stepField("walk.picked", `head-${tablePolicy}`), ...shown.map(row)].join("\n");
  const more = n - shown.length;
  const out: Record<string, string | number> = { table };
  const notes: string[] = [];
  if (more > 0) {
    out.more = more;
    notes.push("more");
  }
  if (n === 1) notes.push("why-single");
  else if (policy === "least-loaded") {
    out.n = n;
    notes.push("calc-least-loaded");
  } else if (policy === "round-robin") {
    Object.assign(out, { turn: d.cursor, n, slot: d.cursor % n });
    notes.push("calc-round-robin");
  } else {
    const terms = (c: Candidate) => termsOf(c, decision.capacity);
    const load = (c: Candidate) => terms(c).kv.term + terms(c).queue.term;
    const best = d.candidates.reduce((m, c) => (terms(c).cache.share > terms(m).cache.share ? c : m), d.candidates[0]!);
    if (terms(best).cache.share === 0) {
      const first = (w.sessions.get(e.sid ?? -1)?.turn ?? 1) === 0;
      notes.push(first ? "why-first-message" : "why-nothing-held");
      if (d.candidates.every((c) => c.score === chosen.score)) notes.push("why-tie");
    } else if (best === chosen) {
      const rival = rest.reduce<Candidate | null>((m, c) => (!m || load(c) > load(m) ? c : m), null);
      const lead = rival ? load(rival) - load(chosen) : 0;
      Object.assign(out, { cache: (chosen.cache * 100).toFixed(0), cacheTerm: two(terms(chosen).cache.term) });
      if (rival && lead > 0) {
        Object.assign(out, { otherId: rival.podId, lead: two(lead) });
        notes.push("why-cache-wins");
      } else notes.push("why-cache-clear");
    } else {
      Object.assign(out, { otherId: best.podId, otherCache: (best.cache * 100).toFixed(0), otherCacheTerm: two(terms(best).cache.term), lead: two(load(chosen) - load(best)) });
      notes.push("why-cache-loses");
    }
  }
  return { values: out, notes };
}

/** The steps for one event of the followed session, in the order they are shown. */
export function stepsFor(e: SimEvent, w: World, script: Script): Callout[] {
  const sess: Target = { type: "session", id: e.sid ?? 0 };
  const pod = (part: "engine" | "gpu" | "roofline" | "tiers" | "all" = "engine"): Target => ({ type: "pod", id: e.podId!, part });
  const first = (id: string): boolean => {
    if (script.shown.has(id)) return false;
    script.shown.add(id);
    return true;
  };
  const waitFirst = (id: string): boolean => {
    if (script.waiting.has(id)) return false;
    script.waiting.add(id);
    return true;
  };
  const p = e.podId !== undefined ? w.pods.find((x) => x.id === e.podId) : undefined;

  switch (e.kind) {
    case "req.new":
      script.routed = false;
      // a follow-up has its own, req.followup
      return (e.turn as number) > 0 ? [] : calloutFor(e, w);

    case "req.followup":
      script.routed = false;
      return calloutFor(e, w);

    case "store.read":
      return calloutFor(e, w);

    case "req.tokenized": {
      const lIn = e.lIn as number;
      const fresh = e.newTokens as number;
      const again = !first("req.tokenized");
      const out = [make("req.tokenized", { key: "tok", target: { type: "tokenizer" }, tone: "info" }, { tokens: fmtInt(lIn), history: fmtInt(lIn - fresh), fresh: fmtInt(fresh) }, { detail: again ? "detail-again" : "detail" })];
      if (again) return out;
      const perToken = kvBytesPerToken(replicaSpec(w.params).model);
      out.push(make("walk.cost", { key: "cost", target: { type: "tokenizer" }, tone: "info" }, { tokens: fmtInt(lIn), perToken: `${(perToken / 1024).toFixed(0)} KiB`, kv: fmtGB(lIn * perToken, 2) }));
      const shed = w.params.shedAfterS;
      out.push(make("walk.deadline", { key: "deadline", target: { type: "gateway" }, tone: "info" }, shed > 0 ? { limit: `${shed} s` } : {}, { body: shed > 0 ? "body-set" : "body-never" }));
      return out;
    }

    case "req.queued": {
      script.waiting.add("req.queued");
      const deferred = script.deferred;
      script.deferred = [];
      const queued = calloutFor(e, w);
      // with a pod ready the autoscaler's decision is not what the request waits for
      return queued.length ? [...queued, ...deferred] : [];
    }
    case "scale.up":
    case "pod.failed":
    case "pod.loading":
    case "pod.ready": {
      if (script.routed || !waitFirst(e.kind)) return [];
      const c = calloutFor(e, w);
      // the autoscaler reacts to the request before it has been counted and queued: say it after the router has nothing to give it
      if (e.kind === "scale.up" && !script.waiting.has("req.queued")) {
        script.deferred.push(...c);
        return [];
      }
      return c;
    }

    case "req.routed": {
      script.waiting.clear();
      script.deferred = [];
      script.routed = true;
      const policy = w.params.routing;
      const out: Callout[] = [];
      if (first("req.routed")) out.push(...calloutFor(e, w));
      const rv = routeValues(e, w, policy);
      const tier = e.tier as string | null;
      const cache = ((e.cache as number) * 100).toFixed(0);
      const load = e.load as number;
      const holds = tier === "hbm" ? "holds-hbm" : tier ? "holds-tier" : "holds-none";
      const busy = load === 0 ? "busy-none" : load === 1 ? "busy-one" : "busy-many";
      const sentence = [holds, busy];
      const values = {
        podId: e.podId!,
        ...(rv?.values ?? {}),
        ...(tier !== null ? { cache } : {}),
        ...(tier !== null && tier !== "hbm" ? { tier: TIER_NAME[tier]! } : {}),
        ...(load > 1 ? { load } : {})
      };
      // the table's own values (cache share of the winner) may repeat the holds sentence's {cache}
      out.push(
        make(
          "walk.picked",
          { key: "picked", target: { type: "gateway" }, tone: "info" },
          values,
          { title: "title", body: rv ? ["table", ...rv.notes] : sentence, detail: rv ? [...sentence, "pinned"] : ["pinned"] }
        )
      );
      if (first("walk.arrive")) out.push(make("walk.arrive", { key: "arrive", target: pod("engine"), tone: "info" }));
      return out;
    }

    case "req.admitted": {
      const reqId = e.reqId!;
      const cached = e.cached as number;
      const lIn = e.lIn as number;
      const again = script.admitted.has(reqId);
      script.admitted.add(reqId);
      if (again) {
        const handoff = p?.role === "decode";
        return [make("req.admitted.again", { key: "again", target: pod("engine"), tone: "prefill" }, handoff ? {} : { prompt: fmtInt(lIn) }, { body: handoff ? "body-handoff" : "body-preempted" })];
      }
      const out: Callout[] = [];
      if (first("walk.slot")) out.push(make("walk.slot", { key: "slot", target: pod("engine"), tone: "info" }, { slots: w.params.maxNumSeqs }));
      if (cached > 16) {
        out.push({ ...calloutFor(e, w)[0]!, target: pod("gpu") });
      } else if ((e.turn as number) > 1) {
        out.push(...calloutFor(e, w));
      } else {
        out.push(...calloutFor(e, w));
        if (first("walk.kvmap") && p) out.push(make("walk.kvmap", { key: "kvmap", target: pod("gpu"), tone: "prefill" }, { cellBlocks: fmtInt(p.budget.poolBlocks / DISPLAY_CELLS), pool: ((p.budget.kv * p.spec.tp) / 1e9).toFixed(1) }));
        if (first("walk.roofline") && p) out.push(make("walk.roofline", { key: "roofline", target: pod("roofline"), tone: "prefill" }, { ridge: ridge(p.spec.gpu).toFixed(0) }));
      }
      return out;
    }

    case "req.firstToken":
      if (!first("req.firstToken")) return [];
      return calloutFor(e, w).map((c) => ({ ...c, until: decodeUnderway(e.reqId!) }));

    case "step.tokens": {
      if (!first("step.tokens.stream")) return [];
      const sid = e.sid ?? 0;
      return calloutFor(e, w)
        .filter((c) => c.content === "step.tokens.stream")
        .map((c) => ({ ...c, animate: true, until: (_w, scene) => scene.repliesInFlight(sid) }));
    }

    case "req.done": {
      const sid = e.sid!;
      const done = make("req.done", { key: "done", target: pod("engine"), focus: pod("all"), tone: "info" }, { tpot: fmtMs(e.tpot as number), out: e.out as number }, { detail: first("req.done") ? "detail" : "detail-again" });
      const reply = make("walk.reply", { key: "reply", target: { type: "session", id: sid }, tone: "info", hold: true }, { sid, out: e.out as number, ttft: fmtMs(e.ttft as number) });
      reply.until = (_w, scene) => !scene.repliesInFlight(sid);
      return [done, reply];
    }

    case "store.append":
      return calloutFor(e, w);

    case "session.idle": {
      const out = calloutFor(e, w);
      const sid = e.sid!;
      if (e.cached && holdsIdle(w, sid, e.podId)) {
        out.push(make("walk.evict.when", { key: "evict.when", target: pod("gpu"), tone: "evict" }));
        out.push({ ...make("walk.evict.force", { key: "evict.force", target: pod("tiers"), focus: pod("all"), tone: "evict" }, { sid }), evict: { sid, podId: e.podId! } });
      } else out.push(end(sid, "body-idle"));
      return out;
    }

    case "kv.move":
    case "kv.drop": {
      // the whole pod is framed: the cells leave the grid above and arrive in the tier bars below
      let base: Callout[] = calloutFor(e, w).map((c) => ({ ...c, animate: true, ...(e.podId !== undefined ? { focus: pod("all") } : {}) }));
      if (!script.forcing) return base;
      // forced: "idle for 0.0 s" would only confuse
      if (e.kind === "kv.move" && e.to === "dram") base = [{ ...make("kv.move.dram", { key: "evict.dram", target: pod("tiers"), focus: pod("all"), tone: "dram", animate: true }, { sid: e.sid!, size: fmtGB(e.bytes as number, (e.bytes as number) < 1e9 ? 2 : 1) }, { body: "body-forced" }) }];
      script.forcing = false;
      const sid = e.sid!;
      const params = w.params;
      const cases = make("walk.evict.cases", { key: "evict.cases", target: pod("tiers"), tone: "evict" }, { dram: tierSize(params.dramGB), ssd: tierSize(params.ssdGB), remote: tierSize(params.remoteGB) });
      let back: Callout;
      if (e.kind === "kv.drop" || !p) back = make("walk.evict.return", { key: "evict.return", target: pod("tiers"), tone: "evict" }, { tokens: fmtInt(e.tokens as number) }, { body: "body-dropped" });
      else {
        const tier = e.to as "dram" | "ssd" | "remote";
        const t = reloadTimes(params, p.spec, tier, e.bytes as number, e.tokens as number);
        back = make("walk.evict.return", { key: "evict.return", target: pod("tiers"), tone: "evict" }, { size: fmtGB(e.bytes as number, 2), tier: TIER_NAME[tier]!, load: fmtMs(t.loadSeconds), recompute: fmtMs(t.recomputeSeconds) }, { body: t.loads ? "body-load" : "body-recompute" });
      }
      return [...base, cases, back, end(sid, "body-evicted")];
    }

    case "req.failed":
      return [...calloutFor(e, w), end(e.sid!, "body-failed")];

    case "kv.reload":
    case "kv.skipload":
    case "kv.transfer":
    case "req.preempted":
      return calloutFor(e, w).map((c) => (e.kind === "kv.reload" ? { ...c, animate: true } : c));

    default:
      return calloutFor(e, w);
  }
}

/** The closing box; `body` names the variant that says what happened to this session. */
export function end(sid: number, body: "body-evicted" | "body-idle" | "body-failed"): Callout {
  return { ...make("walk.end", { key: "end", target: { type: "session", id: sid }, tone: "info" }, { sid }, { body }), last: true };
}
