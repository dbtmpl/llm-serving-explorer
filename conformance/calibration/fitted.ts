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
}

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
