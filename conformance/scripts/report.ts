/**
 * Print, for every scenario, each check's outcome from the TypeScript model and the committed
 * reference records. Needs no external tool. Used when writing a scenario: the printed differences are
 * what goes into its `known_difference` once they have been investigated.
 *
 *     pnpm conformance:report [<scenario id>] [--ref <reference id>]
 *
 * With several references covering a check, each is printed, then how they stand with each other.
 */
import { rowOf } from "../deviation.js";
import { referencesOf } from "../refs/index.js";
import { loadScenario, scenarioIds } from "../scenario.js";
import { compareScenario } from "../suite.js";
import { loadReferenceFile } from "../refs/index.js";

const args = process.argv.slice(2);
const refFlag = args.indexOf("--ref");
const only = refFlag >= 0 ? args[refFlag + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--ref");
const ids = positional[0] ? [positional[0]] : scenarioIds();
for (const id of ids) {
  const scenario = loadScenario(id);
  const refs = referencesOf(scenario).filter((r) => !only || r.id === only);
  if (!refs.length) {
    console.log(`${id}: no reference covers it${only ? ` (${only})` : ""}`);
    continue;
  }
  const missing = refs.filter((r) => scenario.checks.length && !loadReferenceFile(r.id, id));
  if (missing.length) {
    console.log(`${id}: no reference yet (${missing.map((r) => r.id).join(", ")})`);
    continue;
  }
  if (!scenario.checks.length) continue;
  for (const c of compareScenario(scenario, undefined, only).comparisons) {
    const several = Object.keys(c.perReference).length > 1;
    for (const [ref, o] of Object.entries(c.perReference)) {
      const n = Object.keys(o.differences).length;
      const note = c.check.kind === "exact" ? "" : ` ${JSON.stringify({ typescript: o.typescript, [ref]: o.referenceValues, ...o.detail })}`;
      const row = rowOf(id, c, ref);
      console.log(`${id} / ${c.check.id} [${c.check.kind}]${several ? ` vs ${ref}` : ""}: ${n === 0 ? "agrees" : `${n} difference(s)`}${note}`);
      console.log(`  ours ${row.ours} | ${ref} ${row.theirs} | deviation ${row.deviationText} | tolerance ${row.tolerance} | ${row.holds ? "holds" : row.byDesign ? "differs by design" : "differs"}`);
      if (n) console.log(JSON.stringify(o.differences, null, 1));
    }
    if (several) {
      console.log(`${id} / ${c.check.id}: ${c.agreement.replace(/_/g, " ")}`);
      if (Object.keys(c.gap).length) console.log(`  gap between references: ${JSON.stringify(c.gap)}`);
      if (Object.keys(c.span).length) console.log(`  against their span: ${JSON.stringify(c.span)}`);
    }
  }
}
