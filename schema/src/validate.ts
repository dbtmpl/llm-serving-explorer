import Ajv2020 from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import eventsSchema from "../events.schema.json" with { type: "json" };
import type { BLISEventStreamRecordV1, HeaderRecord, SimEvent } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateFn: ValidateFunction<BLISEventStreamRecordV1> = ajv.compile(eventsSchema);

export interface ValidationIssue {
  line: number;
  message: string;
}

export function validateRecord(record: unknown): { valid: boolean; errors: string[] } {
  const valid = validateFn(record);
  if (valid) {
    return { valid: true, errors: [] };
  }
  const errors = (validateFn.errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message ?? "validation error"}`
  );
  return { valid: false, errors };
}

export function parseAndValidateNDJSON(ndjson: string): {
  valid: boolean;
  header?: HeaderRecord;
  events: SimEvent[];
  issues: ValidationIssue[];
} {
  const lines = ndjson
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const issues: ValidationIssue[] = [];
  const events: SimEvent[] = [];
  let header: HeaderRecord | undefined;

  if (lines.length === 0) {
    issues.push({ line: 1, message: "Event stream is empty; expected header record on line 1." });
    return { valid: false, events, issues };
  }

  let prevSeq = -1;
  let prevTime = -1;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch (err) {
      issues.push({
        line: lineNum,
        message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
      });
      continue;
    }

    const res = validateRecord(parsed);
    if (!res.valid) {
      issues.push({
        line: lineNum,
        message: `Schema error: ${res.errors.slice(0, 3).join("; ")}`
      });
      continue;
    }

    const rec = parsed as BLISEventStreamRecordV1;
    if (i === 0) {
      if (rec.type !== "header") {
        issues.push({ line: lineNum, message: `Line 1 must be 'header', got '${rec.type}'.` });
      } else {
        header = rec;
      }
      continue;
    }

    if (rec.type === "header") {
      issues.push({ line: lineNum, message: "Duplicate 'header' record after line 1." });
      continue;
    }

    if (rec.seq <= prevSeq) {
      issues.push({
        line: lineNum,
        message: `Non-monotonic seq: got ${rec.seq} after ${prevSeq}.`
      });
    }
    if (rec.t_us < prevTime) {
      issues.push({
        line: lineNum,
        message: `Decreasing timestamp t_us: got ${rec.t_us} after ${prevTime}.`
      });
    }
    prevSeq = rec.seq;
    prevTime = rec.t_us;
    events.push(rec);
  }

  return {
    valid: issues.length === 0 && header !== undefined,
    header,
    events,
    issues
  };
}
