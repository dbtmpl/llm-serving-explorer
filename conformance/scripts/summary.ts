/**
 * Write `conformance/summary.json`, the parity summary, and print each reference's headline. Needs no external tool.
 *
 *     pnpm conformance:summary
 */
import { writeFileSync } from "node:fs";
import { SUMMARY_FILE, buildSummary } from "../summary.js";

const s = buildSummary();
writeFileSync(SUMMARY_FILE, JSON.stringify(s, null, 2) + "\n");
for (const r of Object.values(s.references)) {
  console.log(`${r.headline.definition}: ${r.headline.agree} of ${r.headline.total} (${(r.headline.share * 100).toFixed(1)} percent); ${r.headline.knownDifferences} known differences`);
  console.log(`  approaches named by its scenarios: ${r.verified.length} of ${s.approaches.total}`);
}
if (s.crossReference.checks) console.log(`checks covered by several references: ${s.crossReference.checks} ${JSON.stringify(s.crossReference.byAgreement)}`);
console.log(`approaches: ${s.approaches.verified} of ${s.approaches.total} named by a scenario, ${s.approaches.notVerifiable} not verifiable`);
console.log(`wrote ${SUMMARY_FILE}`);
