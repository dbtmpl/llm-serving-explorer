/**
 * Trace replay: requests injected from a list instead of generated.
 *
 * Source: Schroeder et al., NSDI 2006, on open versus closed workload models. A generator that
 * draws sessions at random is a model of a workload; a trace is a record of one. Injecting each
 * request at its recorded time (open loop: the time does not depend on when earlier answers
 * finished) lets a run be repeated exactly, and lets a different simulator be given the very same
 * input. The conformance tests (`conformance/`) rely on that to compare this model with BLIS.
 *
 * A trace is a list of requests. Each names a session, a round within it, the time it is sent, the
 * tokens the user adds in this round, and the tokens the model will answer with:
 *
 *     prompt(round r) = prompt(round r-1) + output(round r-1) + newTokens(r)
 *
 * so a follow-up carries the whole conversation, exactly as in the closed-loop generator. This is
 * also the "accumulate" encoding of BLIS's trace format, where a follow-up row stores only the
 * tokens it adds.
 *
 * Example: round 0 adds 1,000 tokens and is answered with 50; round 1 adds 100. Round 1's prompt
 * is 1,000 + 50 + 100 = 1,150 tokens, of which the engine can serve floor(1,050 / 16) · 16 = 1,040
 * from the prefix cache if it still holds the first round.
 *
 * Simplifications: requests are open loop, so a follow-up sent before the previous answer has
 * finished is built on a history that is not yet complete; the loader flags that (`trace.overlap`
 * event) instead of guessing. There are no think times, deadlines or per-request priorities.
 */
import type { ApproachMeta } from "../approach.js";
import type { World } from "../core/types.js";

/** One request of a trace. */
export interface TraceRequest {
  /** Simulated seconds at which the user sends it. */
  at: number;
  /** Conversation it belongs to. Round 0 starts it; later rounds must follow in order. */
  session: number;
  /** 0 for the first prompt of a session, then 1, 2, ... */
  round: number;
  /** Tokens added in this round: the whole prompt for round 0, the new message after that. */
  newTokens: number;
  /** Tokens the model answers with. */
  outputTokens: number;
}

export const traceReplay: ApproachMeta = {
  id: "trace-replay",
  name: "Trace replay",
  summary: "Requests are injected at recorded times with recorded lengths, so a run can be repeated or compared exactly.",
  citations: ["schroeder2006", "gao2024"],
  fidelity: "simplified",
  verification: { notVerifiable: "It is how both simulators are given the same requests, not a mechanism BLIS models: every scenario uses it, and the conformance machinery fails when the two row sets differ, but there is nothing in BLIS to compare it with." }
};

/** Reject a malformed trace with a message naming the request, rather than simulating nonsense. */
export function validateTrace(requests: readonly TraceRequest[], minOutputTokens: number): void {
  const next = new Map<number, number>();
  const sorted = requests.map((r, i) => ({ r, i })).sort((a, b) => a.r.at - b.r.at || a.i - b.i);
  for (const { r, i } of sorted) {
    const where = `trace request ${i} (session ${r.session}, round ${r.round})`;
    if (!(r.at >= 0) || !Number.isFinite(r.at)) throw new Error(`${where}: time must be a finite number of seconds >= 0`);
    if (!Number.isInteger(r.newTokens) || r.newTokens < 1) throw new Error(`${where}: newTokens must be a whole number >= 1`);
    if (!Number.isInteger(r.outputTokens) || r.outputTokens < minOutputTokens) throw new Error(`${where}: outputTokens must be a whole number >= ${minOutputTokens}`);
    const expected = next.get(r.session) ?? 0;
    if (r.round !== expected) throw new Error(`${where}: expected round ${expected}; rounds of a session must be consecutive and in time order`);
    next.set(r.session, expected + 1);
  }
}

/** Queue a trace for injection. Requests are released in time order; ties keep the order given. */
export function loadTrace(w: World, requests: readonly TraceRequest[], minOutputTokens: number): void {
  validateTrace(requests, minOutputTokens);
  const queued = requests.map((r, i) => ({ r, i })).sort((a, b) => a.r.at - b.r.at || a.i - b.i);
  w.trace.push(...queued.map((q) => q.r));
  w.trace.sort((a, b) => a.at - b.at);
}

/** The trace requests that are due at the world's current time, removed from the queue. */
export function dueTraceRequests(w: World): TraceRequest[] {
  const due: TraceRequest[] = [];
  while (w.trace.length && w.trace[0]!.at <= w.t) due.push(w.trace.shift()!);
  return due;
}
