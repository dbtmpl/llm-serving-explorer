/**
 * Fit every (model, GPU, tp) pair that has calibration scenarios, per reference, from the committed
 * reference records. Needs neither Go nor BLIS. Used by `pnpm conformance:calibrate` (writes
 * `fitted.json`) and by the test that checks the committed file is what this produces.
 */
import type { Reference } from "../refs/reference.js";
import { REFERENCES, loadReferenceFile, referencesOf } from "../refs/index.js";
import { loadScenario, mainArm, scenarioIds, subsetKeys } from "../scenario.js";
import { DEFAULT_TIMING, METHOD, fitLink, fitSpecCost, fitTiming, residualsOf, type Calibration, type ScenarioScore, type TimingFit } from "./fit.js";
import { pairKey, type TimingParams, type FittedFile, type FittedPair, type FittedReference } from "./fitted.js";

interface PairSet {
  model: string;
  gpu: string;
  tp: number;
  timing: Calibration[];
  spec: Calibration[];
  pd: Calibration[];
}

/** The calibration scenarios a reference answers, grouped by (model, GPU, tp). */
export function calibrationSet(reference: Reference<any, any>): Map<string, PairSet> {
  const pairs = new Map<string, PairSet>();
  for (const id of scenarioIds()) {
    const scenario = loadScenario(id);
    // calibration scenarios, and scenarios that fit to the first part of a measured run and check on the rest
    if (scenario.role !== "calibration" && !scenario.split) continue;
    if (!referencesOf(scenario).some((r) => r.id === reference.id)) continue;
    // a split scenario is fitted to the one reference it names (`fit_reference`); another reference that also covers it is only compared with
    if (scenario.split && scenario.fitReference && scenario.fitReference !== reference.id) continue;
    const d = mainArm(scenario);
    const file = loadReferenceFile(reference.id, id);
    if (!file) throw new Error(`${id}: no ${reference.id} reference; run pnpm conformance:reference --ref ${reference.id}`);
    const c: Calibration = { scenario, reference: file.records.main!, subset: scenario.split ? subsetKeys(scenario, "calibration") : null };
    const k = pairKey(d.model, d.gpu, d.engine.tp);
    const p = pairs.get(k) ?? { model: d.model, gpu: d.gpu, tp: d.engine.tp, timing: [], spec: [], pd: [] };
    (d.speculative ? p.spec : d.disagg ? p.pd : p.timing).push(c);
    pairs.set(k, p);
  }
  return pairs;
}

const sig = (x: number): number => Number(x.toPrecision(6));
const sigAll = (o: TimingParams): TimingParams => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, sig(v as number)])) as unknown as TimingParams;

/** The group of a pair: (model, GPU), all tensor-parallel degrees. */
const groupOf = (p: PairSet): string => `${p.model}/${p.gpu}`;

/** One group's joint fit, made once however many of its pairs are asked for (a fit is the slow part). */
const groupFits = new Map<string, TimingFit>();

function fitGroup(reference: Reference<any, any>, group: string): { fit: TimingFit; tps: number[]; pairs: PairSet[] } {
  const pairs = [...calibrationSet(reference).values()].filter((p) => groupOf(p) === group && p.timing.length);
  const tps = pairs.map((p) => p.tp).sort((a, b) => a - b);
  const id = `${reference.id}/${group}`;
  let fit = groupFits.get(id);
  if (!fit) {
    fit = fitTiming(pairs.flatMap((p) => p.timing), tps.length > 1);
    groupFits.set(id, fit);
  }
  return { fit, tps, pairs };
}

/** Fit one (model, GPU, tp) pair of a reference (jointly with the other degrees of its group). Exported so a test can check each fit on its own: together they take a while. */
export function calibratePair(reference: Reference<any, any>, key: string): FittedPair {
  const p = calibrationSet(reference).get(key);
  if (!p) throw new Error(`${reference.id}: no calibration data for ${key}`);
  if (!p.timing.length) throw new Error(`${reference.id}/${key}: calibration scenarios for speculation or prefill/decode need plain timing scenarios too`);
  const { fit, tps } = fitGroup(reference, groupOf(p));
  const timing = sigAll(fit.timing);
  const own = new Set(p.timing.map((c) => c.scenario.id));
  const mine = (rs: ScenarioScore[]) => rs.filter((s) => own.has(s.scenario));
  const out: FittedPair = {
    model: p.model,
    gpu: p.gpu,
    tp: p.tp,
    timing,
    group: groupOf(p),
    groupTps: tps,
    atBound: fit.atBound,
    identifiability: fit.identifiability.map((i) => ({ ...i, fitted: { value: sig(i.fitted.value), loss: sig(i.fitted.loss) }, held: i.held.map((h) => ({ value: h.value, loss: sig(h.loss) })), spread: sig(i.spread) })),
    defaults: DEFAULT_TIMING,
    lossAtDefaults: sig(fit.lossAtDefaults),
    lossAtFit: sig(fit.loss),
    residuals: residualsOf(mine(fit.scores)).map((r) => ({ ...r, ttftMean: sig(r.ttftMean), tpotMean: sig(r.tpotMean) })),
    residualsAtDefaults: residualsOf(mine(fit.scoresAtDefaults)).map((r) => ({ ...r, ttftMean: sig(r.ttftMean), tpotMean: sig(r.tpotMean) }))
  };
  if (p.spec[0]) {
    const s = fitSpecCost(p.spec[0], timing);
    out.specCost = { value: sig(s.value), defaultValue: 0.04, scenario: p.spec[0].scenario.id, residualTpot: sig(s.residualTpot) };
  }
  if (p.pd[0]) {
    const l = fitLink(p.pd[0], timing);
    out.linkGbps = { value: sig(l.value), defaultValue: 100, scenario: p.pd[0].scenario.id, residualKvTransfer: sig(l.residualKvTransfer) };
  }
  return out;
}

/** The pairs a reference has calibration data for, sorted. */
export const calibrationPairs = (reference: Reference<any, any>): string[] => [...calibrationSet(reference).keys()].sort((a, b) => a.localeCompare(b));

function calibrateReference(reference: Reference<any, any>): FittedReference | null {
  const pairs: Record<string, FittedPair> = {};
  for (const k of calibrationPairs(reference)) pairs[k] = calibratePair(reference, k);
  return Object.keys(pairs).length ? { lock: reference.lock(), pairs } : null;
}

export function calibrateAll(): FittedFile {
  const references: Record<string, FittedReference> = {};
  for (const r of REFERENCES) {
    const fitted = calibrateReference(r);
    if (fitted) references[r.id] = fitted;
  }
  return { method: METHOD, references };
}
