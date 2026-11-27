/**
 * Workload: who sends requests, how long they are, and what happens between turns.
 *
 * Sessions are closed-loop: a user sends a turn, waits for the whole answer, thinks, and only
 * then sends the next one, so load depends on how fast the system answers (Schroeder et al.,
 * NSDI 2006, on closed versus open workload models). New sessions can also arrive open-loop at a
 * fixed rate. Each follow-up turn re-sends the whole conversation, which is what makes prefix
 * caching and KV tiering matter (Gao et al., USENIX ATC 2024).
 *
 * Lengths are drawn uniformly around the configured means. Real length distributions are
 * heavy-tailed; uniform keeps a small scene readable. Illustrative, not fitted to a trace.
 */
import type { ApproachMeta, Concept } from "../approach.js";
import { emit, rand } from "../core/world.js";
import type { Req, Session, World } from "../core/types.js";
import { FRONTEND_HOPS } from "./frontend.js";
import { dueTraceRequests, traceReplay } from "./trace.js";

/** Uniform ranges, as multiples of the configured mean. */
export const LENGTH_JITTER = {
  firstPrompt: [0.6, 1.4],
  followUp: [0.4, 1.6],
  output: [0.5, 1.5]
} as const satisfies Record<string, readonly [number, number]>;

/** Think time is uniform in [0.5, 1.5) times the configured mean. */
export const THINK_TIME_JITTER = { min: 0.5, span: 1 } as const;

/** A request produces at least a first token and one more, so that time per output token is defined. */
export const MIN_OUTPUT_TOKENS = 2;

/** Sessions of one burst are spread by up to this many seconds so they do not arrive in one tick. */
export const BURST_ARRIVAL_JITTER_S = 0.02;

/** Sessions kept in memory. Beyond this, idle ones are forgotten in batches. */
export const MAX_SESSIONS = 12000;
export const SESSION_PRUNE_BATCH = 200;

/** Successive session colours are a golden angle apart, so neighbours never look alike. */
export const HUE_STEP_DEGREES = 137.508;

/** Number of sample prompts the interface can show for a request. */
export const SAMPLE_PROMPTS = 1000;

export const closedLoopSessions: ApproachMeta = {
  id: "closed-loop-sessions",
  name: "Closed-loop multi-turn sessions",
  summary: "Users wait for an answer, think, then re-send the whole conversation plus a new message.",
  citations: ["schroeder2006", "gao2024"],
  fidelity: "simplified",
  verification: { notVerifiable: "BLIS replays traces and generates open-loop streams; it has no counterpart to the closed-loop sessions (users who wait, think and return) that the site generates, so the scenarios feed both simulators a trace instead." }
};

export const WORKLOAD: Concept = {
  module: "workload",
  title: "Workload",
  question: "Who sends requests, how long are they, and what happens between turns?",
  approaches: [closedLoopSessions, traceReplay]
};

const uniform = (w: World, [lo, hi]: readonly [number, number]): number => lo + rand(w) * (hi - lo);

/** Schedule `n` new sessions, each sending one request, spread over `over` simulated seconds. */
export function spawnBurst(w: World, n: number, over = 0): void {
  for (let i = 0; i < n; i++) w.pending.push(w.t + (n > 1 ? (over * i) / (n - 1) : 0) + rand(w) * BURST_ARRIVAL_JITTER_S);
  w.pending.sort((a, b) => a - b);
}

/** Sessions that will still send a turn: scheduled, waiting on an answer, or thinking about the next one. */
export function liveSessions(w: World): number {
  let n = w.pending.length;
  for (const s of w.sessions.values()) if (s.state !== "idle" && !s.closing) n++;
  return n;
}

/**
 * Bring the number of live sessions to `n`. Below it, new sessions start; above it, the newest
 * scheduled ones are dropped, then sessions thinking about a follow-up go idle, then sessions
 * waiting on an answer finish their current turn and send no further one.
 */
export function setSessions(w: World, n: number): void {
  let extra = liveSessions(w) - n;
  if (extra < 0) return spawnBurst(w, -extra);
  const drop = Math.min(extra, w.pending.length);
  w.pending.splice(w.pending.length - drop, drop);
  extra -= drop;
  const newestFirst = [...w.sessions.values()].reverse();
  for (const s of newestFirst) {
    if (extra <= 0) return;
    if (s.state === "thinking" && !s.closing) {
      s.state = "idle";
      extra--;
    }
  }
  for (const s of newestFirst) {
    if (extra <= 0) return;
    if (s.state === "active" && !s.closing) {
      s.closing = true;
      extra--;
    }
  }
}

