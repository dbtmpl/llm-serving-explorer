/**
 * Fit one (model, GPU) group of a reference and print its pairs as JSON. Used by the test that checks
 * `fitted.json`: the fit is minutes of synchronous computation, which a test runner would starve its
 * worker of heartbeats for, so the test runs it in a child process.
 *
 *     tsx conformance/scripts/calibrate-group.ts <reference id> <model>/<gpu>
 */
import { calibratePair, calibrationPairs } from "../calibration/calibrate.js";
import { REFERENCES } from "../refs/index.js";

const [refId, group] = process.argv.slice(2);
const reference = REFERENCES.find((r) => r.id === refId);
if (!reference || !group) throw new Error("usage: calibrate-group.ts <reference id> <model>/<gpu>");
const out: Record<string, unknown> = {};
for (const key of calibrationPairs(reference).filter((k) => k.replace(/\/tp\d+$/, "") === group)) out[key] = calibratePair(reference, key);
process.stdout.write(JSON.stringify(out));
