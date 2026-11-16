/**
 * Compare the TypeScript model's records with a reference's, check by check, and with several
 * references' together.
 *
 * Against one reference (`evaluate`): a check passes as stated (no differences) or carries a
 * `known_difference` for that reference that names every differing key and both values.
 *
 * - `exact`: every key of the quantity is equal. A difference names each key that is not.
 * - `calibrated`: the metric agrees within the check's relative tolerance. When it does not, the
 *   single difference `value` carries both numbers, rounded to four significant digits.
 * - `directional`: the intervention's effect (ratio or difference of the metric between two arms)
 *   has the expected direction on both sides, and the two effects are within the check's band of
 *   each other. When not, the difference `effect` carries both effects, rounded.
 *
 * Against several (`compare`): the references are first compared with each other, by the same rule
 * (one reference taking the place of the model). If they agree, the model is held against each of
 * them as above. If two of them disagree, the gap between them must be recorded and explained
 * (`reference_gap`), and the model is held against their span instead of against either one: a
 * check never passes merely by matching the more convenient reference.
 */
import { metricOf, quantityOf, type Reduced } from "./record.js";
import { SPAN, TYPESCRIPT, type CalibratedCheck, type Check, type DirectionalCheck, type Differences, type ExactCheck, type Scalar } from "./scenario.js";

export type Records = Record<string, Reduced>;

/** How a passing or recorded check is counted in a reference's parity summary. */
export type Classification = "exact" | "within_tolerance" | "directional_agree" | "known_difference";

export interface Outcome {
  check: Check;
  /** The id of the reference compared with. */
  reference: string;
  /** Both sides' values at the keys the check compares. */
  typescript: Record<string, Scalar>;
  referenceValues: Record<string, Scalar>;
  /** Keys whose values differ (a key present on one side only differs); empty when the check holds as stated. Each carries `typescript` and the reference's id. */
  differences: Differences;
  /** Extra numbers worth printing: relative error, the two effects. */
  detail: Record<string, number | null>;
  classification: Classification;
}

/** Round to four significant digits, so a recorded value does not depend on floating-point noise. */
export const round4 = (x: number): number => (x === 0 || !Number.isFinite(x) ? x : Number(x.toPrecision(4)));

const classify = (check: Check, differences: Differences): Classification =>
  Object.keys(differences).length ? "known_difference" : check.kind === "exact" ? "exact" : check.kind === "calibrated" ? "within_tolerance" : "directional_agree";

const idOf = (records: Records): string => Object.values(records)[0]!.source;

function exact(check: ExactCheck, ts: Reduced, ref: Reduced): Outcome {
  const a = quantityOf(ts, check.quantity);
  const b = quantityOf(ref, check.quantity);
  const differences: Differences = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = key in a ? a[key]! : null;
    const y = key in b ? b[key]! : null;
    if (x !== y) differences[key] = { [TYPESCRIPT]: x, [ref.source]: y };
  }
  return { check, reference: ref.source, typescript: a, referenceValues: b, differences, detail: {}, classification: classify(check, differences) };
}

function calibrated(check: CalibratedCheck, ts: Reduced, ref: Reduced): Outcome {
  const x = metricOf(ts, check.metric);
  const y = metricOf(ref, check.metric);
  const relError = x === null || y === null || y === 0 ? null : (x - y) / y;
  const within = relError !== null && Math.abs(relError) <= check.relTol;
  const differences: Differences = within ? {} : { value: { [TYPESCRIPT]: x === null ? null : round4(x), [ref.source]: y === null ? null : round4(y) } };
  return { check, reference: ref.source, typescript: { value: x }, referenceValues: { value: y }, differences, detail: { relError }, classification: classify(check, differences) };
}

const effectOf = (check: DirectionalCheck, from: number | null, to: number | null): number | null => {
  if (from === null || to === null) return null;
  if (check.effect === "difference") return to - from;
  return from === 0 ? null : to / from;
};

const moves = (check: DirectionalCheck, e: number | null): boolean => e !== null && (check.effect === "ratio" ? (check.direction === "increase" ? e > 1 : e < 1) : check.direction === "increase" ? e > 0 : e < 0);

/** The effect of a directional check's intervention in one set of arm records. */
const sideOf = (check: DirectionalCheck, r: Records) => {
  const from = metricOf(r[check.baseline]!, check.metric);
  const to = metricOf(r[check.intervention]!, check.metric);
  return { from, to, effect: effectOf(check, from, to) };
};

