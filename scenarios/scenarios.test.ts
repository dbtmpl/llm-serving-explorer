import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseAndValidateNDJSON } from "../schema/src/index.js";
import { createTimeline, type ReplayTimeline } from "../web/src/replay/index.js";

const SCENARIOS_ROOT = path.dirname(fileURLToPath(import.meta.url));

interface ScenarioFlags {
  title: string;
  subtitle: string;
  recommended_views: string[];
  compare_variant?: {
    label: string;
  };
}

interface ManifestFile {
  schema_version: string;
  scenarios: Array<{
    id: string;
    events_file: string;
    baseline_events_file?: string;
    event_count: number;
    completed_requests: number;
  }>;
}

function discoverScenarios(): string[] {
  return readdirSync(SCENARIOS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(SCENARIOS_ROOT, d.name, "flags.json")))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

function loadAndValidateTimeline(gzPath: string): ReplayTimeline {
  expect(existsSync(gzPath), `missing trace file: ${gzPath}`).toBe(true);
  const raw = gunzipSync(readFileSync(gzPath)).toString("utf8");
  const validated = parseAndValidateNDJSON(raw);
  expect(validated.valid, `schema issues in ${gzPath}: ${JSON.stringify(validated.issues.slice(0, 5))}`).toBe(true);
  expect(validated.header).toBeDefined();
  return createTimeline(validated.header!, validated.events);
}

const scenarioIds = discoverScenarios();

describe("Guided scenarios suite", () => {
  it("contains all 9 guided scenarios and a matching manifest.json", () => {
    expect(scenarioIds).toHaveLength(9);
    const manifestPath = path.join(SCENARIOS_ROOT, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestFile;
    expect(manifest.schema_version).toBe("1.0");
    expect(manifest.scenarios.map((s) => s.id)).toEqual(scenarioIds);
  });

  it.each(scenarioIds)("%s: validates schema, builds ReplayTimeline, and passes teaching expectations", async (id) => {
    const dir = path.join(SCENARIOS_ROOT, id);
    expect(existsSync(path.join(dir, "scenario.yaml"))).toBe(true);
    expect(existsSync(path.join(dir, "narrative.md"))).toBe(true);
    expect(readFileSync(path.join(dir, "narrative.md"), "utf8").trim().length).toBeGreaterThan(50);

    const flags = JSON.parse(readFileSync(path.join(dir, "flags.json"), "utf8")) as ScenarioFlags;
    expect(flags.title.length).toBeGreaterThan(0);
    expect(flags.recommended_views.length).toBeGreaterThan(0);

    const timeline = loadAndValidateTimeline(path.join(dir, "events.ndjson.gz"));
    let baseline: ReplayTimeline | undefined;
    if (flags.compare_variant) {
      baseline = loadAndValidateTimeline(path.join(dir, "baseline.events.ndjson.gz"));
    }

    const expUrl = pathToFileURL(path.join(dir, "expectations.ts")).href;
    const mod = (await import(expUrl)) as {
      assertExpectations: (t: ReplayTimeline, b?: ReplayTimeline) => void | Promise<void>;
    };
    expect(typeof mod.assertExpectations).toBe("function");
    await mod.assertExpectations(timeline, baseline);
  });
});
