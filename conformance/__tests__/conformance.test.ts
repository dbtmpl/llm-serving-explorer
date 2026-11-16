/**
 * The conformance suite: the TypeScript model against every reference's committed records.
 *
 * Node only. No reference is run here (BLIS needs its binary, measured data needs a clone); each
 * reference's recorded output is read from `conformance/reference/<id>/`, and a record carries the hash
 * of the input it was made from, so a scenario edited without regenerating its reference fails loudly
 * instead of being compared with something stale.
 *
 * Each check either passes as stated or has a `known_difference`, in which case the test asserts the
 * observed difference is EXACTLY the recorded one: it cannot vanish (the model was fixed: update the
 * record) or grow (a new divergence) without this suite noticing. An exact check is equal; a
 * calibrated check is within its relative tolerance after the fit; a directional check has the same
 * direction and a similar effect on both sides. Where several references cover a check, see `compare.ts`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Reduced } from "../record.js";
import { DEFAULT_PARAMS } from "../../src/sim/index.js";
import { calibrateAll } from "../calibration/calibrate.js";
import { loadFitted, pairKey } from "../calibration/fitted.js";
import { REFERENCES, checkReferences, fitReferenceOf, loadReferenceFile, referencesOf } from "../refs/index.js";
import { SPAN, REFERENCE_DIR, loadScenario, scenarioIds, usesCalibration } from "../scenario.js";
import { compareScenario, runModel } from "../suite.js";
import { SUMMARY_FILE, buildSummary } from "../summary.js";

describe("scenarios and references", () => {
  it("has at least the scenarios phase 1 promises", () => {
    expect(scenarioIds()).toEqual(
      expect.arrayContaining(["kv-budget-8b-h100", "prefix-cache", "routing-round-robin", "routing-least-loaded", "routing-prefix-aware", "preemption-overflow", "queue-deadline-shedding"])
    );
  });
  it("has no reference record without a scenario it can answer", () => {
    for (const r of REFERENCES) {
      const dir = path.join(REFERENCE_DIR, r.id);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
        const id = path.basename(f, ".json");
        expect(scenarioIds().includes(id), `${r.id}/${f} has no scenario`).toBe(true);
        expect(referencesOf(loadScenario(id)).some((x) => x.id === r.id), `${r.id} cannot answer ${id}`).toBe(true);
      }
    }
  });
  it("every reference names a lock and says what it is evidence for", () => {
    for (const r of REFERENCES) {
      expect(r.lock().length, r.id).toBeGreaterThan(6);
      expect(r.evidence.length, r.id).toBeGreaterThan(80);
    }
  });
});

for (const id of scenarioIds()) {
  describe(`scenario ${id}`, () => {
    const scenario = loadScenario(id);
    const refs = referencesOf(scenario);

    it("is answered by at least one reference", () => {
      expect(refs.length).toBeGreaterThan(0);
    });

    for (const ref of refs) {
      it(`has a ${ref.id} reference made from the current scenario`, () => {
        const file = loadReferenceFile(ref.id, id);
        expect(file, `no reference: run pnpm conformance:reference --ref ${ref.id} --only ${id}`).not.toBeNull();
        expect(file!.reference).toBe(ref.id);
        expect(file!.inputHash, "the scenario changed after its reference was generated; run pnpm conformance:reference").toBe(ref.inputHash(scenario));
        expect(ref.provenanceProblem(file!.provenance)).toBeNull();
        expect(Object.keys(file!.records).sort()).toEqual(Object.keys(scenario.arms).sort());
        for (const [arm, rec] of Object.entries(file!.records)) {
          expect(rec.source).toBe(ref.id);
          expect(rec.scenario, arm).toBe(id);
        }
      });
    }

    const ts: { runs?: Record<string, Reduced> } = {};
    const typescript = (): Record<string, Reduced> => (ts.runs ??= runModel(scenario));

    it("runs to completion in the TypeScript model with every request accounted for", () => {
      for (const [arm, reduced] of Object.entries(typescript())) expect(reduced.requests, arm).toHaveLength(scenario.arms[arm]!.requests.length);
    });

    it("names only references that cover its checks, and records differences only for comparisons that happen", () => {
      for (const check of scenario.checks) {
        const ids = checkReferences(scenario, check).map((r) => r.id);
        expect(ids.length, `${check.id}: no reference covers it`).toBeGreaterThan(0);
        for (const k of check.knownDifferences) expect([...ids, SPAN], `${check.id}: a known_difference for ${k.reference}, which does not cover the check`).toContain(k.reference);
      }
    });

    scenario.checks.forEach((check, i) => {
      const covering = checkReferences(scenario, check).map((r) => r.id);
      it(`${check.id} (${check.kind}) against ${covering.join(" and ")}: ${check.knownDifferences.length || check.referenceGap ? "differs exactly as recorded" : "holds"}`, () => {
        const c = compareScenario(scenario, typescript()).comparisons[i]!;
        expect(c.unusedRecords, `${check.id}: records that no comparison uses (a stale known_difference or reference_gap)`).toEqual([]);
        for (const a of c.assertions) {
          if (a.scope === "gap") expect(a.observed, `${check.id}: the references disagree with each other and the scenario does not explain the gap (reference_gap)`).toEqual(a.recorded);
          else expect(a.observed, `${check.id} (${a.scope}): ${check.claim}`).toEqual(a.recorded);
        }
      });
    });
  });
}

describe("calibration", () => {
  it("fitted.json is what the fit produces from the committed references (run pnpm conformance:calibrate)", () => {
    expect(calibrateAll()).toEqual(loadFitted());
  }, 120_000);
  it("has a fit for every pair that a calibrated or directional check uses", () => {
    const fitted = loadFitted();
    for (const id of scenarioIds()) {
      const s = loadScenario(id);
      if (!usesCalibration(s)) continue;
      const ref = fitReferenceOf(s);
      for (const d of Object.values(s.arms)) expect(fitted.references[ref]?.pairs[pairKey(d.model, d.gpu, d.engine.tp)], `${id}: no calibration to ${ref} for ${d.model}/${d.gpu}/tp${d.engine.tp}`).toBeDefined();
    }
  });
  it("never lets the fit move the site's defaults, and reports them beside the fitted values", () => {
    for (const p of Object.values(loadFitted().references).flatMap((r) => Object.values(r.pairs))) expect(p.defaults).toEqual({ mbu: DEFAULT_PARAMS.mbu, mfu: DEFAULT_PARAMS.mfu, hostMsBase: DEFAULT_PARAMS.hostMsBase, hostMsPerSeq: DEFAULT_PARAMS.hostMsPerSeq });
  });
  it("does not use a calibration scenario as a held-out check", () => {
    for (const id of scenarioIds()) if (loadScenario(id).role === "calibration") expect(loadScenario(id).checks).toEqual([]);
  });
});

describe("parity summary", () => {
  it("conformance/summary.json is what the scenarios, references and registry give (run pnpm conformance:summary)", () => {
    expect(buildSummary()).toEqual(JSON.parse(readFileSync(SUMMARY_FILE, "utf8")));
  }, 60_000);
  it("counts a known difference as a difference and an unverifiable approach as no agreement at all", () => {
    const s = buildSummary();
    for (const r of Object.values(s.references)) {
      expect(r.headline.agree + r.headline.knownDifferences, r.id).toBe(r.headline.total);
      expect(r.headline.knownDifferences, r.id).toBe(r.knownDifferences.length);
      expect(r.checks.total, r.id).toBe(r.checks.byKind.exact.total + r.checks.byKind.capacity.total + r.checks.byKind.calibrated.total + r.checks.byKind.directional.total);
    }
    expect(s.approaches.verified + s.approaches.notVerifiable).toBe(s.approaches.total);
  }, 60_000);
});
