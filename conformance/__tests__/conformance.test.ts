/**
 * The conformance suite: the TypeScript model against the committed BLIS references.
 *
 * Node only. BLIS is not run here; its recorded output is read from `conformance/reference/`, and the
 * reference carries the hash of the BLIS input it was made from, so a scenario edited without
 * regenerating its reference fails loudly instead of being compared with something stale.
 *
 * Each check either passes as stated or has a `known_difference`, in which case the test asserts the
 * observed difference is EXACTLY the recorded one: it cannot vanish (the model was fixed: update the
 * record) or grow (a new divergence) without this suite noticing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "../compare.js";
import type { Reduced, Reference } from "../record.js";
import { lockedCommit } from "../run/blis.js";
import { runTypescript } from "../run/typescript.js";
import { REFERENCE_DIR, loadScenario, scenarioIds } from "../scenario.js";
import { toBlis } from "../translate/toBlis.js";

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
      expect(ref.inputHash, "the scenario changed after its reference was generated; run pnpm conformance:reference").toBe(toBlis(scenario).inputHash);
      expect(ref.blis.commit, "reference made by another BLIS commit than conformance/blis.lock; regenerate").toBe(lockedCommit());
      expect(ref.blis.catalogHash).toMatch(HASH);
      expect(ref.blis.registryHash).toMatch(HASH);
      expect(ref.record.simulator).toBe("blis");
      expect(ref.record.scenario).toBe(id);
    });

    const ts: { run?: Reduced } = {};
    const typescript = (): Reduced => (ts.run ??= runTypescript(scenario).reduced);

    it("runs to completion in the TypeScript model with every request accounted for", () => {
      const reduced = typescript();
      expect(reduced.requests).toHaveLength(scenario.requests.length);
    });

    for (const check of scenario.checks) {
      it(`${check.id}: ${check.knownDifference ? "differs exactly as recorded" : "agrees"}`, () => {
        const ref = JSON.parse(readFileSync(file, "utf8")) as Reference;
        const outcome = evaluate(check, typescript(), ref.record);
        if (check.knownDifference) {
          expect(outcome.differences, `${check.id}: the observed difference is not the recorded known_difference`).toEqual(check.knownDifference.differences);
        } else {
          expect(outcome.differences, `${check.id}: ${check.claim}`).toEqual({});
        }
      });
    }
  });
}
