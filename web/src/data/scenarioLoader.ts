import {
  parseAndValidateNDJSON,
  validateRecord,
  type HeaderRecord,
  type SimEvent,
  type UnknownEvent,
  type ValidationIssue
} from "@llm-viz/schema";
import { createTimeline, ReplayTimeline } from "../replay/index.js";

export interface ScenarioManifestEntry {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly events_file: string;
  readonly recommended_views: readonly string[];
  readonly event_count: number;
  readonly duration_us: number;
  readonly completed_requests: number;
  readonly events_bytes: number;
  readonly baseline_events_file?: string;
  readonly compare_label?: string;
  readonly baseline_event_count?: number;
  readonly baseline_events_bytes?: number;
}

export interface ScenarioManifest {
  readonly schema_version: string;
  readonly scenarios: readonly ScenarioManifestEntry[];
}

export type ScenarioFlags = Readonly<Record<string, unknown>>;

export interface LoadedScenario {
  readonly entry: ScenarioManifestEntry;
  readonly flags: ScenarioFlags;
  readonly narrativeMd: string;
  readonly timeline: ReplayTimeline;
  readonly validationIssues: readonly ValidationIssue[];
  readonly unknownEventCount: number;
}

function baseUrl(): string {
  const raw = import.meta.env.BASE_URL || "/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export function scenarioAssetUrl(relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, "");
  return `${baseUrl()}scenarios/${clean}`;
}

async function fetchTextOrNull(url: string): Promise<string | null> {
  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }
  return res.text();
}

async function fetchJsonOrEmpty(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) {
    return {};
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Decompresses a `.ndjson.gz` (or plain `.ndjson`) fetch response into UTF-8 text.
 * Inspects gzip magic bytes (`0x1f 0x8b`) so it handles both raw gzip streams and
 * servers that transparently decode `Content-Encoding: gzip`.
 */
export async function decompressEventStreamResponse(res: Response): Promise<string> {
  if (!res.ok) {
    throw new Error(`Failed to fetch event stream: HTTP ${res.status} ${res.statusText}`);
  }
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

  if (!isGzip) {
    return new TextDecoder().decode(bytes);
  }

  if (typeof DecompressionStream === "undefined") {
    throw new Error("Browser does not support DecompressionStream('gzip')");
  }

  const decompressedStream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressedStream).text();
}

function isUnknownEventCandidate(rec: unknown): rec is UnknownEvent {
  if (typeof rec !== "object" || rec === null) {
    return false;
  }
  const obj = rec as Record<string, unknown>;
  return (
    typeof obj.type === "string" &&
    obj.type !== "header" &&
    typeof obj.seq === "number" &&
    Number.isFinite(obj.seq) &&
    typeof obj.t_us === "number" &&
    Number.isFinite(obj.t_us)
  );
}

/**
 * Parses an NDJSON string using `@llm-viz/schema`'s `parseAndValidateNDJSON`.
 * If an otherwise valid stream contains future/unknown event `type` strings,
 * preserves those records as `UnknownEvent` entries so the UI can list them in the Event Log
 * without crashing.
 */
export function parseScenarioNDJSON(ndjson: string): {
  timeline: ReplayTimeline;
  issues: ValidationIssue[];
  unknownEventCount: number;
} {
  const strict = parseAndValidateNDJSON(ndjson);
  if (strict.valid && strict.header) {
    return {
      timeline: createTimeline(strict.header, strict.events),
      issues: [],
      unknownEventCount: 0
    };
  }

  // Fallback pass: validate header + known events via validateRecord,
  // while permitting unrecognized future event `type` records with valid { seq, t_us, type }.
  const lines = ndjson
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    throw new Error("Event stream is empty; expected header record on line 1.");
  }

  let header: HeaderRecord | undefined;
  const events: SimEvent[] = [];
  const warnings: ValidationIssue[] = [];
  let unknownEventCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch (err) {
      throw new Error(
        `Invalid JSON on line ${lineNum}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (i === 0) {
      const headerCheck = validateRecord(parsed);
      if (!headerCheck.valid || (parsed as { type?: unknown }).type !== "header") {
        throw new Error(
          `Invalid header record on line 1: ${headerCheck.errors.join("; ") || "missing header"}`
        );
      }
      header = parsed as HeaderRecord;
      continue;
    }

    const check = validateRecord(parsed);
    if (check.valid) {
      const rec = parsed as HeaderRecord | SimEvent;
      if (rec.type === "header") {
        throw new Error(`Unexpected duplicate header record on line ${lineNum}`);
      }
      events.push(rec);
    } else if (isUnknownEventCandidate(parsed)) {
      unknownEventCount += 1;
      warnings.push({
        line: lineNum,
        message: `Unrecognized event type '${parsed.type}' preserved for Event Log`
      });
      events.push(parsed as unknown as SimEvent);
    } else {
      throw new Error(`Schema error on line ${lineNum}: ${check.errors.slice(0, 3).join("; ")}`);
    }
  }

  if (!header) {
    throw new Error("Event stream missing header record.");
  }

  return {
    timeline: createTimeline(header, events),
    issues: warnings,
    unknownEventCount
  };
}

export async function loadScenarioManifest(): Promise<ScenarioManifest> {
  const url = scenarioAssetUrl("manifest.json");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load scenario manifest (${res.status} ${res.statusText})`);
  }
  return (await res.json()) as ScenarioManifest;
}

export interface LoadedTimelineAsset {
  readonly timeline: ReplayTimeline;
  readonly unknownEventCount: number;
  readonly validationIssues: readonly ValidationIssue[];
}

export async function loadTimelineFromAssetPath(relativePath: string): Promise<LoadedTimelineAsset> {
  const eventsUrl = scenarioAssetUrl(relativePath);
  const eventsRes = await fetch(eventsUrl);
  const ndjson = await decompressEventStreamResponse(eventsRes);
  const parsed = parseScenarioNDJSON(ndjson);

  return {
    timeline: parsed.timeline,
    unknownEventCount: parsed.unknownEventCount,
    validationIssues: parsed.issues
  };
}

export async function loadScenario(entry: ScenarioManifestEntry): Promise<LoadedScenario> {
  const narrativeUrl = scenarioAssetUrl(`${entry.id}/narrative.md`);
  const flagsUrl = scenarioAssetUrl(`${entry.id}/flags.json`);

  const [loadedTimeline, narrativeMd, flags] = await Promise.all([
    loadTimelineFromAssetPath(entry.events_file),
    fetchTextOrNull(narrativeUrl),
    fetchJsonOrEmpty(flagsUrl)
  ]);

  return {
    entry,
    flags,
    narrativeMd: narrativeMd ?? `# ${entry.title}\n\n${entry.subtitle}`,
    timeline: loadedTimeline.timeline,
    validationIssues: loadedTimeline.validationIssues,
    unknownEventCount: loadedTimeline.unknownEventCount
  };
}
