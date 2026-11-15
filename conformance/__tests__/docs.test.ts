/**
 * The generated parts of docs/blis-parity.md are in step with the scenarios, the fit and the
 * registry. `pnpm docs:sync` rewrites them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceGenerated } from "../../src/sim/docs.js";
import { renderCalibration, renderHeadline, renderKnownDifferences, renderNotVerifiable } from "../docs.js";
import { CONFORMANCE_DIR } from "../scenario.js";
import { buildSummary } from "../summary.js";

const PAGE = path.join(CONFORMANCE_DIR, "..", "docs", "blis-parity.md");

describe("docs/blis-parity.md", () => {
  it("is in step with the scenarios, the fit and the registry (run pnpm docs:sync)", () => {
    const summary = buildSummary();
    const current = readFileSync(PAGE, "utf8");
    let expected = current;
    expected = replaceGenerated(expected, "parity-headline", renderHeadline(summary));
    expected = replaceGenerated(expected, "parity-calibration", renderCalibration());
    expected = replaceGenerated(expected, "parity-known", renderKnownDifferences());
    expected = replaceGenerated(expected, "parity-notverifiable", renderNotVerifiable(summary));
    if (process.env.UPDATE_DOCS) writeFileSync(PAGE, expected);
    else expect(current, "out of date: run `pnpm docs:sync`").toBe(expected);
  }, 60_000);
  it("links to the parity page from the conformance README", () => {
    expect(readFileSync(path.join(CONFORMANCE_DIR, "README.md"), "utf8")).toContain("../docs/blis-parity.md");
  });
});
