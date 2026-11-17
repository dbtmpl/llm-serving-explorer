/**
 * Fit the TypeScript model's free timing parameters to a reference.
 *
 * What is fitted, per (model, GPU) and all its tensor-parallel degrees together:
 *
 * - `mbu`, `mfu`, `hostMsBase`, `hostMsPerSeq` (`src/sim/core/params.ts`): the two achieved-rate
 *   fractions of the roofline and the two host-time coefficients, one set for every tensor-parallel degree of the
 *   group (the rates of a GPU do not depend on how many others share the model). Fitted to the calibration
 *   scenarios that use no speculation and no prefill/decode split.
 * - `commEff`, `commLatencyUs`: the efficiency and fixed time of the tensor-parallel all-reduce, only for a group with
 *   more than one degree (with one degree the all-reduce is a constant that MBU would absorb).
 * - `specCost`: the draft cost relative to a target run, on the pair's speculative calibration
 *   scenario, with the parameters above held at their fitted values.
 * - `linkGbps`: the link rate between prefill and decode pods, on the pair's prefill/decode
 *   calibration scenario, with the parameters above held.
 * The launch times per layer (`launchUs`, `launchEagerUs`) are not fitted: they keep the site's values.
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
 * order mbu, mfu, hostMsBase, hostMsPerSeq, commEff, commLatencyUs: try the current value times ratio^j for
 * j = -3..3 (clipped to the parameter's bounds), keep the best, until a whole sweep improves the loss by
 * less than one part in a million. It starts at the site's default values and never changes them.
 *
 * Bounds, set on 2026-11-16 before the refit and from evidence that does not depend on it: mbu in [0.4, 0.95]
 * (the stream of two measured vLLM runs reached 0.83 and 0.85 of the datasheet bandwidth with every overhead
 * included, so more than 0.95 is not physical; BLIS's calibrated cost reaches 0.52 to 0.55 on its worst pair,
 * so less than 0.4 would be a constant in disguise); mfu in [0.2, 0.9] (measured prefill on the RTX PRO 6000 reached
 * 0.62 of the datasheet peak; large GEMMs do not reach the peak); commEff in [0.05, 1]; commLatencyUs in [0.5, 50];
 * hostMsBase in [0.01, 50]; hostMsPerSeq in [0.001, 5].
 *
 * Identifiability. For each group the fit also reports the loss profile of mbu and mfu: the loss when the parameter
 * is held at each of three values across its range and the others are refitted. A profile that stays within
 * `FLAT_BELOW` of the best loss says the data does not tell that parameter from the others; its fitted value is a
 * label, not a measurement. A fitted value on a bound is reported too.
 */
import { DEFAULT_PARAMS } from "../../src/sim/index.js";
import { metricOf, restrict, type Reduced } from "../record.js";
import { runTypescript } from "../run/typescript.js";
import { MAIN_ARM, type Scenario } from "../scenario.js";
import { FLAT_BELOW, type Identifiability, type TimingParams, type ScenarioResidual } from "./fitted.js";

export const METHOD =
  "Coordinate search in log space from the site's defaults, one parameter set per (model, GPU) shared by all its tensor-parallel degrees. Loss: mean over calibration scenarios of (mean over requests of ln(ttft_ts/ttft_ref)^2 + ln(tpot_ts/tpot_ref)^2) / 2. " +
  "Step ratios 2, 1.5, 1.25, 1.1, 1.05, 1.02; at each ratio, per parameter in the order mbu, mfu, hostMsBase, hostMsPerSeq, commEff, commLatencyUs, try value * ratio^j for j = -3..3 within bounds, keep the best, repeat until a sweep gains less than 1e-6. " +
  "Bounds (decided 2026-11-16 from the measured vLLM runs and BLIS's range, before the refit): mbu [0.4, 0.95]; mfu [0.2, 0.9]; commEff [0.05, 1]; commLatencyUs [0.5, 50]; hostMsBase [0.01, 50]; hostMsPerSeq [0.001, 5]. " +
  "commEff and commLatencyUs are fitted only for a group with several tensor-parallel degrees. specCost and linkGbps are then fitted alone by the same search (bounds [0, 1] and [1, 2000]), with the timing parameters held. " +
  "Each group also reports the loss profile of mbu and mfu (the loss with the parameter held at three values and the others refitted); a profile within 25 percent of the best loss marks a parameter the data does not identify (the profile's refits use step ratios 2, 1.25, 1.05 only).";

const BASE: (keyof TimingParams)[] = ["mbu", "mfu", "hostMsBase", "hostMsPerSeq"];
const COMM: (keyof TimingParams)[] = ["commEff", "commLatencyUs"];

export const DEFAULT_TIMING: TimingParams = { mbu: DEFAULT_PARAMS.mbu, mfu: DEFAULT_PARAMS.mfu, hostMsBase: DEFAULT_PARAMS.hostMsBase, hostMsPerSeq: DEFAULT_PARAMS.hostMsPerSeq };
const DEFAULT_COMM = { commEff: DEFAULT_PARAMS.commEff, commLatencyUs: DEFAULT_PARAMS.commLatencyUs };

