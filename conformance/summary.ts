/**
 * The parity summary: how many of the conformance checks agree with BLIS, how many are recorded
 * as known differences, and which approaches of the registry can be checked at all.
 *
 * Generated from the scenarios, the committed references and the registry (`pnpm conformance:summary`
 * writes `conformance/summary.json`; a test fails when it is out of date).
 *
 * The headline figure is one number with one definition:
 *
 *     share of checks on mechanisms BLIS also models that agree (exact, within tolerance or directionally)
 *
 * = checks that hold as stated / all checks. Every check is on a mechanism BLIS models, because a
 * mechanism it does not model has no check (it is `notVerifiable` in the registry). So the figure
 * cannot be raised by adding approaches that BLIS lacks, and approaches that cannot be verified are
 * counted separately, never as agreement.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONCEPTS } from "../src/sim/catalog.js";
import { isVerifiable } from "../src/sim/verification.js";
import { evaluate, type Classification } from "./compare.js";
import type { Reference } from "./record.js";
import { lockedCommit } from "./run/blis.js";
import { runTypescriptArms } from "./run/typescript.js";
import { CONFORMANCE_DIR, REFERENCE_DIR, loadScenario, scenarioIds, type Check } from "./scenario.js";

export const SUMMARY_FILE = path.join(CONFORMANCE_DIR, "summary.json");

export const HEADLINE_DEFINITION = "share of checks on mechanisms BLIS also models that agree (exact, within tolerance or directionally)";

type KindCounts = Partial<Record<Classification, number>>;

export interface KnownDifferenceEntry {
  scenario: string;
  check: string;
  kind: Check["kind"];
  claim: string;
}

export interface Summary {
  blisCommit: string;
  scenarios: { total: number; calibration: number; withChecks: number };
  checks: {
    total: number;
    byKind: Record<Check["kind"], KindCounts & { total: number }>;
    /** Checks that hold as stated: exact, within tolerance or directionally in agreement. */
    agree: number;
    knownDifferences: number;
  };
  headline: { definition: string; agree: number; total: number; share: number; knownDifferences: number };
  approaches: { total: number; verified: number; notVerifiable: number };
  verified: string[];
  notVerifiable: { approach: string; reason: string }[];
  knownDifferences: KnownDifferenceEntry[];
}

const qualified = (module: string, id: string): string => `${module}/${id}`;

export function buildSummary(): Summary {
  const byKind: Summary["checks"]["byKind"] = { exact: { total: 0 }, calibrated: { total: 0 }, directional: { total: 0 } };
  const known: KnownDifferenceEntry[] = [];
  let withChecks = 0;
  let calibration = 0;
  for (const id of scenarioIds()) {
    const scenario = loadScenario(id);
    if (scenario.role === "calibration") calibration++;
    if (!scenario.checks.length) continue;
    withChecks++;
    const file = path.join(REFERENCE_DIR, `${id}.json`);
    if (!existsSync(file)) throw new Error(`${id}: no reference; run pnpm conformance:reference`);
    const ref = JSON.parse(readFileSync(file, "utf8")) as Reference;
    const ts = runTypescriptArms(scenario);
    for (const check of scenario.checks) {
      const o = evaluate(check, ts, ref.records);
      const k = byKind[check.kind];
      k.total++;
      k[o.classification] = (k[o.classification] ?? 0) + 1;
      if (o.classification === "known_difference") known.push({ scenario: id, check: check.id, kind: check.kind, claim: check.claim });
    }
  }
  const total = byKind.exact.total + byKind.calibrated.total + byKind.directional.total;
  const differences = known.length;
  const agree = total - differences;

  const verified: string[] = [];
  const notVerifiable: Summary["notVerifiable"] = [];
  for (const concept of CONCEPTS) {
    for (const a of concept.approaches) {
      const name = qualified(concept.module, a.id);
      if (isVerifiable(a.verification)) verified.push(name);
      else notVerifiable.push({ approach: name, reason: a.verification.notVerifiable });
    }
  }
  return {
    blisCommit: lockedCommit(),
    scenarios: { total: scenarioIds().length, calibration, withChecks },
    checks: { total, byKind, agree, knownDifferences: differences },
    headline: { definition: HEADLINE_DEFINITION, agree, total, share: Math.round((agree / total) * 1e4) / 1e4, knownDifferences: differences },
    approaches: { total: verified.length + notVerifiable.length, verified: verified.length, notVerifiable: notVerifiable.length },
    verified: verified.sort(),
    notVerifiable: notVerifiable.sort((a, b) => a.approach.localeCompare(b.approach)),
    knownDifferences: known
  };
}
