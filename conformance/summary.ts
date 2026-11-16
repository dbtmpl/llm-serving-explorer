/**
 * The parity summary: for each reference, how many of the conformance checks it covers agree with the
 * TypeScript model, how many are recorded as known differences, and which approaches of the registry
 * it can check; and, across references, how the checks that several cover come out.
 *
 * Generated from the scenarios, the committed references and the registry (`pnpm conformance:summary`
 * writes `conformance/summary.json`; a test fails when it is out of date).
 *
 * Each reference has one headline figure with one definition:
 *
 *     share of the checks the reference covers that agree (exact, within tolerance or directionally)
 *
 * = checks that hold as stated / all checks it covers. A check is covered only where the reference
 * supports the scenario's model, GPU and mechanisms and can state what the check compares, so the
 * figure cannot be raised by adding approaches a reference lacks, and approaches that cannot be
 * verified are counted separately, never as agreement. A check on which two references disagree with
 * each other is in neither headline: it is in the cross-reference section, where the model is held
 * against the span the references leave.
 */
import path from "node:path";
import { CONCEPTS } from "../src/sim/catalog.js";
import { isVerifiable } from "../src/sim/verification.js";
import type { Agreement, Classification } from "./compare.js";
import { REFERENCES, referencesOf } from "./refs/index.js";
import { CONFORMANCE_DIR, loadScenario, scenarioIds, type Check } from "./scenario.js";
import { compareScenario } from "./suite.js";

export const SUMMARY_FILE = path.join(CONFORMANCE_DIR, "summary.json");

export const headlineDefinition = (name: string): string => `share of the checks ${name} covers that agree (exact, within tolerance or directionally)`;

type KindCounts = Partial<Record<Classification, number>>;

export interface KnownDifferenceEntry {
  scenario: string;
  check: string;
  kind: Check["kind"];
  claim: string;
}

export interface ReferenceSummary {
  id: string;
  name: string;
  kind: "simulator" | "measurement";
  /** What the reference pins (a commit, a dataset revision). */
  lock: string;
  scenarios: { total: number; calibration: number; withChecks: number };
  checks: {
    total: number;
    byKind: Record<Check["kind"], KindCounts & { total: number }>;
    /** Checks that hold as stated: exact, within tolerance or directionally in agreement. */
    agree: number;
    knownDifferences: number;
    /** Checks it covers that it shares with another reference that disagrees with it; they are in the cross-reference section. */
    disputed: number;
  };
  headline: { definition: string; agree: number; total: number; share: number; knownDifferences: number };
  /** Approaches (`module/id`) named by at least one scenario this reference covers. */
  verified: string[];
  knownDifferences: KnownDifferenceEntry[];
}

export interface CrossReferenceEntry {
  scenario: string;
  check: string;
  references: string[];
  agreement: Agreement;
}

export interface Summary {
  scenarios: { total: number; calibration: number; withChecks: number };
  references: Record<string, ReferenceSummary>;
  /** Checks covered by more than one reference, and how the model and the references stand on each. */
  crossReference: { checks: number; byAgreement: Partial<Record<Agreement, number>>; entries: CrossReferenceEntry[] };
  approaches: { total: number; verified: number; notVerifiable: number };
  verified: string[];
  notVerifiable: { approach: string; reason: string }[];
}

const qualified = (module: string, id: string): string => `${module}/${id}`;

/** The registry's approaches by the scenarios that name them. */
function approachScenarios(): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const concept of CONCEPTS) for (const a of concept.approaches) if (isVerifiable(a.verification)) out.set(qualified(concept.module, a.id), a.verification);
  return out;
}

export function buildSummary(): Summary {
  const empty = (): ReferenceSummary["checks"]["byKind"] => ({ exact: { total: 0 }, calibrated: { total: 0 }, directional: { total: 0 } });
  const refs: Record<string, ReferenceSummary> = {};
  const covered: Record<string, Set<string>> = {};
  for (const r of REFERENCES) {
    refs[r.id] = {
      id: r.id,
      name: r.name,
      kind: r.kind,
      lock: r.lock(),
      scenarios: { total: 0, calibration: 0, withChecks: 0 },
      checks: { total: 0, byKind: empty(), agree: 0, knownDifferences: 0, disputed: 0 },
      headline: { definition: headlineDefinition(r.name), agree: 0, total: 0, share: 0, knownDifferences: 0 },
      verified: [],
      knownDifferences: []
    };
    covered[r.id] = new Set();
  }
  const cross: Summary["crossReference"] = { checks: 0, byAgreement: {}, entries: [] };
  let calibration = 0;
  let withChecks = 0;
  for (const id of scenarioIds()) {
    const scenario = loadScenario(id);
    if (scenario.role === "calibration") calibration++;
    for (const r of referencesOf(scenario)) {
      const s = refs[r.id]!.scenarios;
      s.total++;
      if (scenario.role === "calibration") s.calibration++;
      if (scenario.checks.length) s.withChecks++;
      covered[r.id]!.add(id);
    }
    if (!scenario.checks.length) continue;
    withChecks++;
    for (const c of compareScenario(scenario).comparisons) {
      const ids = Object.keys(c.perReference);
      if (ids.length > 1) {
        cross.checks++;
        cross.byAgreement[c.agreement] = (cross.byAgreement[c.agreement] ?? 0) + 1;
        cross.entries.push({ scenario: id, check: c.check.id, references: ids, agreement: c.agreement });
      }
      const disputed = c.agreement === "references_disagree_inside" || c.agreement === "references_disagree_outside";
      for (const [ref, o] of Object.entries(c.perReference)) {
        const sum = refs[ref]!;
        if (disputed) {
          sum.checks.disputed++;
          continue;
        }
        const k = sum.checks.byKind[c.check.kind];
        k.total++;
        k[o.classification] = (k[o.classification] ?? 0) + 1;
        sum.checks.total++;
        if (o.classification === "known_difference") {
          sum.checks.knownDifferences++;
          sum.knownDifferences.push({ scenario: id, check: c.check.id, kind: c.check.kind, claim: c.check.claim });
        }
      }
    }
  }
  const verified: string[] = [];
  const notVerifiable: Summary["notVerifiable"] = [];
  const named = approachScenarios();
  for (const concept of CONCEPTS) {
    for (const a of concept.approaches) {
      const name = qualified(concept.module, a.id);
      if (isVerifiable(a.verification)) verified.push(name);
      else notVerifiable.push({ approach: name, reason: a.verification.notVerifiable });
    }
  }
  for (const sum of Object.values(refs)) {
    sum.checks.agree = sum.checks.total - sum.checks.knownDifferences;
    sum.headline = { ...sum.headline, agree: sum.checks.agree, total: sum.checks.total, share: sum.checks.total ? Math.round((sum.checks.agree / sum.checks.total) * 1e4) / 1e4 : 0, knownDifferences: sum.checks.knownDifferences };
    sum.verified = [...named].filter(([, ids]) => ids.some((s) => covered[sum.id]!.has(s))).map(([a]) => a).sort();
  }
  return {
    scenarios: { total: scenarioIds().length, calibration, withChecks },
    references: refs,
    crossReference: cross,
    approaches: { total: verified.length + notVerifiable.length, verified: verified.length, notVerifiable: notVerifiable.length },
    verified: verified.sort(),
    notVerifiable: notVerifiable.sort((a, b) => a.approach.localeCompare(b.approach))
  };
}
