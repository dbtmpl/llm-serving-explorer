/**
 * The generated parts of docs/parity.md and of the root README's parity section are in step with the
 * scenarios, the fits and the registry. `pnpm docs:sync` rewrites them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceGenerated } from "../../src/sim/docs.js";
import { readmeFigure, renderCalibration, renderCrossReference, renderHeadline, renderKnownDifferences, renderNotVerifiable, renderReadmeParity } from "../docs.js";
import { REFERENCES } from "../refs/index.js";
import { CONFORMANCE_DIR } from "../scenario.js";
import { buildSummary } from "../summary.js";

const PAGE = path.join(CONFORMANCE_DIR, "..", "docs", "parity.md");

describe("docs/parity.md", () => {
  it("is in step with the scenarios, the fits and the registry (run pnpm docs:sync)", () => {
    const summary = buildSummary();
    const current = readFileSync(PAGE, "utf8");
    let expected = current;
    for (const r of REFERENCES) {
      if (!summary.references[r.id]!.checks.total) continue;
      expected = replaceGenerated(expected, `parity-headline-${r.id}`, renderHeadline(summary, r.id));
      expected = replaceGenerated(expected, `parity-calibration-${r.id}`, renderCalibration(r.id));
      expected = replaceGenerated(expected, `parity-known-${r.id}`, renderKnownDifferences(r.id));
    }
    expected = replaceGenerated(expected, "parity-cross", renderCrossReference(summary));
    expected = replaceGenerated(expected, "parity-notverifiable", renderNotVerifiable(summary));
    if (process.env.UPDATE_DOCS) writeFileSync(PAGE, expected);
    else expect(current, "out of date: run `pnpm docs:sync`").toBe(expected);
  }, 60_000);
  it("has a section for every reference, naming it", () => {
    const page = readFileSync(PAGE, "utf8");
    for (const r of REFERENCES) expect(page, r.id).toContain(`## ${r.name}`);
  });
  it("the root README quotes each reference's current figure and the table (run pnpm docs:sync for the table)", () => {
    const readme = path.join(CONFORMANCE_DIR, "..", "README.md");
    const summary = buildSummary();
    const current = readFileSync(readme, "utf8");
    const expected = replaceGenerated(current, "parity-readme", renderReadmeParity(summary));
    if (process.env.UPDATE_DOCS) writeFileSync(readme, expected);
    else expect(current, "out of date: run `pnpm docs:sync`").toBe(expected);
    // The figures in the opening paragraphs are prose, so they are checked, not rewritten.
    for (const r of REFERENCES) {
      if (!summary.references[r.id]!.checks.total) continue;
      expect(expected.split(readmeFigure(summary, r.id)).length - 1, `README must say "${readmeFigure(summary, r.id)}" in the introduction and in the parity section`).toBeGreaterThanOrEqual(2);
    }
  }, 60_000);
  it("links to the parity page from the conformance README", () => {
    expect(readFileSync(path.join(CONFORMANCE_DIR, "README.md"), "utf8")).toContain("../docs/parity.md");
  });
});
