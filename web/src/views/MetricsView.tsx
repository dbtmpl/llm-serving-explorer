import React, { useMemo } from "react";
import type { MetricsSnapshotEvent } from "@llm-viz/schema";
import { selectFinalSummary, type ReplayTimeline, type SimState } from "../replay/index.js";
import { InfoHint } from "../components/GlossaryModal.js";
import { SourceLinksChip } from "../components/SourceLinksChip.js";

export interface MetricsViewProps {
  timeline: ReplayTimeline;
  state: SimState;
  tUs: number;
  onSeekUs: (tUs: number) => void;
}

interface SeriesConfig {
  readonly label: string;
  readonly color: string;
  readonly values: readonly number[];
  readonly formatValue: (v: number) => string;
}

interface InteractiveChartProps {
  testId: string;
  title: string;
  durationUs: number;
  tUs: number;
  timestampsUs: readonly number[];
  series: readonly SeriesConfig[];
  yMax: number;
  yUnit: string;
  onSeekUs: (tUs: number) => void;
}

const CHART_W = 540;
const CHART_H = 190;
const PAD_L = 46;
const PAD_R = 16;
const PAD_T = 14;
const PAD_B = 26;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

const InteractiveSvgChart: React.FC<InteractiveChartProps> = ({
  testId,
  title,
  durationUs,
  tUs,
  timestampsUs,
  series,
  yMax,
  yUnit,
  onSeekUs
}) => {
  const safeDuration = Math.max(1, durationUs);
  const safeYMax = Math.max(1e-6, yMax);

  const mapX = (ts: number) => PAD_L + (Math.max(0, Math.min(ts, safeDuration)) / safeDuration) * PLOT_W;
  const mapY = (val: number) => PAD_T + PLOT_H - (Math.max(0, Math.min(val, safeYMax)) / safeYMax) * PLOT_H;

  const cursorX = mapX(tUs);

  const handlePointer = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * CHART_W;
    const ratio = Math.max(0, Math.min(1, (svgX - PAD_L) / PLOT_W));
    onSeekUs(Math.round(ratio * safeDuration));
  };

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const xTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="chart-card" data-testid={testId}>
      <div className="chart-header">
        <h3 className="chart-title">{title}</h3>
        <div className="chart-legend">
          {series.map((s) => (
            <span key={s.label} className="chart-legend-item">
              <span className="legend-swatch" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        style={{ width: "100%", height: "auto", display: "block", cursor: "crosshair" }}
        onClick={handlePointer}
        role="img"
        aria-label={`${title} chart (click to seek)`}
      >
        {/* Horizontal gridlines */}
        {yTicks.map((frac) => {
          const y = PAD_T + PLOT_H * (1 - frac);
          const val = safeYMax * frac;
          return (
            <g key={frac}>
              <line x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y} stroke="#1f2b3e" strokeWidth={1} />
              <text
                x={PAD_L - 6}
                y={y + 3}
                textAnchor="end"
                fill="#6c7f9c"
                fontSize={10}
                fontFamily="var(--font-mono)"
              >
                {val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)}
                {frac === 1 ? yUnit : ""}
              </text>
            </g>
          );
        })}

        {/* X axis ticks */}
        {xTicks.map((frac) => {
          const x = PAD_L + PLOT_W * frac;
          const ms = (safeDuration * frac) / 1000;
          return (
            <text
              key={frac}
              x={x}
              y={CHART_H - 6}
              textAnchor="middle"
              fill="#6c7f9c"
              fontSize={10}
              fontFamily="var(--font-mono)"
            >
              {ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`}
            </text>
          );
        })}

        {/* Series paths + points */}
        {series.map((s) => {
          const pts = timestampsUs.map((ts, i) => ({
            x: mapX(ts),
            y: mapY(s.values[i] ?? 0),
            ts
          }));
          const pathD =
            pts.length > 0
              ? pts.map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
              : "";
          return (
            <g key={s.label}>
              {pts.length > 1 && (
                <path d={pathD} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
              )}
              {pts.map((p, idx) => (
                <circle
                  key={idx}
                  cx={p.x}
                  cy={p.y}
                  r={pts.length <= 25 ? 3 : 1.7}
                  fill={s.color}
                  opacity={p.ts <= tUs ? 1 : 0.35}
                />
              ))}
            </g>
          );
        })}

        {/* Playback time cursor */}
        <line
          x1={cursorX}
          y1={PAD_T}
          x2={cursorX}
          y2={PAD_T + PLOT_H}
          stroke="#e6edf7"
          strokeWidth={1.5}
          strokeDasharray="3,3"
        />
      </svg>
    </div>
  );
};

export const MetricsView: React.FC<MetricsViewProps> = ({ timeline, state, tUs, onSeekUs }) => {
  const summary = useMemo(() => selectFinalSummary(state), [state]);

  const allSnapshots = useMemo(
    () =>
      timeline.events.filter(
        (ev): ev is MetricsSnapshotEvent => ev.type === "metrics.snapshot"
      ),
    [timeline]
  );

  const chartData = useMemo(() => {
    const timestampsUs = allSnapshots.map((s) => s.t_us);
    const kvUtilPct = allSnapshots.map((s) => {
      if (s.instances.length === 0) return 0;
      let used = 0;
      let total = 0;
      for (const inst of s.instances) {
        used += inst.kv_used_blocks;
        total += inst.kv_total_blocks;
      }
      return total > 0 ? (used / total) * 100 : 0;
    });

    const queueDepth = allSnapshots.map(
      (s) => s.gateway_queue_depth + s.instances.reduce((acc, inst) => acc + inst.queue_depth, 0)
    );
    const ttftMs = allSnapshots.map((s) => s.ttft_mean_ms);
    const tpotMs = allSnapshots.map((s) => s.tpot_mean_ms);
    const throughputScaled = allSnapshots.map((s) => s.output_tok_s);
    const prefixHitPct = allSnapshots.map((s) => s.prefix_cache_hit_rate * 100);

    const maxQueue = Math.max(10, ...queueDepth);
    const queueScaledTo100 = queueDepth.map((q) => (q / maxQueue) * 100);

    const maxLatency = Math.max(10, ...ttftMs, ...tpotMs);
    const maxThroughput = Math.max(1, ...throughputScaled);

    return {
      timestampsUs,
      kvUtilPct,
      queueScaledTo100,
      maxQueue,
      ttftMs,
      tpotMs,
      maxLatency,
      throughputScaled,
      maxThroughput,
      prefixHitPct
    };
  }, [allSnapshots]);

  const ttftDisplay =
    summary.ttftMeanMs > 0
      ? summary.ttftMeanMs
      : (summary.snapshotTtftMeanMs ?? 0);
  const tpotDisplay =
    summary.tpotMeanMs > 0
      ? summary.tpotMeanMs
      : (summary.snapshotTpotMeanMs ?? 0);
  const tokSDisplay =
    summary.outputTokS > 0
      ? summary.outputTokS
      : (summary.snapshotOutputTokS ?? 0);

  return (
    <div data-testid="metrics-view" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="view-header-row">
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Cluster Metrics &amp; Time-Series</h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Cumulative KPIs up to cursor and interactive BLIS progress snapshots (click any chart to seek).
          </div>
        </div>
        <SourceLinksChip
          glossaryTerm="TTFT"
          links={[
            { path: "sim/metrics.go", label: "Metrics", glossaryTerm: "TTFT" },
            { path: "sim/progress_hook.go", label: "Snapshots", glossaryTerm: "TPOT" },
            { path: "sim/cluster/metrics.go", label: "Cluster Metrics" }
          ]}
        />
      </div>

      <div className="kpi-grid" style={{ marginBottom: 0 }}>
        <div className="kpi-card" data-testid="kpi-completed">
          <div className="kpi-label">Completed</div>
          <div className="kpi-value mono">{summary.completedRequests}</div>
          <div className="kpi-sub">
            rejected {summary.rejectedRequests} · dropped {summary.droppedRequests}
          </div>
        </div>

        <div className="kpi-card" data-testid="kpi-ttft">
          <div className="kpi-label">
            TTFT Mean <InfoHint term="TTFT" />
          </div>
          <div className="kpi-value mono">
            {ttftDisplay > 0 ? `${ttftDisplay.toFixed(2)} ms` : "—"}
          </div>
          <div className="kpi-sub">Time to first token</div>
        </div>

        <div className="kpi-card" data-testid="kpi-tpot">
          <div className="kpi-label">
            TPOT Mean <InfoHint term="TPOT" />
          </div>
          <div className="kpi-value mono">
            {tpotDisplay > 0 ? `${tpotDisplay.toFixed(2)} ms` : "—"}
          </div>
          <div className="kpi-sub">Time per output token</div>
        </div>

        <div className="kpi-card" data-testid="kpi-throughput">
          <div className="kpi-label">Output tok/s</div>
          <div className="kpi-value mono">{tokSDisplay.toFixed(1)}</div>
          <div className="kpi-sub mono">{state.clusterTotals.totalOutputTokens} tokens total</div>
        </div>

        <div className="kpi-card" data-testid="kpi-preemptions">
          <div className="kpi-label">
            Preemptions <InfoHint term="Preemption" />
          </div>
          <div className="kpi-value mono" style={{ color: summary.preemptions > 0 ? "var(--sem-preempted)" : undefined }}>
            {summary.preemptions}
          </div>
          <div className="kpi-sub">Evicted running requests</div>
        </div>

        <div className="kpi-card" data-testid="kpi-prefix-hit">
          <div className="kpi-label">
            Prefix Hit Rate <InfoHint term="Prefix Cache" />
          </div>
          <div className="kpi-value mono" style={{ color: "var(--sem-cached)" }}>
            {(summary.prefixCacheHitRate * 100).toFixed(1)}%
          </div>
          <div className="kpi-sub">Prompt block reuse</div>
        </div>

        <div className="kpi-card" data-testid="kpi-gateway-queue">
          <div className="kpi-label">Gateway Queue</div>
          <div className="kpi-value mono">{state.gateway.queueDepth}</div>
          <div className="kpi-sub">
            arrived {state.gateway.totalArrived} · admitted {state.gateway.totalAdmitted}
          </div>
        </div>
      </div>

      <div className="charts-grid">
        <InteractiveSvgChart
          testId="metrics-chart-kv"
          title={`KV Utilization % & Queue Depth (max Q=${chartData.maxQueue})`}
          durationUs={timeline.durationUs}
          tUs={tUs}
          timestampsUs={chartData.timestampsUs}
          yMax={100}
          yUnit="%"
          onSeekUs={onSeekUs}
          series={[
            {
              label: "KV Used %",
              color: "#38bdf8",
              values: chartData.kvUtilPct,
              formatValue: (v) => `${v.toFixed(1)}%`
            },
            {
              label: "Queue (scaled)",
              color: "#f59e0b",
              values: chartData.queueScaledTo100,
              formatValue: (v) => `${v.toFixed(0)}%`
            }
          ]}
        />

        <InteractiveSvgChart
          testId="metrics-chart-latency"
          title="Latency (TTFT & TPOT ms)"
          durationUs={timeline.durationUs}
          tUs={tUs}
          timestampsUs={chartData.timestampsUs}
          yMax={chartData.maxLatency}
          yUnit="ms"
          onSeekUs={onSeekUs}
          series={[
            {
              label: "TTFT Mean (ms)",
              color: "#f59e0b",
              values: chartData.ttftMs,
              formatValue: (v) => `${v.toFixed(2)}ms`
            },
            {
              label: "TPOT Mean (ms)",
              color: "#c084fc",
              values: chartData.tpotMs,
              formatValue: (v) => `${v.toFixed(2)}ms`
            }
          ]}
        />

        <InteractiveSvgChart
          testId="metrics-chart-throughput"
          title="Output Throughput (tok/s)"
          durationUs={timeline.durationUs}
          tUs={tUs}
          timestampsUs={chartData.timestampsUs}
          yMax={chartData.maxThroughput}
          yUnit=""
          onSeekUs={onSeekUs}
          series={[
            {
              label: "Output tok/s",
              color: "#38bdf8",
              values: chartData.throughputScaled,
              formatValue: (v) => `${v.toFixed(1)} tok/s`
            }
          ]}
        />

        <InteractiveSvgChart
          testId="metrics-chart-prefix"
          title="KV Prefix Cache Hit Rate (%)"
          durationUs={timeline.durationUs}
          tUs={tUs}
          timestampsUs={chartData.timestampsUs}
          yMax={100}
          yUnit="%"
          onSeekUs={onSeekUs}
          series={[
            {
              label: "Prefix Hit %",
              color: "#10b981",
              values: chartData.prefixHitPct,
              formatValue: (v) => `${v.toFixed(1)}%`
            }
          ]}
        />
      </div>
    </div>
  );
};
