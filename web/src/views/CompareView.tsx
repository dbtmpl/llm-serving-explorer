import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  loadTimelineFromAssetPath,
  type ScenarioManifestEntry
} from "../data/scenarioLoader.js";
import {
  selectFinalSummary,
  type ReplayTimeline,
  type SimState
} from "../replay/index.js";
import { SourceLinksChip } from "../components/SourceLinksChip.js";
import { GpuMapView } from "./GpuMapView.js";
import { MetricsView } from "./MetricsView.js";
import { RequestTimelineView } from "./RequestTimelineView.js";
import { RoutingExplainedView } from "./RoutingExplainedView.js";
import { TopologyView } from "./TopologyView.js";

export type ComparePanelId =
  | "gpu-map"
  | "metrics"
  | "topology"
  | "routing-explained"
  | "request-timeline";

export interface CompareViewProps {
  readonly manifestEntries: readonly ScenarioManifestEntry[];
  readonly leftEntry: ScenarioManifestEntry;
  readonly leftTimeline: ReplayTimeline;
  readonly tUs: number;
  readonly reqFilter: string;
  readonly podFilter: string;
  readonly compareId?: string;
  readonly onChangeCompareId: (id: string) => void;
  readonly onSeekUs: (tUs: number) => void;
}

export interface CompareMetricSnapshot {
  readonly outputTokS: number;
  readonly ttftMeanMs: number;
  readonly tpotMeanMs: number;
  readonly completedRequests: number;
  readonly preemptions: number;
  readonly prefixCacheHitRate: number;
}

export type MetricPolarity = "higher-better" | "lower-better";
export type DeltaSentiment = "better" | "worse" | "neutral";

export interface CompareMetricDelta {
  readonly key: keyof CompareMetricSnapshot;
  readonly label: string;
  readonly leftValue: number;
  readonly rightValue: number;
  readonly absDelta: number;
  readonly pctDelta: number | null;
  readonly ratio: number | null;
  readonly polarity: MetricPolarity;
  readonly sentiment: DeltaSentiment;
}

export interface CompareDeltasResult {
  readonly left: CompareMetricSnapshot;
  readonly right: CompareMetricSnapshot;
  readonly metrics: readonly CompareMetricDelta[];
}

export interface ResolvedCompareTarget {
  readonly id: string;
  readonly kind: "baseline" | "scenario";
  readonly label: string;
  readonly assetPath: string;
  readonly durationUsHint?: number;
}

const COMPARE_PANELS: ReadonlyArray<{ readonly id: ComparePanelId; readonly label: string }> = [
  { id: "metrics", label: "Metrics" },
  { id: "gpu-map", label: "GPU & KV Cache" },
  { id: "topology", label: "Topology" },
  { id: "routing-explained", label: "Routing" },
  { id: "request-timeline", label: "Request Timeline" }
];

const EPS = 1e-6;

export function resolveCompareTarget(
  manifestEntries: readonly ScenarioManifestEntry[],
  leftEntry: ScenarioManifestEntry,
  compareId?: string
): ResolvedCompareTarget | null {
  if (compareId === "baseline" && leftEntry.baseline_events_file) {
    return {
      id: "baseline",
      kind: "baseline",
      label: leftEntry.compare_label ?? "Baseline",
      assetPath: leftEntry.baseline_events_file
    };
  }

  if (compareId && compareId !== "baseline") {
    const match = manifestEntries.find((entry) => entry.id === compareId);
    if (match) {
      return {
        id: match.id,
        kind: "scenario",
        label: match.title,
        assetPath: match.events_file,
        durationUsHint: match.duration_us
      };
    }
  }

  if (leftEntry.baseline_events_file) {
    return {
      id: "baseline",
      kind: "baseline",
      label: leftEntry.compare_label ?? "Baseline",
      assetPath: leftEntry.baseline_events_file
    };
  }

  const fallback =
    manifestEntries.find((entry) => entry.id !== leftEntry.id) ?? manifestEntries[0];
  if (!fallback) {
    return null;
  }

  return {
    id: fallback.id,
    kind: "scenario",
    label: fallback.title,
    assetPath: fallback.events_file,
    durationUsHint: fallback.duration_us
  };
}

