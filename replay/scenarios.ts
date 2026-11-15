/**
 * The scenarios the site replays. Each is a conformance `Scenario` (the neutral description both
 * simulators are translated from) so that the generator can hand it to the same BLIS translator;
 * the checks list is empty because a replay asserts nothing, it records.
 *
 * Request lists are written by a seeded generator and then frozen into the replay file, so the
 * site never depends on the generator. The sizes are chosen against what each scenario has to show
 * and checked by the generator, which refuses a run that did not show it (see `expects`).
 */
import type { Deployment, Scenario, ScenarioRequest } from "../conformance/scenario.js";
import type { ReplayFate } from "../src/replay/schema.js";

/** mulberry32, the generator the simulation itself uses; any fixed generator would do. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/** A whole number in [lo, hi], rounded to `step`. */
const between = (r: () => number, lo: number, hi: number, step = 1): number => Math.round((lo + (hi - lo) * r()) / step) * step;

/** What a run must show for the scenario to be worth replaying. The generator throws when it does not. */
export interface Expect {
  /** Every request is routed at least once to this many different pods. */
  podsUsed?: number;
  /** At least this many follow-up requests were routed to the pod that served the conversation before. */
  stickyFollowUps?: number;
  /** At least this many requests ended with this fate. */
  fates?: Partial<Record<ReplayFate, number>>;
  /** At least this many requests were held at the router (BLIS reports a gateway queue delay). */
  heldAtRouter?: number;
  /** At least this many preemptions over the run. */
  preemptions?: number;
  /** At least this many requests waited in the engine's queue (scheduling delay over 100 ms). */
  engineQueued?: number;
}

export interface ReplayScenario {
  scenario: Scenario;
  /** Interval of BLIS's per-pod series, seconds. */
  seriesIntervalS: number;
  expect: Expect;
}

const engine = { tp: 1, gpuMemoryUtilisation: 0.9, maxNumSeqs: 12, maxNumBatchedTokens: 8192, prefixCaching: true };

/** A conformance scenario of one deployment and no checks: a replay asserts nothing, it records. */
const scenario = (id: string, title: string, main: Deployment): Scenario => ({ id, title, role: "check", arms: { main }, checks: [] });

function conversations(seed: number, n: { sessions: number; start: number; every: number; gap: number; turns: number; first: [number, number]; follow: [number, number]; out: [number, number]; followOut: [number, number] }): ScenarioRequest[] {
  const r = rng(seed);
  const out: ScenarioRequest[] = [];
  for (let s = 1; s <= n.sessions; s++) {
    const at = n.start + (s - 1) * n.every + between(r, 0, 0.12, 0.01);
    for (let round = 0; round < n.turns; round++) {
      out.push({
        at: Math.round((at + round * n.gap + between(r, -1, 1, 0.05) * (round ? 1 : 0)) * 1000) / 1000,
        session: s,
        round,
        newTokens: round === 0 ? between(r, n.first[0], n.first[1], 10) : between(r, n.follow[0], n.follow[1], 10),
        outputTokens: round === 0 ? between(r, n.out[0], n.out[1], 10) : between(r, n.followOut[0], n.followOut[1], 10)
      });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.session - b.session || a.round - b.round);
}

function singles(seed: number, n: { count: number; start: number; rate: number; prompt: [number, number]; out: [number, number] }): ScenarioRequest[] {
  const r = rng(seed);
  const out: ScenarioRequest[] = [];
  let t = n.start;
  for (let i = 1; i <= n.count; i++) {
    t += -Math.log(1 - r()) / n.rate;
    out.push({ at: Math.round(t * 1000) / 1000, session: i, round: 0, newTokens: between(r, n.prompt[0], n.prompt[1], 10), outputTokens: between(r, n.out[0], n.out[1], 10) });
  }
  return out;
}

export const REPLAY_SCENARIOS: ReplayScenario[] = [
  {
    seriesIntervalS: 1,
    expect: { podsUsed: 4, stickyFollowUps: 20 },
    scenario: scenario("prefix-followups", "Follow-up turns return to their pod", {
      model: "llama-3.1-8b",
      gpu: "h100",
      engine,
      replicas: 4,
      routing: "prefix-aware",
      queueDeadlineS: 0,
      // Eight conversations over four pods. A follow-up comes 11 s after the previous turn, long after
      // its answer finished, so the only thing that distinguishes the pods is who holds the history.
      requests: conversations(11, { sessions: 8, start: 1, every: 0.6, gap: 11, turns: 4, first: [1500, 3200], follow: [80, 260], out: [150, 320], followOut: [60, 160] })
    })
  },
  {
    seriesIntervalS: 0.5,
    expect: { fates: { completed: 10, shed: 5 }, heldAtRouter: 5, engineQueued: 3 },
    scenario: scenario("overload-shedding", "Overload: queueing, then shedding", {
      model: "llama-3.1-8b",
      gpu: "h100",
      engine: { ...engine, maxNumSeqs: 4 },
      replicas: 2,
      routing: "prefix-aware",
      // The router holds a request once a pod has `max_num_seqs` plus its queue slack in flight, and
      // drops it after this many seconds.
      queueDeadlineS: 4,
      requests: singles(23, { count: 70, start: 1, rate: 7, prompt: [600, 1600], out: [160, 320] })
    })
  },
  {
    seriesIntervalS: 0.5,
    expect: { preemptions: 1, fates: { completed: 4 } },
    scenario: scenario("kv-pressure", "KV pressure: preemption", {
      model: "llama-3.1-8b",
      gpu: "h100",
      // 26 % of the GPU's memory leaves a pool of about 31,600 tokens. Each request grows to 9,000
      // tokens (5,000 of prompt, 4,000 generated); three fit, four do not.
      engine: { ...engine, gpuMemoryUtilisation: 0.26, maxModelLen: 12000 },
      replicas: 1,
      routing: "prefix-aware",
      queueDeadlineS: 0,
      requests: [1, 2, 3, 4].map((s) => ({ at: 1 + (s - 1) * 1.5, session: s, round: 0, newTokens: 5000, outputTokens: 4000 }))
    })
  },
  {
    seriesIntervalS: 1,
    expect: { podsUsed: 2, stickyFollowUps: 10 },
    scenario: scenario("steady-chat-70b", "Steady chat, Llama 3.1 70B", {
      model: "llama-70b",
      gpu: "h200",
      engine: { ...engine, tp: 4 },
      replicas: 2,
      routing: "prefix-aware",
      queueDeadlineS: 0,
      // Eight GPUs. A new conversation about every 1.5 s, three turns each with 14 s of thinking between them.
      requests: conversations(5, { sessions: 14, start: 1, every: 1.5, gap: 14, turns: 3, first: [800, 2400], follow: [60, 220], out: [120, 260], followOut: [60, 180] })
    })
  }
];
