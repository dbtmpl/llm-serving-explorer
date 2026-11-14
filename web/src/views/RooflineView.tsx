import React, { useMemo, useState } from "react";
import type { PoolConfig } from "@llm-viz/schema";
import {
  selectPods,
  selectRooflinePoints,
  type PodState,
  type RooflineHistoryEntry,
  type SimState
} from "../replay/index.js";
import { InfoHint } from "../components/GlossaryModal.js";
import { SourceLinksChip } from "../components/SourceLinksChip.js";

export interface RooflineViewProps {
  state: SimState;
  podFilter?: string;
  onSeekUs?: (tUs: number) => void;
}

const SVG_W = 680;
const SVG_H = 340;
const PAD_L = 62;
const PAD_R = 24;
const PAD_T = 22;
const PAD_B = 44;
const PLOT_W = SVG_W - PAD_L - PAD_R;
const PLOT_H = SVG_H - PAD_T - PAD_B;

const PHASE_COLORS: Record<RooflineHistoryEntry["phase"], string> = {
  prefill: "#f59e0b",
  decode: "#38bdf8",
  mixed: "#a855f7"
};

function formatSci(val: number): string {
  if (val >= 1e12) return `${(val / 1e12).toFixed(2)} T`;
  if (val >= 1e9) return `${(val / 1e9).toFixed(2)} G`;
  if (val >= 1e6) return `${(val / 1e6).toFixed(2)} M`;
  return val.toFixed(0);
}

function formatBytesSI(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  return `${bytes.toFixed(0)} B`;
}

function formatMs(tUs: number): string {
  return `${(tUs / 1000).toFixed(2)} ms`;
}

function pointKey(pt: RooflineHistoryEntry): string {
  return `${pt.podId}:${pt.batchId}:${pt.tUs}`;
}

function buildLogTicks(minVal: number, maxVal: number): number[] {
  const minExp = Math.floor(Math.log10(Math.max(1e-3, minVal)));
  const maxExp = Math.ceil(Math.log10(Math.max(1e-2, maxVal)));
  const ticks: number[] = [];
  for (let exp = minExp; exp <= maxExp; exp++) {
    const v = 10 ** exp;
    if (v >= minVal * 0.999 && v <= maxVal * 1.001) {
      ticks.push(v);
    }
  }
  return ticks;
}

interface PoolRooflineChartProps {
  pool: PoolConfig;
  poolIndex: number;
  podsInPool: readonly PodState[];
  points: readonly RooflineHistoryEntry[];
  activeKeys: ReadonlySet<string>;
  selectedPoint: RooflineHistoryEntry | null;
  onHoverPoint: (pt: RooflineHistoryEntry | null) => void;
  onSelectPoint: (pt: RooflineHistoryEntry) => void;
}