const BOUNDS: Record<keyof TimingParams, [number, number]> = {
  mbu: [0.4, 0.95],
  mfu: [0.2, 0.9],
  hostMsBase: [0.01, 50],
  hostMsPerSeq: [0.001, 5],
  commEff: [0.05, 1],
  commLatencyUs: [0.5, 50]
};
/** Values at which the loss profile of each parameter is taken. */
const PROFILE_AT: Partial<Record<keyof TimingParams, number[]>> = { mbu: [0.5, 0.7, 0.9], mfu: [0.3, 0.5, 0.8] };
const RATIOS = [2, 1.5, 1.25, 1.1, 1.05, 1.02];
/** The profile's refits use a coarser search: they ask how much the loss rises, not where the minimum is to three digits. */
const PROFILE_RATIOS = [2, 1.25, 1.05];
const MIN_GAIN = 1e-6;

export interface Calibration {
  scenario: Scenario;
  /** What the model is fitted to: the reference's record of the scenario. */
  reference: Reduced;
  /** The requests the fit uses (`requestKey`s); null for all of them. Measured references are fitted to a subset and checked on the rest. */
  subset?: Set<string> | null;
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

export function score(c: Calibration, full: Reduced): ScenarioScore {
  const ts = restrict(full, c.subset ?? null);
  const reference = restrict(c.reference, c.subset ?? null);
  const a = ttfts(ts);
  const b = ttfts(reference);
  let sum = 0;
  for (const [k, y] of b) {
    const x = a.get(k);
    if (x === undefined) throw new Error(`${c.scenario.id}: the TypeScript run has no first token for request ${k}`);
    sum += Math.log(x / y) ** 2;
  }
  const tTpot = metricOf(ts, "tpot_mean_s")!;
  const bTpot = metricOf(reference, "tpot_mean_s")!;
  return {
    scenario: c.scenario.id,
    ttftLogSq: sum / b.size,
    tpotLogSq: Math.log(tTpot / bTpot) ** 2,
    ttftMeanError: metricOf(ts, "ttft_mean_s")! / metricOf(reference, "ttft_mean_s")! - 1,
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
export function coordinateSearch<K extends string>(start: Record<K, number>, order: K[], bounds: Record<K, [number, number]>, loss: (x: Record<K, number>) => number, ratios: number[] = RATIOS): { x: Record<K, number>; loss: number } {
  let x = { ...start };
  let best = loss(x);
  for (const ratio of ratios) {
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

export interface TimingFit {
  timing: TimingParams;
  loss: number;
  lossAtDefaults: number;
  scores: ScenarioScore[];
  scoresAtDefaults: ScenarioScore[];
  atBound: string[];
  identifiability: Identifiability[];
}

/** Fit `order` from `start` with `held` parameters fixed at their values, over the calibration scenarios. */
function search(cs: Calibration[], start: TimingParams, order: (keyof TimingParams)[], held: Partial<TimingParams> = {}, ratios: number[] = RATIOS) {
  const free = order.filter((k) => !(k in held));
  return coordinateSearch({ ...start, ...held } as Record<keyof TimingParams, number>, free, BOUNDS, (t) => lossOf(scoresAt(cs, t)), ratios);
}

export function fitTiming(cs: Calibration[], withComm = false): TimingFit {
  const order = withComm ? [...BASE, ...COMM] : BASE;
  const start: TimingParams = withComm ? { ...DEFAULT_TIMING, ...DEFAULT_COMM } : DEFAULT_TIMING;
  const scoresAtDefaults = scoresAt(cs, start);
  const { x, loss } = search(cs, start, order);
  const timing = Object.fromEntries(order.map((k) => [k, x[k]])) as unknown as TimingParams;
  const atBound = order.filter((k) => Math.abs(Math.log(x[k] / BOUNDS[k][0])) < 1e-9 || Math.abs(Math.log(x[k] / BOUNDS[k][1])) < 1e-9).map(String);
  const identifiability: Identifiability[] = [];
  for (const parameter of ["mbu", "mfu"] as const) {
    const held = (PROFILE_AT[parameter] ?? []).map((value) => ({ value, loss: search(cs, timing, order, { [parameter]: value }, PROFILE_RATIOS).loss }));
    const all = [loss, ...held.map((h) => h.loss)];
    const spread = (Math.max(...all) - Math.min(...all)) / Math.min(...all);
    identifiability.push({ parameter, fitted: { value: timing[parameter]!, loss }, held, spread, flat: spread < FLAT_BELOW });
  }
  return { timing, loss, lossAtDefaults: lossOf(scoresAtDefaults), scores: scoresAt(cs, timing), scoresAtDefaults, atBound, identifiability };
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