/** Lengths fixed by a trace instead of drawn: new prompt tokens and output tokens. */
export interface FixedLengths {
  newTokens: number;
  outputTokens: number;
}

export function newSession(w: World, fixed?: FixedLengths, traceId?: number): void {
  const id = w.nextId++;
  const prefixGroup = w.params.sharedPrefixTokens > 0 ? (id - 1) % Math.max(1, w.params.sharedPrefixGroups) : undefined;
  const s: Session = {
    id,
    ...(traceId === undefined ? {} : { traceId }),
    ...(prefixGroup === undefined ? {} : { prefixGroup }),
    hue: (id * HUE_STEP_DEGREES) % 360,
    turn: 0,
    ctxTokens: 0,
    reqId: null,
    state: "active",
    nextTurnAt: 0,
    born: w.t,
    lastPod: -1,
    lastTtft: 0,
    lastTpot: 0
  };
  w.sessions.set(id, s);
  emit(w, "session.new", { sid: id });
  newRequest(w, s, fixed);
  if (w.sessions.size > MAX_SESSIONS) {
    for (const old of w.sessions.values()) {
      if (old.state === "idle") {
        w.sessions.delete(old.id);
        if (w.sessions.size <= MAX_SESSIONS - SESSION_PRUNE_BATCH) break;
      }
    }
  }
}

/** The session's next turn: its whole history plus a new message. */
export function newRequest(w: World, s: Session, fixed?: FixedLengths): void {
  const p = w.params;
  w.startedAt ??= w.t;
  let fresh = fixed ? fixed.newTokens : s.turn === 0 ? Math.round(p.promptTokens * uniform(w, LENGTH_JITTER.firstPrompt)) : Math.max(1, Math.round(p.followTokens * uniform(w, LENGTH_JITTER.followUp)));
  if (!fixed && s.turn === 0 && s.prefixGroup !== undefined && p.sharedPrefixTokens > 0) {
    fresh = Math.max(fresh, p.sharedPrefixTokens + 64);
  }
  const r: Req = {
    id: w.nextId++,
    sid: s.id,
    lIn: Math.max(1, s.ctxTokens + fresh),
    newTokens: fresh,
    lOut: fixed ? fixed.outputTokens : Math.max(MIN_OUTPUT_TOKENS, Math.round(p.outputTokens * uniform(w, LENGTH_JITTER.output))),
    stage: "send",
    stageStart: w.t,
    stageEnd: w.t + FRONTEND_HOPS.send,
    podId: -1,
    prefillDone: 0,
    prefillTarget: 0,
    cached: 0,
    out: 0,
    tCreate: w.t,
    tFirst: 0,
    admitT: 0,
    preemptions: 0,
    promptIdx: Math.floor(rand(w) * SAMPLE_PROMPTS),
    kvReady: 0,
    counted: false,
    fromPod: -1
  };
  w.reqs.set(r.id, r);
  s.reqId = r.id;
  s.state = "active";
  emit(w, "req.new", { sid: s.id, reqId: r.id, lIn: r.lIn, turn: s.turn });
  if (s.turn > 0) emit(w, "req.followup", { sid: s.id, reqId: r.id, turn: s.turn + 1, history: s.ctxTokens, fresh });
}

/** Seconds until a session that will return sends its next turn. */
export function thinkSeconds(w: World): number {
  return w.params.thinkTimeS * (THINK_TIME_JITTER.min + THINK_TIME_JITTER.span * rand(w));
}

/**
 * Send the trace requests that are due. A round 0 opens a session; a later round continues the
 * session of the same trace number. A round sent while the session's previous answer is still being
 * produced is built on an incomplete history; it is flagged with a `trace.overlap` event.
 */
export function injectTrace(w: World): void {
  for (const t of dueTraceRequests(w)) {
    const fixed = { newTokens: t.newTokens, outputTokens: t.outputTokens };
    if (t.round === 0) {
      newSession(w, fixed, t.session);
      continue;
    }
    let found: Session | undefined;
    for (const s of w.sessions.values()) if (s.traceId === t.session) found = s;
    if (!found) throw new Error(`trace session ${t.session} round ${t.round}: the session is unknown (pruned, or round 0 was never sent)`);
    if (found.reqId !== null) emit(w, "trace.overlap", { sid: found.id, session: t.session, round: t.round });
    newRequest(w, found, fixed);
  }
}
