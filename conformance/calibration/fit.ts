/**
 * Fit the TypeScript model's free timing parameters to a reference.
 *
 * What is fitted, per (model, GPU, tensor-parallel degree):
 *
 * - `mbu`, `mfu`, `hostMsBase`, `hostMsPerSeq` (`src/sim/core/params.ts`): the two achieved-rate
 *   fractions of the roofline and the two host-time coefficients. They are fitted together to the
 *   calibration scenarios that use no speculation and no prefill/decode split.
 * - `specCost`: the draft cost relative to a target run, on the pair's speculative calibration
 *   scenario, with the four parameters above held at their fitted values.
 * - `linkGbps`: the link rate between prefill and decode pods, on the pair's prefill/decode
 *   calibration scenario, with the four parameters held.
 *
 * The loss. For each calibration scenario s, with the reference's value b and the TypeScript model's t:
 *
 *     L_s = ( mean over requests r of ln(t_ttft,r / b_ttft,r)^2  +  ln(t_tpot / b_tpot)^2 ) / 2
 *     L   = mean over scenarios of L_s
 *
 * where `ttft` is the per-request time from arrival to first token (matched by session and round)
 * and `tpot` the scenario's mean time per output token (`metricOf`). Squared log ratios treat a
 * factor of two high and a factor of two low alike, and give time to first token and time per token
 * equal weight, so the compute-bound prefill and the memory-bound decode both constrain the fit.
 *
 * The search is a coordinate search in log space, deterministic, with no random numbers: for each
 * step ratio in 2, 1.5, 1.25, 1.1, 1.05, 1.02 (largest first), repeat over the parameters in the
 * order mbu, mfu, hostMsBase, hostMsPerSeq: try the current value times ratio^j for j = -3..3
 * (clipped to the parameter's bounds), keep the best, until a whole sweep improves the loss by less
 * than one part in a million. It starts at the site's default values and never changes them.
 *
 * Bounds: mbu, mfu in [0.05, 1]; hostMsBase in [0.01, 50]; hostMsPerSeq in [0.001, 5].
 */
import { DEFAULT_PARAMS } from "../../src/sim/index.js";
import { metricOf, type Reduced } from "../record.js";
import { runTypescript } from "../run/typescript.js";
import { MAIN_ARM, type Scenario } from "../scenario.js";
import type { TimingParams, ScenarioResidual } from "./fitted.js";

export const METHOD =
  "Coordinate search in log space from the site's defaults. Loss: mean over calibration scenarios of (mean over requests of ln(ttft_ts/ttft_ref)^2 + ln(tpot_ts/tpot_ref)^2) / 2. " +
  "Step ratios 2, 1.5, 1.25, 1.1, 1.05, 1.02; at each ratio, per parameter in the order mbu, mfu, hostMsBase, hostMsPerSeq, try value * ratio^j for j = -3..3 within bounds, keep the best, repeat until a sweep gains less than 1e-6. " +
  "Bounds: mbu, mfu in [0.05, 1]; hostMsBase in [0.01, 50]; hostMsPerSeq in [0.001, 5]. specCost and linkGbps are then fitted alone by the same search (bounds [0, 1] and [1, 2000]), with the four parameters held.";

export const DEFAULT_TIMING: TimingParams = { mbu: DEFAULT_PARAMS.mbu, mfu: DEFAULT_PARAMS.mfu, hostMsBase: DEFAULT_PARAMS.hostMsBase, hostMsPerSeq: DEFAULT_PARAMS.hostMsPerSeq };

const BOUNDS: Record<keyof TimingParams, [number, number]> = { mbu: [0.05, 1], mfu: [0.05, 1], hostMsBase: [0.01, 50], hostMsPerSeq: [0.001, 5] };
const ORDER: (keyof TimingParams)[] = ["mbu", "mfu", "hostMsBase", "hostMsPerSeq"];
const RATIOS = [2, 1.5, 1.25, 1.1, 1.05, 1.02];
const MIN_GAIN = 1e-6;

export interface Calibration {
  scenario: Scenario;
  /** What the model is fitted to: the reference's record of the scenario. */
  reference: Reduced;
}

const key = (r: { session: number; round: number }) => `${r.session}/${r.round}`;

/** Per-request time to first token, by request. */
function ttfts(r: Reduced): Map<string, number> {
  return new Map(r.requests.filter((x) => x.fate === "completed" && x.firstTokenS !== null).map((x) => [key(x), x.firstTokenS! - x.arrivalS]));
}

export interface ScenarioScore {
  scenario: string;
  /** mean over requests of ln(ttft ratio)^2 and ln(tpot ratio)^2. */
  ttftLogSq: number;
  tpotLogSq: number;
  /** Signed relative errors of the means (TypeScript - reference) / reference: the quantities a held-out check compares. */
  ttftMeanError: number;
  tpotMeanError: number;
}

