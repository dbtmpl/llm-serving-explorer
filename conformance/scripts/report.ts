/**
 * Print, for every scenario, each check's outcome from the TypeScript model and the committed BLIS
 * reference. Needs no BLIS binary. Used when writing a scenario: the printed differences are what
 * goes into its `known_difference` once they have been investigated.
 *
 *     pnpm conformance:report [<id>]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { evaluate } from "../compare.js";
import type { Reference } from "../record.js";
import { runTypescriptArms } from "../run/typescript.js";
import { REFERENCE_DIR, loadScenario, scenarioIds } from "../scenario.js";

const ids = process.argv[2] ? [process.argv[2]] : scenarioIds();
for (const id of ids) {
  const scenario = loadScenario(id);
  const file = path.join(REFERENCE_DIR, `${id}.json`);
  if (!existsSync(file)) {
    console.log(`${id}: no reference yet`);
    continue;
  }
  const ts = runTypescriptArms(scenario);
  const ref = JSON.parse(readFileSync(file, "utf8")) as Reference;
  for (const check of scenario.checks) {
    const o = evaluate(check, ts, ref.records);
    const n = Object.keys(o.differences).length;
    const note = check.kind === "exact" ? "" : ` ${JSON.stringify({ typescript: o.typescript, blis: o.blis, ...o.detail })}`;
    console.log(`${id} / ${check.id} [${check.kind}]: ${n === 0 ? "agrees" : `${n} difference(s)`}${note}`);
    if (n) console.log(JSON.stringify(o.differences, null, 1));
  }
}
