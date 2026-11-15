/**
 * The numbers each scenario's description in `src/content/replay.md` quotes, computed from the
 * replay file so that the text cannot disagree with the data it describes.
 */
import { median } from "../sim/index.js";
import { fmtInt } from "../live/format.js";
import type { ReplayId } from "./scenarios.js";
import type { ReplayFile } from "./schema.js";

const done = (f: ReplayFile) => f.requests.filter((r) => r.fate === "completed");
const ms = (seconds: number) => String(Math.round(seconds * 1000));

/** Requests of a later round that went back to the pod that served the previous round of their session. */
export function followUps(f: ReplayFile): { back: number; total: number } {
  const last = new Map<number, number | null>();
  let back = 0;
  let total = 0;
  for (const r of f.requests) {
    if (r.round > 0) {
      total++;
      if (r.pod !== null && last.get(r.session) === r.pod) back++;
    }
    last.set(r.session, r.pod);
  }
  return { back, total };
}

export function scenarioFacts(id: ReplayId, f: ReplayFile): Record<string, string | number> {
  const ttft = median(done(f).map((r) => r.firstToken! - r.arrival));
  switch (id) {
    case "prefix-followups": {
      const { back, total } = followUps(f);
      return { back, followups: total, hit: (f.totals.cacheHitRate * 100).toFixed(0) };
    }
    case "steady-chat-70b":
      return { ttft: ms(ttft), tpot: ms(median(done(f).filter((r) => r.outputTokens > 1).map((r) => (r.lastToken! - r.firstToken!) / (r.outputTokens - 1)))) };
    case "overload-shedding":
      return { slots: f.params.maxNumSeqs, deadline: f.params.queueDeadlineS, held: f.requests.filter((r) => r.fate === "shed" || (r.dispatch !== null && r.dispatch - r.arrival > 1e-6)).length, shed: f.totals.shed, total: f.requests.length, ttft: ms(ttft) };
    case "kv-pressure": {
      const first = f.requests[0]!;
      return { pool: fmtInt(f.params.kvBlocksPerReplica * f.params.blockTokens), each: fmtInt(first.inputTokens + first.outputTokens), preemptions: f.totals.preemptions, bin: f.series.intervalS };
    }
  }
}
