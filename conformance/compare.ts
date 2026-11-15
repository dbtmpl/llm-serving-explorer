/**
 * Compare the two simulators' records, check by check.
 *
 * A check passes as stated (no differences) or carries a `known_difference` that names every
 * differing key and both values. `evaluate` reports which of the two held, so the test can assert
 * the recorded difference is exactly the observed one: it can neither disappear nor grow unnoticed.
 */
import { quantityOf, type Reduced } from "./record.js";
import type { Check, Scalar } from "./scenario.js";

export interface Outcome {
  check: Check;
  typescript: Record<string, Scalar>;
  blis: Record<string, Scalar>;
  /** Keys whose values differ (a key present on one side only differs). */
  differences: Record<string, { typescript: Scalar; blis: Scalar }>;
}

export function evaluate(check: Check, ts: Reduced, blis: Reduced): Outcome {
  const a = quantityOf(ts, check.quantity);
  const b = quantityOf(blis, check.quantity);
  const differences: Outcome["differences"] = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = key in a ? a[key]! : null;
    const y = key in b ? b[key]! : null;
    if (x !== y) differences[key] = { typescript: x, blis: y };
  }
  return { check, typescript: a, blis: b, differences };
}
