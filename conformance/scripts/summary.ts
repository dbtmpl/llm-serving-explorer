/**
 * Write `conformance/summary.json`, the parity summary, and print its headline. Needs no BLIS binary.
 *
 *     pnpm conformance:summary
 */
import { writeFileSync } from "node:fs";
import { SUMMARY_FILE, buildSummary } from "../summary.js";

const s = buildSummary();
writeFileSync(SUMMARY_FILE, JSON.stringify(s, null, 2) + "\n");
console.log(`${s.headline.definition}: ${s.headline.agree} of ${s.headline.total} (${(s.headline.share * 100).toFixed(1)} percent); ${s.headline.knownDifferences} known differences`);
console.log(`approaches: ${s.approaches.verified} of ${s.approaches.total} checked against BLIS, ${s.approaches.notVerifiable} not verifiable`);
console.log(`wrote ${SUMMARY_FILE}`);
