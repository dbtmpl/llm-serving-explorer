/**
 * Run the TypeScript model on a scenario and compare it with every reference that covers each of
 * its checks. The one place the pieces are put together; the tests, the report and the summary use it.
 */
import { compare, type Comparison, type Records } from "./compare.js";
import { restrict, type ReferenceFile } from "./record.js";
import { checkReferences, fitReferenceOf, requireReferenceFile } from "./refs/index.js";
import { runTypescriptArms } from "./run/typescript.js";
import { needsFit, paramsOf, subsetKeys, type ParamsMode, type Scenario } from "./scenario.js";

type Mode = ParamsMode;

/** The model's runs of a scenario, one per set of timing parameters its checks use, each made once and when first asked for. */
export class ModelRuns {
  private runs: Partial<Record<Mode, Records>> = {};
  constructor(readonly scenario: Scenario) {}
  get(mode: Mode): Records {
    return (this.runs[mode] ??= runTypescriptArms(this.scenario, undefined, mode !== "defaults" ? fitReferenceOf(this.scenario) : undefined, mode));
  }
}

/** The model's run of a scenario with the parameters its checks default to (fitted when it has a timing check meant for them). */
export const runModel = (s: Scenario, runs: ModelRuns = new ModelRuns(s)): Records => runs.get(needsFit(s) ? "fitted" : "defaults");

export interface ScenarioComparison {
  /** One per check, in the order of the scenario. */
  comparisons: Comparison[];
}

export function compareScenario(s: Scenario, runs: ModelRuns = new ModelRuns(s), only?: string): ScenarioComparison {
  const files: Record<string, ReferenceFile> = {};
  const comparisons = s.checks.map((check) => {
    const keys = subsetKeys(s, check.subset ?? "all");
    const narrow = (r: Records): Records => Object.fromEntries(Object.entries(r).map(([arm, rec]) => [arm, restrict(rec, keys)]));
    const refs: Record<string, Records> = {};
    for (const r of checkReferences(s, check)) {
      if (only && r.id !== only) continue;
      files[r.id] ??= requireReferenceFile(r.id, s.id);
      refs[r.id] = narrow(files[r.id]!.records);
    }
    return Object.keys(refs).length ? compare(check, narrow(runs.get(paramsOf(s, check))), refs) : null;
  });
  return { comparisons: comparisons.filter((c): c is Comparison => c !== null) };
}