/** Two effects agree when both move the right way and their ratio is inside the band. Identical effects (two zeros included) agree exactly. */
const effectRatio = (a: number | null, b: number | null): number | null => (a !== null && b !== null ? (a === b ? 1 : b !== 0 ? a / b : null) : null);

function directional(check: DirectionalCheck, ts: Records, ref: Records): Outcome {
  const id = idOf(ref);
  const a = sideOf(check, ts);
  const b = sideOf(check, ref);
  const ratio = effectRatio(a.effect, b.effect);
  const holds = moves(check, a.effect) && moves(check, b.effect) && ratio !== null && ratio >= check.band[0] && ratio <= check.band[1];
  const r = (x: number | null) => (x === null ? null : round4(x));
  const differences: Differences = holds ? {} : { effect: { [TYPESCRIPT]: r(a.effect), [id]: r(b.effect) } };
  return {
    check,
    reference: id,
    typescript: { baseline: r(a.from), intervention: r(a.to), effect: r(a.effect) },
    referenceValues: { baseline: r(b.from), intervention: r(b.to), effect: r(b.effect) },
    differences,
    detail: { effectRatio: ratio },
    classification: classify(check, differences)
  };
}

/** Evaluate one check against one reference. `ts` and `ref` hold the record of every arm. */
export function evaluate(check: Check, ts: Records, ref: Records): Outcome {
  switch (check.kind) {
    case "exact": {
      const arm = Object.keys(ts)[0]!;
      return exact(check, ts[arm]!, ref[arm]!);
    }
    case "calibrated":
      return calibrated(check, ts[check.arm]!, ref[check.arm]!);
    case "directional":
      return directional(check, ts, ref);
  }
}

// ---------------------------------------------------------------------------------------------
// Several references

/**
 * How the model, and the references with each other, stand on one check covered by several references.
 *
 * - `single`: only one reference covers it.
 * - `all_agree`: the references agree with each other, and so does the model.
 * - `typescript_with_some`: the references agree with each other; the model agrees with at least one but not all (tolerances are not transitive).
 * - `typescript_differs`: the references agree with each other; the model agrees with none.
 * - `references_disagree_inside` / `_outside`: two references disagree with each other, and the model is inside / outside the span they leave.
 */
export type Agreement = "single" | "all_agree" | "typescript_with_some" | "typescript_differs" | "references_disagree_inside" | "references_disagree_outside";

/** One equality the suite asserts: what was observed, against what the scenario records. */
export interface Assertion {
  /** A reference id, `span` (the model against references that disagree) or `gap` (the references with each other). */
  scope: string;
  observed: Differences;
  recorded: Differences;
}

export interface Comparison {
  check: Check;
  /** The model against each reference. */
  perReference: Record<string, Outcome>;
  agreement: Agreement;
  /** The keys on which references differ with each other, with every reference's value; empty when they agree. */
  gap: Differences;
  /** The model against the span of the references; empty when inside it. Only filled when the references disagree. */
  span: Differences;
  /** Everything the test asserts for this check. */
  assertions: Assertion[];
  /** Known-difference records (by reference or `span`) that no assertion uses: a stale record. */
  unusedRecords: string[];
}

const span = (xs: number[]): [number, number] => [Math.min(...xs), Math.max(...xs)];
const show = ([lo, hi]: [number, number]): string => `[${round4(lo)}, ${round4(hi)}]`;

/** Reported values of one reference at the keys a check compares, as a difference would print them. */
function reported(o: Outcome, key: string): Scalar {
  if (o.check.kind === "exact") return key in o.referenceValues ? o.referenceValues[key]! : null;
  const v = o.referenceValues[key === "value" || key === "effect" ? key : "value"];
  return typeof v === "number" ? round4(v) : (v ?? null);
}

function gapOf(check: Check, outcomes: Record<string, Outcome>, refs: Record<string, Records>): Differences {
  const ids = Object.keys(refs);
  const keys = new Set<string>();
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) for (const k of Object.keys(evaluate(check, refs[ids[i]!]!, refs[ids[j]!]!).differences)) keys.add(k);
  const gap: Differences = {};
  for (const k of [...keys].sort()) gap[k] = Object.fromEntries(ids.map((id) => [id, reported(outcomes[id]!, k)]));
  return gap;
}