export function extractCompareSnapshot(state: SimState): CompareMetricSnapshot {
  const summary = selectFinalSummary(state);
  const outputTokS =
    summary.outputTokS > 0 ? summary.outputTokS : (summary.snapshotOutputTokS ?? 0);
  const ttftMeanMs =
    summary.ttftMeanMs > 0 ? summary.ttftMeanMs : (summary.snapshotTtftMeanMs ?? 0);
  const tpotMeanMs =
    summary.tpotMeanMs > 0 ? summary.tpotMeanMs : (summary.snapshotTpotMeanMs ?? 0);

  return {
    outputTokS,
    ttftMeanMs,
    tpotMeanMs,
    completedRequests: summary.completedRequests,
    preemptions: summary.preemptions,
    prefixCacheHitRate: summary.prefixCacheHitRate
  };
}

function buildMetricDelta(
  key: keyof CompareMetricSnapshot,
  label: string,
  leftValue: number,
  rightValue: number,
  polarity: MetricPolarity
): CompareMetricDelta {
  const absDelta = leftValue - rightValue;
  const pctDelta =
    Math.abs(rightValue) > EPS
      ? ((leftValue - rightValue) / Math.abs(rightValue)) * 100
      : null;
  const ratio = rightValue > EPS && leftValue > EPS ? leftValue / rightValue : null;

  let sentiment: DeltaSentiment = "neutral";
  if (Math.abs(absDelta) > EPS) {
    if (polarity === "higher-better") {
      sentiment = absDelta > 0 ? "better" : "worse";
    } else {
      sentiment = absDelta < 0 ? "better" : "worse";
    }
  }

  return {
    key,
    label,
    leftValue,
    rightValue,
    absDelta,
    pctDelta,
    ratio,
    polarity,
    sentiment
  };
}

export function computeCompareDeltas(
  leftState: SimState,
  rightState: SimState
): CompareDeltasResult {
  const left = extractCompareSnapshot(leftState);
  const right = extractCompareSnapshot(rightState);

  const metrics: CompareMetricDelta[] = [
    buildMetricDelta("outputTokS", "Output tok/s", left.outputTokS, right.outputTokS, "higher-better"),
    buildMetricDelta("ttftMeanMs", "TTFT Mean (ms)", left.ttftMeanMs, right.ttftMeanMs, "lower-better"),
    buildMetricDelta("tpotMeanMs", "TPOT Mean (ms)", left.tpotMeanMs, right.tpotMeanMs, "lower-better"),
    buildMetricDelta(
      "completedRequests",
      "Completed Requests",
      left.completedRequests,
      right.completedRequests,
      "higher-better"
    ),
    buildMetricDelta("preemptions", "Preemptions", left.preemptions, right.preemptions, "lower-better"),
    buildMetricDelta(
      "prefixCacheHitRate",
      "Prefix Cache Hit Rate",
      left.prefixCacheHitRate,
      right.prefixCacheHitRate,
      "higher-better"
    )
  ];

  return { left, right, metrics };
}

function formatDurationUs(us: number): string {
  if (us >= 1_000_000) {
    return `${(us / 1_000_000).toFixed(2)}s`;
  }
  return `${(us / 1000).toFixed(0)}ms`;
}

function formatMetricValue(key: keyof CompareMetricSnapshot, value: number): string {
  switch (key) {
    case "outputTokS":
      return value > 0 ? value.toFixed(1) : "0.0";
    case "ttftMeanMs":
    case "tpotMeanMs":
      return value > 0 ? `${value.toFixed(2)} ms` : "—";
    case "completedRequests":
    case "preemptions":
      return String(Math.round(value));
    case "prefixCacheHitRate":
      return `${(value * 100).toFixed(1)}%`;
  }
}

function formatDeltaBadgeText(delta: CompareMetricDelta): string {
  if (delta.key === "prefixCacheHitRate") {
    const pp = delta.absDelta * 100;
    if (Math.abs(pp) < 0.05) return "0.0 pp";
    return `${pp > 0 ? "+" : ""}${pp.toFixed(1)} pp`;
  }

  if (delta.key === "completedRequests" || delta.key === "preemptions") {
    const diff = Math.round(delta.absDelta);
    if (diff === 0) return "0";
    const sign = diff > 0 ? "+" : "";
    if (delta.pctDelta !== null) {
      return `${sign}${diff} (${delta.pctDelta > 0 ? "+" : ""}${delta.pctDelta.toFixed(0)}%)`;
    }
    return `${sign}${diff}`;
  }

  if (delta.leftValue <= 0 && delta.rightValue <= 0) {
    return "—";
  }

  if (delta.pctDelta === null) {
    return delta.absDelta > 0 ? "+∞" : "—";
  }

  const pctAbs = Math.abs(delta.pctDelta);
  const pctStr = `${delta.pctDelta > 0 ? "+" : ""}${
    pctAbs >= 100 ? delta.pctDelta.toFixed(0) : delta.pctDelta.toFixed(1)
  }%`;

  if (delta.key === "outputTokS" && delta.ratio !== null) {
    if (delta.ratio >= 1.2 || delta.ratio <= 0.8) {
      return `${pctStr} · ${delta.ratio.toFixed(2)}x`;
    }
    return pctStr;
  }

  if ((delta.key === "ttftMeanMs" || delta.key === "tpotMeanMs") && delta.ratio !== null) {
    if (delta.ratio <= 0.5) {
      return `${pctStr} (${(1 / delta.ratio).toFixed(1)}x faster)`;
    }
    if (delta.ratio >= 2.0) {
      return `${pctStr} (${delta.ratio.toFixed(1)}x slower)`;
    }
  }

  return pctStr;
}

