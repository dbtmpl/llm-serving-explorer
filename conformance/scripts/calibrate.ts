/**
 * Fit the TypeScript model's timing parameters to the committed reference records of the calibration
 * scenarios, per reference, and write `conformance/calibration/fitted.json`. Needs no external tool.
 *
 *     pnpm conformance:calibrate [--ref <id>]   (the file always holds every reference; --ref only limits what is printed)
 *
 * Deterministic: the same references give the same file (the method is documented in
 * `conformance/calibration/fit.ts`). The site's defaults are not changed; the file reports how far
 * the fit is from them.
 */
import { writeFileSync } from "node:fs";
import { calibrateAll } from "../calibration/calibrate.js";
import { FITTED_FILE, type FittedPair } from "../calibration/fitted.js";

const fitted = calibrateAll();
writeFileSync(FITTED_FILE, JSON.stringify(fitted, null, 2) + "\n");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const refFlag = process.argv.indexOf("--ref");
const only = refFlag >= 0 ? process.argv[refFlag + 1] : undefined;
for (const [ref, fit] of Object.entries(fitted.references)) for (const [k, p] of Object.entries(fit.pairs) as [string, FittedPair][]) {
  if (only && ref !== only) continue;
  const t = p.timing;
  console.log(`${ref} / ${k}: mbu ${t.mbu} (default ${p.defaults.mbu}), mfu ${t.mfu} (${p.defaults.mfu}), hostMsBase ${t.hostMsBase} (${p.defaults.hostMsBase}), hostMsPerSeq ${t.hostMsPerSeq} (${p.defaults.hostMsPerSeq}); loss ${p.lossAtDefaults} -> ${p.lossAtFit}`);
  for (const r of p.residuals) console.log(`  ${r.scenario}: ttft ${pct(r.ttftMean)}, tpot ${pct(r.tpotMean)}`);
  if (p.specCost) console.log(`  specCost ${p.specCost.value} (default ${p.specCost.defaultValue}), tpot residual ${pct(p.specCost.residualTpot)}`);
  if (p.linkGbps) console.log(`  linkGbps ${p.linkGbps.value} (default ${p.linkGbps.defaultValue}), kv transfer residual ${pct(p.linkGbps.residualKvTransfer)}`);
}
console.log(`wrote ${FITTED_FILE}`);
