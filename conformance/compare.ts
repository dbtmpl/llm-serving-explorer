/**
 * Compare the two simulators' records, check by check.
 *
 * A check passes as stated (no differences) or carries a `known_difference` that names every
 * differing key and both values. `evaluate` reports which of the two held, so the test can assert
 * the recorded difference is exactly the observed one: it can neither disappear nor grow unnoticed.
 *
 * - `exact`: every key of the quantity is equal. A difference names each key that is not.
 * - `calibrated`: the metric agrees within the check's relative tolerance. When it does not, the
 *   single difference `value` carries both numbers, rounded to four significant digits.
 * - `directional`: the intervention's effect (ratio or difference of the metric between two arms)
 *   has the expected direction in both simulators, and the two effects are within the check's band
 *   of each other. When not, the difference `effect` carries both effects, rounded.
 */
import { metricOf, quantityOf, type Reduced } from "./record.js";
import type { CalibratedCheck, Check, DirectionalCheck, ExactCheck, Scalar } from "./scenario.js";

export type Records = Record<string, Reduced>;

/** How a passing or recorded check is counted in the parity summary. */
export type Classification = "exact" | "within_tolerance" | "directional_agree" | "known_difference";

export interface Outcome {
  check: Check;
  typescript: Record<string, Scalar>;
  blis: Record<string, Scalar>;
  /** Keys whose values differ (a key present on one side only differs); empty when the check holds as stated. */
  differences: Record<string, { typescript: Scalar; blis: Scalar }>;
  /** Extra numbers worth printing: relative error, the two effects. */
  detail: Record<string, number | null>;
  classification: Classification;
}

/** Round to four significant digits, so a recorded value does not depend on floating-point noise. */
export const round4 = (x: number): number => (x === 0 || !Number.isFinite(x) ? x : Number(x.toPrecision(4)));

const classify = (check: Check, differences: Outcome["differences"]): Classification =>
  Object.keys(differences).length ? "known_difference" : check.kind === "exact" ? "exact" : check.kind === "calibrated" ? "within_tolerance" : "directional_agree";

function exact(check: ExactCheck, ts: Reduced, blis: Reduced): Outcome {
  const a = quantityOf(ts, check.quantity);
  const b = quantityOf(blis, check.quantity);
  const differences: Outcome["differences"] = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = key in a ? a[key]! : null;
    const y = key in b ? b[key]! : null;
    if (x !== y) differences[key] = { typescript: x, blis: y };
  }
  return { check, typescript: a, blis: b, differences, detail: {}, classification: classify(check, differences) };
}

function calibrated(check: CalibratedCheck, ts: Reduced, blis: Reduced): Outcome {
  const x = metricOf(ts, check.metric);
  const y = metricOf(blis, check.metric);
  const relError = x === null || y === null || y === 0 ? null : (x - y) / y;
  const within = relError !== null && Math.abs(relError) <= check.relTol;
  const differences: Outcome["differences"] = within ? {} : { value: { typescript: x === null ? null : round4(x), blis: y === null ? null : round4(y) } };
  return { check, typescript: { value: x }, blis: { value: y }, differences, detail: { relError }, classification: classify(check, differences) };
}

const effectOf = (check: DirectionalCheck, from: number | null, to: number | null): number | null => {
  if (from === null || to === null) return null;
  if (check.effect === "difference") return to - from;
  return from === 0 ? null : to / from;
};

function directional(check: DirectionalCheck, ts: Records, blis: Records): Outcome {
  const side = (r: Records) => {
    const from = metricOf(r[check.baseline]!, check.metric);
    const to = metricOf(r[check.intervention]!, check.metric);
    return { from, to, effect: effectOf(check, from, to) };
  };
  const a = side(ts);
  const b = side(blis);
  const moves = (e: number | null): boolean => e !== null && (check.effect === "ratio" ? (check.direction === "increase" ? e > 1 : e < 1) : check.direction === "increase" ? e > 0 : e < 0);
  const ratio = a.effect !== null && b.effect !== null && b.effect !== 0 ? a.effect / b.effect : null;
  const holds = moves(a.effect) && moves(b.effect) && ratio !== null && ratio >= check.band[0] && ratio <= check.band[1];
  const r = (x: number | null) => (x === null ? null : round4(x));
  const differences: Outcome["differences"] = holds ? {} : { effect: { typescript: r(a.effect), blis: r(b.effect) } };
  return {
    check,
    typescript: { baseline: r(a.from), intervention: r(a.to), effect: r(a.effect) },
    blis: { baseline: r(b.from), intervention: r(b.to), effect: r(b.effect) },
    differences,
    detail: { effectRatio: ratio },
    classification: classify(check, differences)
  };
}

/** Evaluate one check. `ts` and `blis` hold the record of every arm. */
export function evaluate(check: Check, ts: Records, blis: Records): Outcome {
  switch (check.kind) {
    case "exact": {
      const arm = Object.keys(ts)[0]!;
      return exact(check, ts[arm]!, blis[arm]!);
    }
    case "calibrated":
      return calibrated(check, ts[check.arm]!, blis[check.arm]!);
    case "directional":
      return directional(check, ts, blis);
  }
}
