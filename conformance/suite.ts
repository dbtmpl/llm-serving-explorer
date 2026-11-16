/**
 * Run the TypeScript model on a scenario and compare it with every reference that covers each of
 * its checks. The one place the pieces are put together; the tests, the report and the summary use it.
 */
import { compare, type Comparison, type Records } from "./compare.js";
import type { ReferenceFile } from "./record.js";
import { checkReferences, fitReferenceOf, requireReferenceFile } from "./refs/index.js";
import { runTypescriptArms } from "./run/typescript.js";
import { usesCalibration, type Scenario } from "./scenario.js";

export interface ScenarioComparison {
  typescript: Records;
  /** The committed file of every reference that covers at least one check of the scenario, by reference id. */
  files: Record<string, ReferenceFile>;
  /** One per check, in the order of the scenario. */
  comparisons: Comparison[];
}

/** The model's run of a scenario, with the timing parameters fitted to the reference the scenario names when it has a timing check. */
export const runModel = (s: Scenario): Records => runTypescriptArms(s, undefined, usesCalibration(s) ? fitReferenceOf(s) : undefined);

export function compareScenario(s: Scenario, typescript: Records = runModel(s), only?: string): ScenarioComparison {
  const files: Record<string, ReferenceFile> = {};
  const comparisons = s.checks.map((check) => {
    const refs: Record<string, Records> = {};
    for (const r of checkReferences(s, check)) {
      if (only && r.id !== only) continue;
      files[r.id] ??= requireReferenceFile(r.id, s.id);
      refs[r.id] = files[r.id]!.records;
    }
    return Object.keys(refs).length ? compare(check, typescript, refs) : null;
  });
  return { typescript, files, comparisons: comparisons.filter((c): c is Comparison => c !== null) };
}