const PoolRooflineChart: React.FC<PoolRooflineChartProps> = ({
  pool,
  poolIndex,
  podsInPool,
  points,
  activeKeys,
  selectedPoint,
  onHoverPoint,
  onSelectPoint
}) => {
  const specs = pool.gpu_specs;
  const bf16Peak = Math.max(1, specs.tflops_peak);
  const hasFp8 = specs.tflops_fp8 > bf16Peak;
  const fp8Peak = hasFp8 ? specs.tflops_fp8 : bf16Peak;
  const bwTbs = Math.max(0.01, specs.bw_peak_tbs);

  const ridgeBf16 = bf16Peak / bwTbs;
  const ridgeFp8 = fp8Peak / bwTbs;

  // Compute log-log bounds covering both the hardware ceilings and all observed points
  let minAi = 0.25;
  let maxAi = Math.max(10_000, ridgeFp8 * 12);
  let minTf = 0.25;
  let maxTf = Math.max(bf16Peak, fp8Peak) * 1.8;

  for (const pt of points) {
    const ai = Math.max(1e-3, pt.roofline.arithmetic_intensity);
    const tf = Math.max(1e-3, pt.roofline.achieved_tflops);
    if (ai < minAi) minAi = Math.max(0.05, ai * 0.6);
    if (ai > maxAi) maxAi = ai * 1.6;
    if (tf < minTf) minTf = Math.max(0.05, tf * 0.6);
    if (tf > maxTf) maxTf = tf * 1.4;
  }

  const logXMin = Math.log10(minAi);
  const logXMax = Math.log10(maxAi);
  const logYMin = Math.log10(minTf);
  const logYMax = Math.log10(maxTf);

  const mapX = (ai: number) => {
    const lx = Math.log10(Math.max(minAi, Math.min(maxAi, ai)));
    return PAD_L + ((lx - logXMin) / Math.max(1e-6, logXMax - logXMin)) * PLOT_W;
  };

  const mapY = (tf: number) => {
    const ly = Math.log10(Math.max(minTf, Math.min(maxTf, tf)));
    return PAD_T + PLOT_H - ((ly - logYMin) / Math.max(1e-6, logYMax - logYMin)) * PLOT_H;
  };

  const xTicks = useMemo(() => buildLogTicks(minAi, maxAi), [minAi, maxAi]);
  const yTicks = useMemo(() => buildLogTicks(minTf, maxTf), [minTf, maxTf]);

  // Memory bandwidth diagonal start coordinate clamped inside plot
  const bwStartAi = Math.max(minAi, minTf / bwTbs);
  const bwStartY = bwStartAi * bwTbs;

  // BF16 ceiling polyline
  const bf16PathPoints = [
    `${mapX(bwStartAi).toFixed(1)},${mapY(bwStartY).toFixed(1)}`,
    `${mapX(ridgeBf16).toFixed(1)},${mapY(bf16Peak).toFixed(1)}`,
    `${mapX(maxAi).toFixed(1)},${mapY(bf16Peak).toFixed(1)}`
  ].join(" ");

  // FP8 extension polyline (from BF16 ridge up to FP8 ridge and across)
  const fp8PathPoints = hasFp8
    ? [
        `${mapX(ridgeBf16).toFixed(1)},${mapY(bf16Peak).toFixed(1)}`,
        `${mapX(ridgeFp8).toFixed(1)},${mapY(fp8Peak).toFixed(1)}`,
        `${mapX(maxAi).toFixed(1)},${mapY(fp8Peak).toFixed(1)}`
      ].join(" ")
    : null;

  const ridgeBf16X = mapX(ridgeBf16);
  const ridgeFp8X = mapX(ridgeFp8);

  return (
    <div className="chart-card" data-testid={`roofline-pool-${pool.role}-${poolIndex}`}>
      <div className="chart-header" style={{ flexWrap: "wrap", gap: 8 }}>
        <div>
          <h3 className="chart-title">
            Pool: <span className="mono">{pool.role}</span> · {pool.gpu_type} (TP={pool.tp})
          </h3>
          <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
            Peak BF16={specs.tflops_peak} TF
            {hasFp8 ? ` · Peak FP8=${specs.tflops_fp8} TF` : ""} · HBM BW={specs.bw_peak_tbs} TB/s · Ridge=
            {ridgeBf16.toFixed(1)}
            {hasFp8 ? ` / ${ridgeFp8.toFixed(1)} FP8` : ""} FLOP/B · Pods: {podsInPool.map((p) => p.podId).join(", ") || "none"}
          </div>
        </div>
        <div className="chart-legend">
          <span className="chart-legend-item">
            <span className="legend-swatch" style={{ background: PHASE_COLORS.prefill }} /> Prefill
          </span>
          <span className="chart-legend-item">
            <span className="legend-swatch" style={{ background: PHASE_COLORS.decode }} /> Decode
          </span>
          <span className="chart-legend-item">
            <span className="legend-swatch" style={{ background: PHASE_COLORS.mixed }} /> Mixed
          </span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        style={{ width: "100%", height: "auto", display: "block", background: "var(--bg-inset)", borderRadius: 6 }}
        role="img"
        aria-label={`Hardware roofline plot for ${pool.role} pool (${pool.gpu_type})`}
      >
        {/* Log Gridlines */}
        {yTicks.map((v) => {
          const y = mapY(v);
          return (
            <g key={`y-${v}`}>
              <line x1={PAD_L} y1={y} x2={PAD_L + PLOT_W} y2={y} stroke="#1f2b3e" strokeWidth={1} />
              <text
                x={PAD_L - 8}
                y={y + 3.5}
                textAnchor="end"
                fill="#6c7f9c"
                fontSize={10}
                fontFamily="var(--font-mono)"
              >
                {v >= 1 ? v.toFixed(0) : v.toString()}
              </text>
            </g>
          );
        })}
        {xTicks.map((v) => {
          const x = mapX(v);
          return (
            <g key={`x-${v}`}>
              <line x1={x} y1={PAD_T} x2={x} y2={PAD_T + PLOT_H} stroke="#1f2b3e" strokeWidth={1} />
              <text
                x={x}
                y={PAD_T + PLOT_H + 16}
                textAnchor="middle"
                fill="#6c7f9c"
                fontSize={10}
                fontFamily="var(--font-mono)"
              >
                {v >= 1 ? v.toFixed(0) : v.toString()}
              </text>
            </g>
          );
        })}

        {/* Plot Frame */}
        <rect
          x={PAD_L}
          y={PAD_T}
          width={PLOT_W}
          height={PLOT_H}
          fill="none"
          stroke="#2f415d"
          strokeWidth={1}
        />

        {/* Axis Titles */}
        <text
          x={PAD_L + PLOT_W / 2}
          y={SVG_H - 8}
          textAnchor="middle"
          fill="#9fb0c9"
          fontSize={11}
          fontFamily="var(--font-sans)"
        >
          Arithmetic Intensity (FLOPs / Byte, log10)
        </text>
        <text
          x={16}
          y={PAD_T + PLOT_H / 2}
          textAnchor="middle"
          fill="#9fb0c9"
          fontSize={11}
          fontFamily="var(--font-sans)"
          transform={`rotate(-90 16 ${PAD_T + PLOT_H / 2})`}
        >
          Performance (TFLOP/s, log10)
        </text>

        {/* Vertical Ridge Point Dashed Lines */}
        <line
          x1={ridgeBf16X}
          y1={PAD_T}
          x2={ridgeBf16X}
          y2={PAD_T + PLOT_H}
          stroke="#64748b"
          strokeWidth={1.25}
          strokeDasharray="4 4"
        />
        <text
          x={ridgeBf16X - 4}
          y={PAD_T + PLOT_H - 6}
          textAnchor="end"
          fill="#9fb0c9"
          fontSize={9.5}
          fontFamily="var(--font-mono)"
        >
          Ridge {ridgeBf16.toFixed(0)}
        </text>

        {hasFp8 && (
          <>
            <line
              x1={ridgeFp8X}
              y1={PAD_T}
              x2={ridgeFp8X}
              y2={PAD_T + PLOT_H}
              stroke="#f59e0b"
              strokeWidth={1.2}
              strokeDasharray="4 4"
              strokeOpacity={0.75}
            />
            <text
              x={ridgeFp8X + 4}
              y={PAD_T + PLOT_H - 6}
              textAnchor="start"
              fill="#f59e0b"
              fontSize={9.5}
              fontFamily="var(--font-mono)"
            >
              FP8 Ridge {ridgeFp8.toFixed(0)}
            </text>
          </>
        )}

        {/* HBM Bandwidth Diagonal + BF16 Compute Peak Ceiling */}
        <polyline
          fill="none"
          stroke="#58a6ff"
          strokeWidth={2}
          points={bf16PathPoints}
        />
        <text
          x={PAD_L + PLOT_W - 6}
          y={mapY(bf16Peak) - 5}
          textAnchor="end"
          fill="#58a6ff"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          BF16 Peak: {bf16Peak} TF
        </text>
        <text
          x={mapX(bwStartAi) + 10}
          y={mapY(bwStartY) - 10}
          fill="#58a6ff"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          HBM BW: {bwTbs} TB/s
        </text>

        {/* FP8 Compute Ceiling */}
        {fp8PathPoints && (
          <>
            <polyline
              fill="none"
              stroke="#f59e0b"
              strokeWidth={1.75}
              strokeDasharray="6 3"
              points={fp8PathPoints}
            />
            <text
              x={PAD_L + PLOT_W - 6}
              y={mapY(fp8Peak) - 5}
              textAnchor="end"
              fill="#f59e0b"
              fontSize={10}
              fontFamily="var(--font-mono)"
            >
              FP8 Peak: {fp8Peak} TF
            </text>
          </>
        )}

        {/* Batch Step Points */}
        {points.map((pt) => {
          const key = pointKey(pt);
          const isCurrent = activeKeys.has(key);
          const isSelected = selectedPoint !== null && pointKey(selectedPoint) === key;
          const cx = mapX(pt.roofline.arithmetic_intensity);
          const cy = mapY(pt.roofline.achieved_tflops);
          const fill = PHASE_COLORS[pt.phase] ?? "#e6edf7";
          const r = isCurrent ? 6.5 : 3.8;

          return (
            <g key={key}>
              {isCurrent && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={10.5}
                  fill="none"
                  stroke={fill}
                  strokeWidth={1.6}
                  strokeOpacity={0.65}
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill={fill}
                fillOpacity={isCurrent || isSelected ? 1 : 0.72}
                stroke={isSelected ? "#ffffff" : isCurrent ? "#090d14" : "none"}
                strokeWidth={isSelected ? 2 : 1.2}
                style={{ cursor: "pointer" }}
                data-testid={`roofline-point-${pt.podId}-${pt.batchId}`}
                onMouseEnter={() => onHoverPoint(pt)}
                onMouseLeave={() => onHoverPoint(null)}
                onClick={() => onSelectPoint(pt)}
              >
                <title>
                  {`${pt.podId} batch #${pt.batchId} (${pt.phase}): AI=${pt.roofline.arithmetic_intensity.toFixed(2)}, ${pt.roofline.achieved_tflops.toFixed(2)} TF (${pt.roofline.bottleneck})`}
                </title>
              </circle>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

export const RooflineView: React.FC<RooflineViewProps> = ({
  state,
  podFilter = "",
  onSeekUs
}) => {
  const [hoveredPoint, setHoveredPoint] = useState<RooflineHistoryEntry | null>(null);
  const [selectedPoint, setSelectedPoint] = useState<RooflineHistoryEntry | null>(null);

  const allPods = useMemo(() => selectPods(state), [state]);
  const matchingPods = useMemo(() => {
    const q = podFilter.trim().toLowerCase();
    if (!q) return allPods;
    return allPods.filter((p) => p.podId.toLowerCase().includes(q));
  }, [allPods, podFilter]);

  const exactFilteredPod = useMemo(() => {
    const trimmed = podFilter.trim();
    if (!trimmed) return undefined;
    return state.pods.get(trimmed);
  }, [state, podFilter]);

  const allPoints = useMemo(() => {
    const raw = selectRooflinePoints(state, exactFilteredPod?.podId);
    const podQ = podFilter.trim().toLowerCase();
    const filtered = podQ
      ? raw.filter((pt) => pt.podId.toLowerCase().includes(podQ))
      : raw;

    // Ensure each matching pod's current lastBatchStep is always present in the plotted set
    const byKey = new Map<string, RooflineHistoryEntry>();
    for (const pt of filtered) {
      byKey.set(pointKey(pt), pt);
    }
    for (const pod of matchingPods) {
      const last = pod.lastBatchStep;
      if (last) {
        const entry: RooflineHistoryEntry = {
          tUs: last.tUs,
          podId: pod.podId,
          batchId: last.batchId,
          phase: last.phase,
          totalTokens: last.totalTokens,
          prefillTokens: last.prefillTokens,
          decodeTokens: last.decodeTokens,
          durationUs: last.durationUs,
          roofline: last.roofline
        };
        byKey.set(pointKey(entry), entry);
      }
    }
    return Array.from(byKey.values()).sort((a, b) => a.tUs - b.tUs);
  }, [state, exactFilteredPod, podFilter, matchingPods]);

  const activeKeys = useMemo(() => {
    const set = new Set<string>();
    for (const pod of matchingPods) {
      if (pod.lastBatchStep) {
        set.add(`${pod.podId}:${pod.lastBatchStep.batchId}:${pod.lastBatchStep.tUs}`);
      }
    }
    return set;
  }, [matchingPods]);

  const inspectedPoint =
    hoveredPoint ?? selectedPoint ?? (allPoints.length > 0 ? allPoints[allPoints.length - 1] : null);

  const pools = state.header.topology.pools;
  const anyDerived = allPoints.length === 0 || allPoints.some((p) => p.roofline.derived);

  return (
    <div data-testid="view-roofline" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="view-header-row">
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Hardware Roofline (Compute vs HBM Bandwidth)</h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Per-batch step arithmetic intensity vs GPU peak TFLOP/s and HBM TB/s ceilings.
          </div>
        </div>
        <SourceLinksChip
          glossaryTerm="AI"
          links={[
            { path: "sim/roofline.go", label: "Roofline Model", glossaryTerm: "AI" },
            { path: "sim/engine_driver.go", label: "Batch Step Driver" }
          ]}
        />
      </div>

      {/* Analytical Derivation Notice (derived: true) */}
      <div
        className="panel-card"
        data-testid="roofline-derived-notice"
        style={{
          borderColor: "rgba(245, 158, 11, 0.45)",
          background: "rgba(245, 158, 11, 0.08)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap"
        }}
      >
        <div style={{ flex: "1 1 420px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span className="badge badge-prefill mono">derived: {String(anyDerived)}</span>
            <strong style={{ fontSize: 13 }}>Analytical Roofline Notice</strong>
            <InfoHint term="AI" />
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            BLIS models step latency (<code className="mono">duration_us</code>) via calibrated kernel
            coefficients, while per-step FLOPs (<code className="mono">flops</code>) and HBM bytes moved (
            <code className="mono">bytes_moved</code>) are <strong>analytically derived</strong> from the model
            graph. Hover or click any <code className="mono">batch.step</code> dot below to inspect its exact
            arithmetic intensity and bottleneck regime.
          </div>
        </div>
        <div className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          Plotted steps: <strong style={{ color: "var(--text-primary)" }}>{allPoints.length}</strong> · Highlighted
          active rings: <strong style={{ color: "var(--text-primary)" }}>{activeKeys.size}</strong>
        </div>
      </div>

      {/* Per-Pool Roofline Plots */}
      <div className="charts-grid roofline-charts-grid">
        {pools.map((pool, poolIdx) => {
          const podsInPool = matchingPods.filter((p) => p.poolRole === pool.role);
          const podIdsInPool = new Set(podsInPool.map((p) => p.podId));
          const poolPoints = allPoints.filter((pt) => podIdsInPool.has(pt.podId));

          return (
            <PoolRooflineChart
              key={`${pool.role}-${poolIdx}`}
              pool={pool}
              poolIndex={poolIdx}
              podsInPool={podsInPool}
              points={poolPoints}
              activeKeys={activeKeys}
              selectedPoint={selectedPoint}
              onHoverPoint={setHoveredPoint}
              onSelectPoint={setSelectedPoint}
            />
          );
        })}
      </div>

      {/* Step Point Inspector Panel */}
      <div className="panel-card" data-testid="roofline-point-inspector">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginBottom: 8,
            flexWrap: "wrap"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 13.5 }}>
              {hoveredPoint
                ? "Hovered Batch Step"
                : selectedPoint
                  ? "Selected Batch Step"
                  : "Latest Batch Step"}
            </h3>
            {inspectedPoint && (
              <>
                <span className={`badge badge-${inspectedPoint.phase === "mixed" ? "transfer" : inspectedPoint.phase}`}>
                  {inspectedPoint.phase}
                </span>
                <span
                  className={`badge ${
                    inspectedPoint.roofline.bottleneck === "compute" ? "badge-prefill" : "badge-decode"
                  } mono`}
                >
                  bottleneck: {inspectedPoint.roofline.bottleneck}
                </span>
                <span className="badge badge-neutral mono">
                  derived={String(inspectedPoint.roofline.derived)}
                </span>
              </>
            )}
          </div>

          {inspectedPoint && onSeekUs && (
            <button
              type="button"
              data-testid="roofline-seek-step"
              onClick={() => onSeekUs(inspectedPoint.tUs)}
            >
              Seek to {formatMs(inspectedPoint.tUs)}
            </button>
          )}
        </div>

        {!inspectedPoint ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            No <code className="mono">batch.step</code> events observed up to {formatMs(state.tUs)}. Scrub forward or
            press Play to plot batch execution points.
          </div>
        ) : (
          <div
            className="mono"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
              gap: "8px 14px",
              fontSize: 12
            }}
          >
            <div>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>pod_id / batch_id</div>
              <div>
                {inspectedPoint.podId} · #{inspectedPoint.batchId}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>t_us / duration_us</div>
              <div>
                {formatMs(inspectedPoint.tUs)} ({(inspectedPoint.durationUs / 1000).toFixed(2)} ms)
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>tokens (prefill + decode)</div>
              <div>
                {inspectedPoint.totalTokens} ({inspectedPoint.prefillTokens}p + {inspectedPoint.decodeTokens}d)
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>flops</div>
              <div>{formatSci(inspectedPoint.roofline.flops)}FLOPs</div>
            </div>
            <div>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>bytes_moved</div>
              <div>{formatBytesSI(inspectedPoint.roofline.bytes_moved)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>arithmetic_intensity</div>
              <div>{inspectedPoint.roofline.arithmetic_intensity.toFixed(2)} FLOP/B</div>
            </div>
            <div>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>achieved_tflops</div>
              <div>{inspectedPoint.roofline.achieved_tflops.toFixed(2)} TF/s</div>
            </div>
            <div>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>achieved_bw_tbs</div>
              <div>{inspectedPoint.roofline.achieved_bw_tbs.toFixed(3)} TB/s</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
