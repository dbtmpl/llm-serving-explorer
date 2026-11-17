/**
 * The fitted timing parameters of the TypeScript model, per reference and per (model, GPU,
 * tensor-parallel degree), as committed in `fitted.json` by `pnpm conformance:calibrate`. A fit is to
 * a named reference: the same model on the same GPU fitted to BLIS and to measured data gives two sets.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONFORMANCE_DIR } from "../scenario.js";

export const FITTED_FILE = path.join(CONFORMANCE_DIR, "calibration", "fitted.json");

/** The parameters of `src/sim/core/params.ts` that the fit sets. */
export interface TimingParams {
  mbu: number;
  mfu: number;
  hostMsBase: number;
  hostMsPerSeq: number;
  /** Tensor-parallel all-reduce link efficiency and fixed time: fitted only for a (model, GPU) with more than one tensor-parallel degree in its calibration data. */
  commEff?: number;
  commLatencyUs?: number;
}

/** One point of a loss profile: the best loss reachable with one parameter held at `value` and the others refitted. */
export interface ProfilePoint {
  value: number;
  loss: number;
}

/**
 * How well the calibration data pins a shared parameter down. A parameter whose loss barely moves while it is held at
 * values across its whole range is a label for something else, not a measurement of the quantity it names.
 */
export interface Identifiability {
  parameter: keyof TimingParams;
  /** The fitted value and its loss, then the losses with the parameter held at fixed values. */
  fitted: ProfilePoint;
  held: ProfilePoint[];
  /** (largest − smallest loss over `held` and `fitted`) / smallest: below `FLAT_BELOW` the data does not identify the parameter. */
  spread: number;
  flat: boolean;
}

/** The spread of a loss profile under which a parameter is called unidentified. */
export const FLAT_BELOW = 0.25;

/** Residuals of one calibration scenario: the TypeScript value against BLIS's, signed (TypeScript - BLIS) / BLIS. */
export interface ScenarioResidual {
  scenario: string;
  ttftMean: number;
  tpotMean: number;
}

export interface FittedPair {
  model: string;
  gpu: string;
  tp: number;
  timing: TimingParams;
  /**
   * The pair's group: the (model, GPU) whose tensor-parallel degrees were fitted together with shared values, since
   * the roofline's rates do not depend on the degree and a fit to one degree cannot tell MBU from a constant. Equal to
   * `model/gpu` for every pair; a group of one degree is fitted alone.
   */
  group: string;
  /** The degrees fitted together in the group. */
  groupTps: number[];
  /** Parameters that ended on a bound of their range (a fit at a bound is a sign that the structure, not the value, is off). */
  atBound: string[];
  /** Loss profile of MBU and MFU over the group's calibration data. */
  identifiability: Identifiability[];
  /** Where the fit started from: the site's defaults. Reported, never changed by the fit. */
  defaults: TimingParams;
  /** Loss at the defaults and at the fitted values (mean squared log ratio over the scenarios' TTFT and TPOT). */
  lossAtDefaults: number;
  lossAtFit: number;
  /** Residuals at the fitted values. */
  residuals: ScenarioResidual[];
  /** Residuals at the site's defaults, for comparison. */
  residualsAtDefaults: ScenarioResidual[];
  /** Draft cost relative to a target run (`specCost`), fitted on this pair's speculative scenario; absent when none exists. */
  specCost?: { value: number; defaultValue: number; scenario: string; residualTpot: number };
  /** Link rate between pods (`linkGbps`), fitted on this pair's prefill/decode scenario; absent when none exists. */
  linkGbps?: { value: number; defaultValue: number; scenario: string; residualKvTransfer: number };
}

/** Everything fitted to one reference. */
export interface FittedReference {
  /** What the reference pinned when the fit was made (its lock). */
  lock: string;
  pairs: Record<string, FittedPair>;
}

export interface FittedFile {
  /** What the fit minimises and how it searches; kept beside the numbers it produced. */
  method: string;
  references: Record<string, FittedReference>;
}

export const pairKey = (model: string, gpu: string, tp: number): string => `${model}/${gpu}/tp${tp}`;

export function loadFitted(): FittedFile {
  return JSON.parse(readFileSync(FITTED_FILE, "utf8")) as FittedFile;
}

/** The fit of a pair to a reference, or an error saying what is missing: a calibrated check without a fit is a mistake, not a default. */
export function fittedFor(file: FittedFile, reference: string, model: string, gpu: string, tp: number): FittedPair {
  const f = file.references[reference]?.pairs[pairKey(model, gpu, tp)];
  if (!f) throw new Error(`no calibration to ${reference} for ${pairKey(model, gpu, tp)}: add calibration scenarios for it and run pnpm conformance:calibrate`);
  return f;
}
