/**
 * The references the suite knows, and which of them apply to a scenario and to a check.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ReferenceFile } from "../record.js";
import { referenceFile, type Check, type Scenario } from "../scenario.js";
import { blis } from "./blis/index.js";
import { vllmMeasured } from "./vllm-measured/index.js";
import { canState, unsupportedBecause, type Reference } from "./reference.js";

/** Every reference, in the order the summary and the docs list them. */
export const REFERENCES: readonly Reference<any, any>[] = [blis, vllmMeasured];

export function referenceById(id: string): Reference<any, any> {
  const r = REFERENCES.find((x) => x.id === id);
  if (!r) throw new Error(`unknown reference "${id}"; known: ${REFERENCES.map((x) => x.id).join(", ")}`);
  return r;
}

/** The references that can answer the scenario: its model, GPU, mechanisms and arms are all in their `supports`. */
export function referencesOf(s: Scenario): Reference<any, any>[] {
  return REFERENCES.filter((r) => unsupportedBecause(r, s) === null);
}

/**
 * The references a check applies to: those named by its `references` list, or else every reference
 * that applies to the scenario and can state what the check compares. A list that names a reference
 * which cannot answer the scenario or the check is an error, not a silent skip.
 */
export function checkReferences(s: Scenario, check: Check): Reference<any, any>[] {
  if (check.references) {
    return check.references.map((id) => {
      const r = referenceById(id);
      const why = unsupportedBecause(r, s) ?? (canState(r, check) ? null : `${r.name} cannot state what check ${check.id} compares`);
      if (why) throw new Error(`${s.id} / ${check.id}: names reference "${id}", but ${why}`);
      return r;
    });
  }
  return referencesOf(s).filter((r) => canState(r, check));
}

/**
 * The reference whose fitted timing parameters the TypeScript model runs a scenario with: the one the
 * scenario names, or else the only reference that covers it. With several and no name there is no
 * honest default, so it is an error.
 */
export function fitReferenceOf(s: Scenario): string {
  if (s.fitReference) {
    referenceById(s.fitReference);
    return s.fitReference;
  }
  const ids = referencesOf(s).map((r) => r.id);
  if (ids.length !== 1) throw new Error(`${s.id}: ${ids.length} references cover it (${ids.join(", ")}); say which one the timing parameters are fitted to with fit_reference`);
  return ids[0]!;
}

/** The committed file of a reference for a scenario, or null when there is none. */
export function loadReferenceFile(ref: string, scenario: string): ReferenceFile | null {
  const file = referenceFile(ref, scenario);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ReferenceFile) : null;
}

/** Like `loadReferenceFile`, but a missing file is an error that says how to make it. */
export function requireReferenceFile(ref: string, scenario: string): ReferenceFile {
  const f = loadReferenceFile(ref, scenario);
  if (!f) throw new Error(`${scenario}: no ${ref} reference; run pnpm conformance:reference --ref ${ref} --only ${scenario}`);
  return f;
}
