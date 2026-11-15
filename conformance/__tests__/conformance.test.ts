/**
 * The conformance suite: the TypeScript model against the committed BLIS references.
 *
 * Node only. BLIS is not run here; its recorded output is read from `conformance/reference/`, and the
 * reference carries the hash of the BLIS input it was made from, so a scenario edited without
 * regenerating its reference fails loudly instead of being compared with something stale.
 *
 * Each check either passes as stated or has a `known_difference`, in which case the test asserts the
 * observed difference is EXACTLY the recorded one: it cannot vanish (the model was fixed: update the
 * record) or grow (a new divergence) without this suite noticing. An exact check is equal; a
 * calibrated check is within its relative tolerance after the fit; a directional check has the same
 * direction and a similar effect in both simulators.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "../compare.js";
import type { Reduced, Reference } from "../record.js";
import { lockedCommit } from "../run/blis.js";
import { runTypescriptArms } from "../run/typescript.js";
import { DEFAULT_PARAMS } from "../../src/sim/index.js";
import { calibrateAll } from "../calibration/calibrate.js";
import { loadFitted, pairKey } from "../calibration/fitted.js";
import { SUMMARY_FILE, buildSummary } from "../summary.js";
import { REFERENCE_DIR, loadScenario, scenarioIds, usesCalibration } from "../scenario.js";
import { scenarioInputHash } from "../translate/toBlis.js";

const HASH = /^[0-9a-f]{64}$/;

describe("scenarios and references", () => {
  it("has at least the scenarios phase 1 promises", () => {
    expect(scenarioIds()).toEqual(
      expect.arrayContaining(["kv-budget-8b-h100", "prefix-cache", "routing-round-robin", "routing-least-loaded", "routing-prefix-aware", "preemption-overflow", "queue-deadline-shedding"])
    );
  });
  it("has no reference without a scenario", () => {
    const ids = new Set(scenarioIds());
    for (const f of readdirJson()) expect(ids.has(f), `${f}.json has no scenario`).toBe(true);
  });
});

function readdirJson(): string[] {
  return readdirSync(REFERENCE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.basename(f, ".json"));
}

for (const id of scenarioIds()) {
  describe(`scenario ${id}`, () => {
    const scenario = loadScenario(id);
    const file = path.join(REFERENCE_DIR, `${id}.json`);

    it("has a reference made from the current scenario, by the pinned BLIS", () => {
      expect(existsSync(file), `no reference: run pnpm conformance:reference`).toBe(true);
      const ref = JSON.parse(readFileSync(file, "utf8")) as Reference;
      expect(ref.inputHash, "the scenario changed after its reference was generated; run pnpm conformance:reference").toBe(scenarioInputHash(scenario));
      expect(ref.blis.commit, "reference made by another BLIS commit than conformance/blis.lock; regenerate").toBe(lockedCommit());
      expect(ref.blis.catalogHash).toMatch(HASH);
      expect(ref.blis.registryHash).toMatch(HASH);
      expect(Object.keys(ref.records).sort()).toEqual(Object.keys(scenario.arms).sort());
      for (const [arm, rec] of Object.entries(ref.records)) {
        expect(rec.simulator).toBe("blis");
        expect(rec.scenario, arm).toBe(id);
      }
    });

    const ts: { runs?: Record<string, Reduced> } = {};
    const typescript = (): Record<string, Reduced> => (ts.runs ??= runTypescriptArms(scenario));

    it("runs to completion in the TypeScript model with every request accounted for", () => {
      for (const [arm, reduced] of Object.entries(typescript())) expect(reduced.requests, arm).toHaveLength(scenario.arms[arm]!.requests.length);
    });

    for (const check of scenario.checks) {
      it(`${check.id} (${check.kind}): ${check.knownDifference ? "differs exactly as recorded" : "holds"}`, () => {
        const ref = JSON.parse(readFileSync(file, "utf8")) as Reference;
        const outcome = evaluate(check, typescript(), ref.records);
        if (check.knownDifference) {
          expect(outcome.differences, `${check.id}: the observed difference is not the recorded known_difference`).toEqual(check.knownDifference.differences);
        } else {
          expect(outcome.differences, `${check.id}: ${check.claim} (${JSON.stringify({ typescript: outcome.typescript, blis: outcome.blis, ...outcome.detail })})`).toEqual({});
        }
      });
    }
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
      for (const d of Object.values(s.arms)) expect(fitted.pairs[pairKey(d.model, d.gpu, d.engine.tp)], `${id}: no calibration for ${d.model}/${d.gpu}/tp${d.engine.tp}`).toBeDefined();
    }
  });
  it("never lets the fit move the site's defaults, and reports them beside the fitted values", () => {
    for (const p of Object.values(loadFitted().pairs)) expect(p.defaults).toEqual({ mbu: DEFAULT_PARAMS.mbu, mfu: DEFAULT_PARAMS.mfu, hostMsBase: DEFAULT_PARAMS.hostMsBase, hostMsPerSeq: DEFAULT_PARAMS.hostMsPerSeq });
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
    expect(s.headline.agree + s.headline.knownDifferences).toBe(s.headline.total);
    expect(s.headline.knownDifferences).toBe(s.knownDifferences.length);
    expect(s.approaches.verified + s.approaches.notVerifiable).toBe(s.approaches.total);
    // every check belongs to a scenario; none belongs to an approach that cannot be verified
    expect(s.headline.total).toBe(s.checks.total);
  }, 60_000);
});