/** The model against the span of the references, which disagree. */
function againstSpan(check: Check, ts: Records, refs: Record<string, Records>, outcomes: Record<string, Outcome>): Differences {
  const ids = Object.keys(refs);
  const out: Differences = {};
  switch (check.kind) {
    case "exact": {
      const tsQ = outcomes[ids[0]!]!.typescript;
      const keys = new Set([...Object.keys(tsQ), ...ids.flatMap((id) => Object.keys(outcomes[id]!.referenceValues))]);
      for (const k of [...keys].sort()) {
        const t = k in tsQ ? tsQ[k]! : null;
        const vs = ids.map((id) => (k in outcomes[id]!.referenceValues ? outcomes[id]!.referenceValues[k]! : null));
        const numeric = typeof t === "number" && vs.every((v) => typeof v === "number");
        const inside = numeric ? t >= Math.min(...(vs as number[])) && t <= Math.max(...(vs as number[])) : vs.includes(t);
        if (!inside) out[k] = { [TYPESCRIPT]: t, [SPAN]: numeric ? show(span(vs as number[])) : [...new Set(vs.map(String))].sort().join(" | ") };
      }
      return out;
    }
    case "calibrated": {
      const t = metricOf(ts[check.arm]!, check.metric);
      const vs = ids.map((id) => metricOf(refs[id]![check.arm]!, check.metric));
      if (t === null || vs.some((v) => v === null || v === 0)) return { value: { [TYPESCRIPT]: t === null ? null : round4(t), [SPAN]: vs.map((v) => (v === null ? "none" : String(round4(v)))).join(" | ") } };
      const [lo, hi] = span(vs as number[]);
      const distance = t < lo ? (lo - t) / lo : t > hi ? (t - hi) / hi : 0;
      return distance <= check.relTol ? {} : { value: { [TYPESCRIPT]: round4(t), [SPAN]: show([lo, hi]) } };
    }
    case "directional": {
      const a = sideOf(check, ts).effect;
      const es = ids.map((id) => sideOf(check, refs[id]!).effect);
      const bad = (): Differences => ({ effect: { [TYPESCRIPT]: a === null ? null : round4(a), [SPAN]: es.map((e) => (e === null ? "none" : String(round4(e)))).join(" | ") } });
      if (a === null || es.some((e) => e === null) || !moves(check, a) || !es.every((e) => moves(check, e))) return bad();
      const [lo, hi] = span(es as number[]);
      const nearest = a < lo ? lo : a > hi ? hi : a;
      const ratio = effectRatio(a, nearest);
      return ratio !== null && ratio >= check.band[0] && ratio <= check.band[1] ? {} : bad();
    }
  }
}

/** Compare the model with every reference that covers the check, and the references with each other. `refs` is keyed by reference id. */
export function compare(check: Check, ts: Records, refs: Record<string, Records>): Comparison {
  const ids = Object.keys(refs);
  if (!ids.length) throw new Error(`check ${check.id}: no reference covers it`);
  const perReference: Record<string, Outcome> = {};
  for (const id of ids) perReference[id] = evaluate(check, ts, refs[id]!);

  const gap = ids.length > 1 ? gapOf(check, perReference, refs) : {};
  const disagree = Object.keys(gap).length > 0;
  const spanDiff = disagree ? againstSpan(check, ts, refs, perReference) : {};
  const holds = ids.filter((id) => !Object.keys(perReference[id]!.differences).length);
  const agreement: Agreement =
    ids.length === 1
      ? "single"
      : disagree
        ? Object.keys(spanDiff).length
          ? "references_disagree_outside"
          : "references_disagree_inside"
        : holds.length === ids.length
          ? "all_agree"
          : holds.length
            ? "typescript_with_some"
            : "typescript_differs";

  const recordOf = (scope: string): Differences => check.knownDifferences.find((k) => k.reference === scope)?.differences ?? {};
  const assertions: Assertion[] = disagree
    ? [
        { scope: "gap", observed: gap, recorded: check.referenceGap?.differences ?? {} },
        { scope: SPAN, observed: spanDiff, recorded: recordOf(SPAN) }
      ]
    : ids.map((id) => ({ scope: id, observed: perReference[id]!.differences, recorded: recordOf(id) }));
  const used = new Set(assertions.map((a) => a.scope));
  const unusedRecords = [...check.knownDifferences.map((k) => k.reference).filter((r) => !used.has(r)), ...(check.referenceGap && !disagree ? ["gap"] : [])];
  return { check, perReference, agreement, gap, span: spanDiff, assertions, unusedRecords };
}