export function score(c: Calibration, ts: Reduced): ScenarioScore {
  const a = ttfts(ts);
  const b = ttfts(c.reference);
  let sum = 0;
  for (const [k, y] of b) {
    const x = a.get(k);
    if (x === undefined) throw new Error(`${c.scenario.id}: the TypeScript run has no first token for request ${k}`);
    sum += Math.log(x / y) ** 2;
  }
  const tTpot = metricOf(ts, "tpot_mean_s")!;
  const bTpot = metricOf(c.reference, "tpot_mean_s")!;
  return {
    scenario: c.scenario.id,
    ttftLogSq: sum / b.size,
    tpotLogSq: Math.log(tTpot / bTpot) ** 2,
    ttftMeanError: metricOf(ts, "ttft_mean_s")! / metricOf(c.reference, "ttft_mean_s")! - 1,
    tpotMeanError: tTpot / bTpot - 1
  };
}

export function scoresAt(cs: Calibration[], timing: TimingParams): ScenarioScore[] {
  return cs.map((c) => score(c, runTypescript(c.scenario, MAIN_ARM, timing).reduced));
}

export const lossOf = (scores: ScenarioScore[]): number => scores.reduce((a, s) => a + (s.ttftLogSq + s.tpotLogSq) / 2, 0) / scores.length;

export function residualsOf(scores: ScenarioScore[]): ScenarioResidual[] {
  return scores.map((s) => ({ scenario: s.scenario, ttftMean: s.ttftMeanError, tpotMean: s.tpotMeanError }));
}

const clip = (x: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, x));

/** Generic one-or-more-parameter coordinate search; `loss` is evaluated at most a few hundred times. */
export function coordinateSearch<K extends string>(start: Record<K, number>, order: K[], bounds: Record<K, [number, number]>, loss: (x: Record<K, number>) => number): { x: Record<K, number>; loss: number } {
  let x = { ...start };
  let best = loss(x);
  for (const ratio of RATIOS) {
    for (;;) {
      const before = best;
      for (const k of order) {
        let bestV = x[k];
        for (let j = -3; j <= 3; j++) {
          if (j === 0) continue;
          const v = clip(x[k] * ratio ** j, bounds[k]);
          if (v === x[k]) continue;
          const l = loss({ ...x, [k]: v });
          if (l < best) {
            best = l;
            bestV = v;
          }
        }
        x = { ...x, [k]: bestV };
      }
      if (before - best < MIN_GAIN) break;
    }
  }
  return { x, loss: best };
}

export function fitTiming(cs: Calibration[]): { timing: TimingParams; loss: number; lossAtDefaults: number; scores: ScenarioScore[]; scoresAtDefaults: ScenarioScore[] } {
  const scoresAtDefaults = scoresAt(cs, DEFAULT_TIMING);
  const { x, loss } = coordinateSearch(DEFAULT_TIMING, ORDER, BOUNDS, (t) => lossOf(scoresAt(cs, t)));
  return { timing: x, loss, lossAtDefaults: lossOf(scoresAtDefaults), scores: scoresAt(cs, x), scoresAtDefaults };
}

export function fitSpecCost(c: Calibration, timing: TimingParams): { value: number; residualTpot: number } {
  const run = (specCost: number) => runTypescript(c.scenario, MAIN_ARM, { ...timing, specCost }).reduced;
  const loss = (x: { specCost: number }) => Math.log(metricOf(run(x.specCost), "tpot_mean_s")! / metricOf(c.reference, "tpot_mean_s")!) ** 2;
  // a zero draft cost is a legitimate answer (BLIS, for one, does not price its n-gram drafter), so the search starts away from it and may end at the bound
  const { x } = coordinateSearch({ specCost: DEFAULT_PARAMS.specCost }, ["specCost"], { specCost: [1e-4, 1] }, loss);
  return { value: x.specCost, residualTpot: metricOf(run(x.specCost), "tpot_mean_s")! / metricOf(c.reference, "tpot_mean_s")! - 1 };
}

export function fitLink(c: Calibration, timing: TimingParams): { value: number; residualKvTransfer: number } {
  const run = (linkGbps: number) => runTypescript(c.scenario, MAIN_ARM, { ...timing, linkGbps }).reduced;
  const loss = (x: { linkGbps: number }) => Math.log(metricOf(run(x.linkGbps), "kv_transfer_mean_s")! / metricOf(c.reference, "kv_transfer_mean_s")!) ** 2;
  const { x } = coordinateSearch({ linkGbps: DEFAULT_PARAMS.linkGbps }, ["linkGbps"], { linkGbps: [1, 2000] }, loss);
  return { value: x.linkGbps, residualKvTransfer: metricOf(run(x.linkGbps), "kv_transfer_mean_s")! / metricOf(c.reference, "kv_transfer_mean_s")! - 1 };
}