function sentimentBadgeClass(sentiment: DeltaSentiment): string {
  switch (sentiment) {
    case "better":
      return "badge-ready";
    case "worse":
      return "badge-preempted";
    case "neutral":
      return "badge-neutral";
  }
}

export const CompareView: React.FC<CompareViewProps> = ({
  manifestEntries,
  leftEntry,
  leftTimeline,
  tUs,
  reqFilter,
  podFilter,
  compareId,
  onChangeCompareId,
  onSeekUs
}) => {
  const [activePanel, setActivePanel] = useState<ComparePanelId>("metrics");
  const [rightTimeline, setRightTimeline] = useState<ReplayTimeline | null>(null);
  const [rightLoading, setRightLoading] = useState(false);
  const [rightError, setRightError] = useState<string | null>(null);

  const timelineCacheRef = useRef<Map<string, ReplayTimeline>>(new Map());

  const target = useMemo(
    () => resolveCompareTarget(manifestEntries, leftEntry, compareId),
    [manifestEntries, leftEntry, compareId]
  );

  useEffect(() => {
    if (!target) {
      setRightTimeline(null);
      setRightLoading(false);
      setRightError(null);
      return;
    }

    if (target.assetPath === leftEntry.events_file) {
      setRightTimeline(leftTimeline);
      setRightLoading(false);
      setRightError(null);
      return;
    }

    const cached = timelineCacheRef.current.get(target.assetPath);
    if (cached) {
      setRightTimeline(cached);
      setRightLoading(false);
      setRightError(null);
      return;
    }

    let cancelled = false;
    setRightLoading(true);
    setRightError(null);

    loadTimelineFromAssetPath(target.assetPath)
      .then((loaded) => {
        if (cancelled) return;
        timelineCacheRef.current.set(target.assetPath, loaded.timeline);
        setRightTimeline(loaded.timeline);
        setRightLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setRightTimeline(null);
        setRightError(err instanceof Error ? err.message : String(err));
        setRightLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [target, leftEntry.events_file, leftTimeline]);

  const tLeft = Math.min(Math.max(0, tUs), leftTimeline.durationUs);
  const leftState = useMemo(() => leftTimeline.stateAt(tLeft), [leftTimeline, tLeft]);
  const leftFinalState = useMemo(
    () => leftTimeline.stateAt(leftTimeline.durationUs),
    [leftTimeline]
  );

  const tRight = rightTimeline
    ? Math.min(Math.max(0, tUs), rightTimeline.durationUs)
    : 0;
  const rightState = useMemo(
    () => (rightTimeline ? rightTimeline.stateAt(tRight) : null),
    [rightTimeline, tRight]
  );
  const rightFinalState = useMemo(
    () => (rightTimeline ? rightTimeline.stateAt(rightTimeline.durationUs) : null),
    [rightTimeline]
  );

  const liveDeltas = useMemo(
    () => (rightState ? computeCompareDeltas(leftState, rightState) : null),
    [leftState, rightState]
  );
  const finalDeltas = useMemo(
    () => (rightFinalState ? computeCompareDeltas(leftFinalState, rightFinalState) : null),
    [leftFinalState, rightFinalState]
  );

  const leftFinished = tUs >= leftTimeline.durationUs;
  const rightFinished = rightTimeline ? tUs >= rightTimeline.durationUs : false;
  const durationDiffUs = rightTimeline
    ? leftTimeline.durationUs - rightTimeline.durationUs
    : 0;

  const renderSidePanel = (
    sideTimeline: ReplayTimeline,
    sideState: SimState,
    sideTUs: number
  ) => {
    switch (activePanel) {
      case "gpu-map":
        return (
          <GpuMapView
            timeline={sideTimeline}
            state={sideState}
            tUs={sideTUs}
            podFilter={podFilter}
            reqFilter={reqFilter}
            onSeekUs={onSeekUs}
          />
        );
      case "metrics":
        return (
          <MetricsView
            timeline={sideTimeline}
            state={sideState}
            tUs={sideTUs}
            onSeekUs={onSeekUs}
          />
        );
      case "topology":
        return (
          <TopologyView
            timeline={sideTimeline}
            state={sideState}
            tUs={sideTUs}
            reqFilter={reqFilter}
            podFilter={podFilter}
            onSeekUs={onSeekUs}
          />
        );
      case "routing-explained":
        return (
          <RoutingExplainedView
            timeline={sideTimeline}
            state={sideState}
            tUs={sideTUs}
            reqFilter={reqFilter}
            podFilter={podFilter}
            onSeekUs={onSeekUs}
          />
        );
      case "request-timeline":
        return (
          <RequestTimelineView
            timeline={sideTimeline}
            state={sideState}
            tUs={sideTUs}
            reqFilter={reqFilter}
            podFilter={podFilter}
            onSeekUs={onSeekUs}
          />
        );
    }
  };

  return (
    <div data-testid="view-compare" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header & Compare Target Selector */}
      <div className="panel-card compare-controls-card">
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Side-by-Side Scenario Comparison</h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Synchronized playback across Run A and Run B · Each timeline clamps to its own completion horizon.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label
            htmlFor="compare-target-select"
            style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 }}
          >
            Compare Run A against:
          </label>
          <select
            id="compare-target-select"
            data-testid="compare-target-select"
            value={target?.id ?? ""}
            onChange={(e) => onChangeCompareId(e.target.value)}
            style={{ minWidth: 260 }}
          >
            {leftEntry.baseline_events_file && (
              <option value="baseline">
                Baseline · {leftEntry.compare_label ?? "Built-in Baseline"}
              </option>
            )}
            <optgroup label="Scenarios">
              {manifestEntries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.title}
                </option>
              ))}
            </optgroup>
          </select>

          <SourceLinksChip
            glossaryTerm="Continuous Batching"
            links={[
              { path: "sim/engine_driver.go", label: "Engine Driver", glossaryTerm: "Continuous Batching" },
              { path: "sim/llmd/gateway.go", label: "llm-d Gateway", glossaryTerm: "EPP" }
            ]}
          />
        </div>
      </div>

      {/* Duration & Sync Readout Strip */}
      <div
        className="panel-card"
        style={{
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="badge badge-decode mono">Run A: {leftEntry.id}</span>
          <span style={{ color: "var(--text-muted)" }}>vs</span>
          <span className="badge badge-transfer mono">
            Run B: {target?.kind === "baseline" ? `${leftEntry.id} (baseline)` : target?.id ?? "—"}
          </span>

          {rightTimeline && (
            <span
              className={`badge mono ${
                Math.abs(durationDiffUs) <= 1000
                  ? "badge-neutral"
                  : durationDiffUs < 0
                    ? "badge-ready"
                    : "badge-prefill"
              }`}
              data-testid="compare-duration-badge"
            >
              Duration: {formatDurationUs(leftTimeline.durationUs)} vs{" "}
              {formatDurationUs(rightTimeline.durationUs)}
              {Math.abs(durationDiffUs) > 1000 && (
                <>
                  {" "}
                  ·{" "}
                  {durationDiffUs < 0
                    ? `Run A finishes ${formatDurationUs(-durationDiffUs)} earlier`
                    : `Run B finishes ${formatDurationUs(durationDiffUs)} earlier`}
                </>
              )}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <button type="button" onClick={() => onSeekUs(leftTimeline.durationUs)}>
            Seek Run A End ({formatDurationUs(leftTimeline.durationUs)})
          </button>
          {rightTimeline && (
            <button type="button" onClick={() => onSeekUs(rightTimeline.durationUs)}>
              Seek Run B End ({formatDurationUs(rightTimeline.durationUs)})
            </button>
          )}
        </div>
      </div>

      {/* Metric Delta Strip (Live at tUs AND Final) */}
      {rightError && (
        <div className="error-banner" data-testid="compare-error-banner">
          Failed to load comparison stream: {rightError}
        </div>
      )}

      {liveDeltas && finalDeltas && (
        <div className="compare-delta-grid" data-testid="compare-delta-strip">
          {liveDeltas.metrics.map((liveMetric, idx) => {
            const finalMetric = finalDeltas.metrics[idx];
            return (
              <div
                key={liveMetric.key}
                className="compare-delta-card"
                data-testid={`compare-delta-card-${liveMetric.key}`}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 6
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      fontWeight: 600
                    }}
                  >
                    {liveMetric.label}
                  </span>
                  <span
                    className={`badge mono ${sentimentBadgeClass(finalMetric.sentiment)}`}
                    data-testid={`compare-final-badge-${liveMetric.key}`}
                    title="Final end-of-run delta (Run A vs Run B)"
                  >
                    Final {formatDeltaBadgeText(finalMetric)}
                  </span>
                </div>

                {/* Live @ tUs */}
                <div className="compare-delta-row">
                  <span style={{ color: "var(--text-secondary)" }}>
                    Live @ <span className="mono">{formatDurationUs(tUs)}</span>
                  </span>
                  <span className="mono" style={{ color: "var(--text-primary)" }}>
                    {formatMetricValue(liveMetric.key, liveMetric.leftValue)}{" "}
                    <span style={{ color: "var(--text-muted)" }}>vs</span>{" "}
                    {formatMetricValue(liveMetric.key, liveMetric.rightValue)}
                  </span>
                  <span
                    className={`badge mono ${sentimentBadgeClass(liveMetric.sentiment)}`}
                    data-testid={`compare-live-badge-${liveMetric.key}`}
                    style={{ fontSize: 10 }}
                  >
                    {formatDeltaBadgeText(liveMetric)}
                  </span>
                </div>

                {/* Final */}
                <div
                  className="compare-delta-row"
                  style={{
                    paddingTop: 4,
                    borderTop: "1px dashed var(--border-subtle)",
                    color: "var(--text-secondary)"
                  }}
                >
                  <span>Final</span>
                  <span className="mono">
                    {formatMetricValue(finalMetric.key, finalMetric.leftValue)}{" "}
                    <span style={{ color: "var(--text-muted)" }}>vs</span>{" "}
                    {formatMetricValue(finalMetric.key, finalMetric.rightValue)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Synchronized Side-by-Side Panel Selector */}
      <div
        className="panel-card"
        style={{
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", marginRight: 4 }}>
            Synchronized View:
          </span>
          {COMPARE_PANELS.map((panel) => {
            const isActive = activePanel === panel.id;
            return (
              <button
                key={panel.id}
                type="button"
                data-testid={`compare-panel-tab-${panel.id}`}
                className={isActive ? "primary" : undefined}
                onClick={() => setActivePanel(panel.id)}
              >
                {panel.label}
              </button>
            );
          })}
        </div>

        <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
          t_A = {formatDurationUs(tLeft)} · t_B = {rightTimeline ? formatDurationUs(tRight) : "—"}
        </span>
      </div>

      {/* Side-by-Side Panes */}
      <div className="compare-side-by-side" data-testid="compare-side-by-side">
        {/* Run A (Left) */}
        <section className="compare-pane" data-testid="compare-pane-left">
          <header className="compare-pane-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="badge badge-decode">RUN A</span>
              <strong style={{ fontSize: 13 }}>{leftEntry.title}</strong>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                className={`badge mono ${leftFinished ? "badge-ready" : "badge-neutral"}`}
                data-testid="compare-left-status"
              >
                {leftFinished
                  ? `Finished @ ${formatDurationUs(leftTimeline.durationUs)}`
                  : `${formatDurationUs(tLeft)} / ${formatDurationUs(leftTimeline.durationUs)}`}
              </span>
            </div>
          </header>
          {renderSidePanel(leftTimeline, leftState, tLeft)}
        </section>

        {/* Run B (Right) */}
        <section className="compare-pane" data-testid="compare-pane-right">
          <header className="compare-pane-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="badge badge-transfer">RUN B</span>
              <strong style={{ fontSize: 13 }}>{target?.label ?? "Comparison Run"}</strong>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {rightTimeline && (
                <span
                  className={`badge mono ${rightFinished ? "badge-ready" : "badge-neutral"}`}
                  data-testid="compare-right-status"
                >
                  {rightFinished
                    ? `Finished @ ${formatDurationUs(rightTimeline.durationUs)}`
                    : `${formatDurationUs(tRight)} / ${formatDurationUs(rightTimeline.durationUs)}`}
                </span>
              )}
            </div>
          </header>

          {rightLoading && (
            <div className="loading-box" data-testid="compare-right-loading">
              Loading comparison stream ({target?.assetPath})…
            </div>
          )}

          {!rightLoading && rightError && (
            <div className="error-banner">Unable to render Run B: {rightError}</div>
          )}

          {!rightLoading && !rightError && rightTimeline && rightState && (
            renderSidePanel(rightTimeline, rightState, tRight)
          )}
        </section>
      </div>
    </div>
  );
};
