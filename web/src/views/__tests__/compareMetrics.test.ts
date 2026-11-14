import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseScenarioNDJSON, type ScenarioManifest } from "../../data/scenarioLoader.js";
import {
  computeCompareDeltas,
  resolveCompareTarget
} from "../CompareView.js";

const SCENARIOS_DIR = path.resolve(import.meta.dirname, "../../../../scenarios");

function loadManifest(): ScenarioManifest {
  const raw = readFileSync(path.join(SCENARIOS_DIR, "manifest.json"), "utf8");
  return JSON.parse(raw) as ScenarioManifest;
}

function loadGzipTimeline(relativePath: string) {
  const fullPath = path.join(SCENARIOS_DIR, relativePath);
  const ndjson = gunzipSync(readFileSync(fullPath)).toString("utf8");
  return parseScenarioNDJSON(ndjson).timeline;
}

describe("CompareView delta & target helpers", () => {
  it("computes > 2x throughput speedup and lower TTFT for 02-continuous-batching vs baseline", () => {
    const manifest = loadManifest();
    const entry = manifest.scenarios.find((s) => s.id === "02-continuous-batching");
    expect(entry).toBeDefined();
    expect(entry!.baseline_events_file).toBeDefined();

    const leftTimeline = loadGzipTimeline(entry!.events_file);
    const rightTimeline = loadGzipTimeline(entry!.baseline_events_file!);

    const leftFinal = leftTimeline.stateAt(leftTimeline.durationUs);
    const rightFinal = rightTimeline.stateAt(rightTimeline.durationUs);

    const deltas = computeCompareDeltas(leftFinal, rightFinal);
    const tokS = deltas.metrics.find((m) => m.key === "outputTokS")!;
    const ttft = deltas.metrics.find((m) => m.key === "ttftMeanMs")!;
    const completed = deltas.metrics.find((m) => m.key === "completedRequests")!;

    expect(tokS.leftValue).toBeGreaterThan(tokS.rightValue * 2);
    expect(tokS.ratio).not.toBeNull();
    expect(tokS.ratio!).toBeGreaterThan(2);
    expect(tokS.sentiment).toBe("better");

    expect(ttft.leftValue).toBeLessThan(ttft.rightValue);
    expect(ttft.pctDelta!).toBeLessThan(-50);
    expect(ttft.sentiment).toBe("better");

    expect(completed.leftValue).toBe(12);
    expect(completed.rightValue).toBe(12);
    expect(completed.absDelta).toBe(0);
    expect(completed.sentiment).toBe("neutral");
  });

  it("handles synchronized intermediate timestamp clamping and prefix-cache hit delta", () => {
    const manifest = loadManifest();
    const entry = manifest.scenarios.find((s) => s.id === "03-prefix-caching")!;
    expect(entry.baseline_events_file).toBeDefined();

    const leftTimeline = loadGzipTimeline(entry.events_file);
    const rightTimeline = loadGzipTimeline(entry.baseline_events_file!);

    const tUs = 2_000_000;
    const live = computeCompareDeltas(
      leftTimeline.stateAt(Math.min(tUs, leftTimeline.durationUs)),
      rightTimeline.stateAt(Math.min(tUs, rightTimeline.durationUs))
    );
    expect(live.metrics).toHaveLength(6);

    const final = computeCompareDeltas(
      leftTimeline.stateAt(leftTimeline.durationUs),
      rightTimeline.stateAt(rightTimeline.durationUs)
    );
    const hitRate = final.metrics.find((m) => m.key === "prefixCacheHitRate")!;
    expect(hitRate.leftValue).toBeGreaterThan(0.5);
    expect(hitRate.rightValue).toBe(0);
    expect(hitRate.absDelta).toBeGreaterThan(0.5);
    expect(hitRate.sentiment).toBe("better");
  });

  it("resolves built-in baseline by default when available and falls back to another scenario otherwise", () => {
    const manifest = loadManifest();
    const batching = manifest.scenarios.find((s) => s.id === "02-continuous-batching")!;
    const single = manifest.scenarios.find((s) => s.id === "01-single-request")!;

    const defaultForBatching = resolveCompareTarget(manifest.scenarios, batching, undefined);
    expect(defaultForBatching?.id).toBe("baseline");
    expect(defaultForBatching?.kind).toBe("baseline");
    expect(defaultForBatching?.assetPath).toBe(batching.baseline_events_file);

    const explicitOther = resolveCompareTarget(manifest.scenarios, batching, "03-prefix-caching");
    expect(explicitOther?.id).toBe("03-prefix-caching");
    expect(explicitOther?.kind).toBe("scenario");

    const fallbackForSingle = resolveCompareTarget(manifest.scenarios, single, "baseline");
    expect(fallbackForSingle).not.toBeNull();
    expect(fallbackForSingle?.kind).toBe("scenario");
    expect(fallbackForSingle?.id).not.toBe("01-single-request");
  });
});
