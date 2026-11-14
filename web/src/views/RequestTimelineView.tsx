import React, { useEffect, useMemo, useState } from "react";
import { SourceLinksChip } from "../components/SourceLinksChip.js";
import {
  selectRequests,
  type ReplayTimeline,
  type RequestLifecycleState,
  type RequestPhaseName,
  type SimState
} from "../replay/index.js";

export interface RequestTimelineViewProps {
  timeline: ReplayTimeline;
  state: SimState;
  tUs: number;
  reqFilter: string;
  podFilter: string;
  onSeekUs: (tUs: number) => void;
  onSelectPod?: (podId: string) => void;
}

const PAGE_SIZE = 60;
const SVG_W = 980;
const LABEL_W = 195;
const PAD_R = 20;
const PLOT_W = SVG_W - LABEL_W - PAD_R;
const HEADER_H = 28;
const ROW_H = 22;
const FOOTER_H = 14;

type VisualPhaseGroup = "gateway_wait" | "queued" | "prefill" | "kv_transfer" | "decode";

const PHASE_LEGEND: ReadonlyArray<{
  key: VisualPhaseGroup;
  label: string;
  color: string;
}> = [
  { key: "gateway_wait", label: "gateway_wait", color: "#64748b" },
  { key: "queued", label: "queued", color: "#f97316" },
  { key: "prefill", label: "prefill", color: "#f59e0b" },
  { key: "kv_transfer", label: "kv_transfer", color: "#c084fc" },
  { key: "decode", label: "decode", color: "#38bdf8" }
];

function classifyPhase(phase: RequestPhaseName): VisualPhaseGroup | null {
  switch (phase) {
    case "arrived":
    case "admitted":
    case "routed":
      return "gateway_wait";
    case "queued":
    case "scheduled":
      return "queued";
    case "prefill":
      return "prefill";
    case "kv_transfer":
      return "kv_transfer";
    case "decode":
      return "decode";
    default:
      return null;
  }
}

function phaseColor(group: VisualPhaseGroup): string {
  switch (group) {
    case "gateway_wait":
      return "#64748b";
    case "queued":
      return "#f97316";
    case "prefill":
      return "#f59e0b";
    case "kv_transfer":
      return "#c084fc";
    case "decode":
      return "#38bdf8";
  }
}

function formatMs(us?: number): string {
  if (us === undefined) return "—";
  return `${(us / 1000).toFixed(2)} ms`;
}

function matchesPodFilter(req: RequestLifecycleState, podQ: string): boolean {
  if (!podQ) return true;
  const pods = [req.assignedPod, req.prefillPod, req.decodePod].filter(Boolean) as string[];
  if (pods.some((p) => p.toLowerCase().includes(podQ))) return true;
  return req.phases.some((ph) => ph.podId?.toLowerCase().includes(podQ) ?? false);
}

export const RequestTimelineView: React.FC<RequestTimelineViewProps> = ({
  timeline,
  state,
  tUs,
  reqFilter,
  podFilter,
  onSeekUs,
  onSelectPod
}) => {
  const [onlyArrivedToCursor, setOnlyArrivedToCursor] = useState(false);
  const [page, setPage] = useState(0);
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);

  const fullHorizonState = useMemo(
    () => timeline.stateAt(timeline.durationUs),
    [timeline]
  );

  const sourceRequests = useMemo(() => {
    const baseState = onlyArrivedToCursor ? state : fullHorizonState;
    return selectRequests(baseState).sort((a, b) => a.arrivedAtUs - b.arrivedAtUs);
  }, [onlyArrivedToCursor, state, fullHorizonState]);

  const filteredRequests = useMemo(() => {
    const rq = reqFilter.trim().toLowerCase();
    const pq = podFilter.trim().toLowerCase();
    return sourceRequests.filter((req) => {
      if (rq && !req.reqId.toLowerCase().includes(rq)) return false;
      if (pq && !matchesPodFilter(req, pq)) return false;
      return true;
    });
  }, [sourceRequests, reqFilter, podFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRequests.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages - 1);

  useEffect(() => {
    if (page !== clampedPage) {
      setPage(clampedPage);
    }
  }, [page, clampedPage]);

  const visibleRequests = useMemo(() => {
    const start = clampedPage * PAGE_SIZE;
    return filteredRequests.slice(start, start + PAGE_SIZE);
  }, [filteredRequests, clampedPage]);

  const selectedRequest = useMemo(() => {
    if (!selectedReqId) return visibleRequests[0];
    return (
      filteredRequests.find((r) => r.reqId === selectedReqId) ??
      visibleRequests[0]
    );
  }, [selectedReqId, filteredRequests, visibleRequests]);

  const safeDuration = Math.max(1, timeline.durationUs);
  const mapX = (ts: number) => LABEL_W + (Math.max(0, Math.min(ts, safeDuration)) / safeDuration) * PLOT_W;
  const cursorX = mapX(tUs);
  const svgH = HEADER_H + Math.max(1, visibleRequests.length) * ROW_H + FOOTER_H;

  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * SVG_W;
    if (svgX < LABEL_W) return;
    const ratio = Math.max(0, Math.min(1, (svgX - LABEL_W) / PLOT_W));
    onSeekUs(Math.round(ratio * safeDuration));
  };

  const xTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div data-testid="view-request-timeline" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 10
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Request Phase Waterfall (Gantt)</h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Click anywhere on the chart to seek playback · Click a request row to inspect TTFT / TPOT / E2E &amp; cache hits.
          </div>
        </div>
        <SourceLinksChip
          glossaryTerm="TTFT"
          links={[
            { path: "sim/engine_driver.go", label: "Engine Driver", glossaryTerm: "Continuous Batching" },
            { path: "sim/request.go", label: "Request Lifecycle", glossaryTerm: "TTFT" }
          ]}
        />
      </div>

      {/* Legend & Pagination Controls */}
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
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, fontSize: 11.5 }}>
          {PHASE_LEGEND.map((item) => (
            <span key={item.key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: item.color,
                  display: "inline-block"
                }}
              />
              {item.label}
            </span>
          ))}
          <span style={{ color: "var(--sem-preempted)" }}>◆ preempted</span>
          <span style={{ color: "var(--sem-evicted)" }}>✕ rejected</span>
          <span style={{ color: "var(--sem-draining)" }}>■ timed_out</span>
          <span style={{ color: "var(--sem-ready)" }}>● finished</span>
          <span className="badge badge-cached">⚡ prefix cached</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={onlyArrivedToCursor}
              onChange={(e) => {
                setOnlyArrivedToCursor(e.target.checked);
                setPage(0);
              }}
            />
            Only arrived ≤ cursor
          </label>

          <span className="mono" style={{ color: "var(--text-secondary)" }}>
            {filteredRequests.length} reqs
          </span>

          {totalPages > 1 && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                disabled={clampedPage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Prev
              </button>
              <span className="mono">
                {clampedPage + 1}/{totalPages}
              </span>
              <button
                type="button"
                disabled={clampedPage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>

      {/* SVG Gantt Waterfall */}
      <div className="panel-card" style={{ padding: 10, overflowX: "auto" }}>
        {visibleRequests.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--text-secondary)" }}>
            No requests match the current filter{onlyArrivedToCursor ? " up to current cursor" : ""}.
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${SVG_W} ${svgH}`}
            style={{ width: "100%", minWidth: 780, height: "auto", display: "block", cursor: "crosshair" }}
            onClick={handleSvgClick}
            role="img"
            aria-label="Request lifecycle phase waterfall Gantt chart"
          >
            {/* Time axis header & gridlines */}
            {xTicks.map((frac) => {
              const x = LABEL_W + PLOT_W * frac;
              const ms = (safeDuration * frac) / 1000;
              return (
                <g key={frac}>
                  <line
                    x1={x}
                    y1={HEADER_H - 4}
                    x2={x}
                    y2={svgH - FOOTER_H}
                    stroke="#1f2b3e"
                    strokeWidth={1}
                  />
                  <text
                    x={x}
                    y={16}
                    textAnchor={frac === 1 ? "end" : "middle"}
                    fill="#6c7f9c"
                    fontSize={10.5}
                    fontFamily="var(--font-mono)"
                  >
                    {ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`}
                  </text>
                </g>
              );
            })}

            {/* Request rows */}
            {visibleRequests.map((req, rowIdx) => {
              const rowTop = HEADER_H + rowIdx * ROW_H;
              const barY = rowTop + 4;
              const barH = 13;
              const midY = barY + barH / 2;
              const isSelected = selectedRequest?.reqId === req.reqId;
              const hasCached = req.cachedTokens > 0 || req.cpuHitTokens > 0;
              const isFuture = req.arrivedAtUs > tUs;

              return (
                <g
                  key={req.reqId}
                  data-testid={`timeline-row-${req.reqId}`}
                  opacity={isFuture ? 0.42 : 1}
                >
                  {/* Row background */}
                  <rect
                    x={0}
                    y={rowTop}
                    width={SVG_W}
                    height={ROW_H}
                    fill={
                      isSelected
                        ? "rgba(88, 166, 255, 0.14)"
                        : rowIdx % 2 === 0
                          ? "rgba(11, 16, 25, 0.45)"
                          : "transparent"
                    }
                  />

                  {/* Clickable Request Label */}
                  <g
                    style={{ cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedReqId(req.reqId);
                    }}
                  >
                    <rect x={0} y={rowTop} width={LABEL_W - 4} height={ROW_H} fill="transparent" />
                    <text
                      x={8}
                      y={rowTop + 15}
                      fill={isSelected ? "#cfe6ff" : "#e6edf7"}
                      fontSize={11}
                      fontWeight={isSelected ? 700 : 500}
                      fontFamily="var(--font-mono)"
                    >
                      {req.reqId}
                    </text>
                    {hasCached && (
                      <g>
                        <rect
                          x={LABEL_W - 58}
                          y={rowTop + 4}
                          width={50}
                          height={14}
                          rx={7}
                          fill="rgba(16, 185, 129, 0.18)"
                        />
                        <text
                          x={LABEL_W - 33}
                          y={rowTop + 14}
                          textAnchor="middle"
                          fill="#10b981"
                          fontSize={9.5}
                          fontWeight={700}
                        >
                          ⚡cache
                        </text>
                      </g>
                    )}
                  </g>

                  {/* Phase spans */}
                  {req.phases.map((span, sIdx) => {
                    const group = classifyPhase(span.phase);
                    if (group) {
                      const x1 = mapX(span.startUs);
                      const endUs = span.endUs ?? Math.max(span.startUs, timeline.durationUs);
                      const x2 = mapX(endUs);
                      const w = Math.max(2, x2 - x1);
                      return (
                        <rect
                          key={`${span.phase}-${sIdx}`}
                          x={x1}
                          y={barY}
                          width={w}
                          height={barH}
                          rx={2}
                          fill={phaseColor(group)}
                          opacity={0.9}
                        >
                          <title>
                            {`${req.reqId} · ${span.phase} (${formatMs(span.startUs)} → ${formatMs(endUs)})${span.podId ? ` on ${span.podId}` : ""}`}
                          </title>
                        </rect>
                      );
                    }

                    // Point markers: preempted, rejected, timed_out, finished
                    const mx = mapX(span.startUs);
                    if (span.phase === "preempted") {
                      return (
                        <polygon
                          key={`mk-${sIdx}`}
                          points={`${mx},${midY - 5} ${mx + 5},${midY} ${mx},${midY + 5} ${mx - 5},${midY}`}
                          fill="#ef4444"
                          stroke="#090d14"
                          strokeWidth={1}
                        >
                          <title>{`Preempted at ${formatMs(span.startUs)}`}</title>
                        </polygon>
                      );
                    }
                    if (span.phase === "rejected") {
                      return (
                        <g key={`mk-${sIdx}`} stroke="#fb7185" strokeWidth={2}>
                          <line x1={mx - 4} y1={midY - 4} x2={mx + 4} y2={midY + 4} />
                          <line x1={mx + 4} y1={midY - 4} x2={mx - 4} y2={midY + 4} />
                          <title>{`Rejected at ${formatMs(span.startUs)}`}</title>
                        </g>
                      );
                    }
                    if (span.phase === "timed_out") {
                      return (
                        <rect
                          key={`mk-${sIdx}`}
                          x={mx - 4}
                          y={midY - 4}
                          width={8}
                          height={8}
                          fill="#f97316"
                          stroke="#090d14"
                          strokeWidth={1}
                        >
                          <title>{`Timed out at ${formatMs(span.startUs)}`}</title>
                        </rect>
                      );
                    }
                    if (span.phase === "finished") {
                      return (
                        <circle
                          key={`mk-${sIdx}`}
                          cx={mx}
                          cy={midY}
                          r={4}
                          fill="#22c55e"
                          stroke="#090d14"
                          strokeWidth={1}
                        >
                          <title>{`Finished at ${formatMs(span.startUs)}`}</title>
                        </circle>
                      );
                    }
                    return null;
                  })}
                </g>
              );
            })}

            {/* Current Time Cursor */}
            <line
              x1={cursorX}
              y1={HEADER_H - 6}
              x2={cursorX}
              y2={svgH - FOOTER_H}
              stroke="#e6edf7"
              strokeWidth={1.6}
              strokeDasharray="3,3"
            />
          </svg>
        )}
      </div>

      {/* Selected Request Detail Card */}
      {selectedRequest && (
        <div className="panel-card" data-testid="request-detail-card">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 10
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <strong className="mono" style={{ fontSize: 14 }}>
                {selectedRequest.reqId}
              </strong>
              <span
                className={`badge badge-${
                  selectedRequest.status === "finished"
                    ? "ready"
                    : selectedRequest.status === "preempted"
                      ? "preempted"
                      : selectedRequest.status === "rejected"
                        ? "evicted"
                        : selectedRequest.status === "kv_transfer"
                          ? "transfer"
                          : selectedRequest.status === "decode"
                            ? "decode"
                            : selectedRequest.status === "prefill"
                              ? "prefill"
                              : "neutral"
                }`}
              >
                {selectedRequest.status}
              </span>
              {selectedRequest.cachedTokens > 0 && (
                <span className="badge badge-cached mono">
                  cached {selectedRequest.cachedTokens} tok
                </span>
              )}
              {selectedRequest.cpuHitTokens > 0 && (
                <span className="badge badge-cpu_dram mono">
                  cpu_hit {selectedRequest.cpuHitTokens} tok
                </span>
              )}
              {selectedRequest.preemptionCount > 0 && (
                <span className="badge badge-preempted mono">
                  preempted ×{selectedRequest.preemptionCount}
                </span>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {selectedRequest.assignedPod && (
                <button
                  type="button"
                  onClick={() => onSelectPod?.(selectedRequest.assignedPod!)}
                  className="mono"
                >
                  pod: {selectedRequest.assignedPod}
                </button>
              )}
              {selectedRequest.prefillPod && (
                <button
                  type="button"
                  onClick={() => onSelectPod?.(selectedRequest.prefillPod!)}
                  className="mono"
                >
                  P: {selectedRequest.prefillPod}
                </button>
              )}
              {selectedRequest.decodePod && (
                <button
                  type="button"
                  onClick={() => onSelectPod?.(selectedRequest.decodePod!)}
                  className="mono"
                >
                  D: {selectedRequest.decodePod}
                </button>
              )}
              <button type="button" onClick={() => onSeekUs(selectedRequest.arrivedAtUs)}>
                Seek to arrival
              </button>
            </div>
          </div>

          <div className="kpi-grid" style={{ marginBottom: 10 }}>
            <div className="kpi-card">
              <div className="kpi-label">TTFT</div>
              <div className="kpi-value mono" style={{ fontSize: 16 }}>
                {formatMs(selectedRequest.ttftUs)}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">TPOT</div>
              <div className="kpi-value mono" style={{ fontSize: 16 }}>
                {formatMs(selectedRequest.tpotUs)}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">E2E Latency</div>
              <div className="kpi-value mono" style={{ fontSize: 16 }}>
                {formatMs(selectedRequest.e2eUs)}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Tokens (Out / Max)</div>
              <div className="kpi-value mono" style={{ fontSize: 16 }}>
                {selectedRequest.emittedTokens} / {selectedRequest.maxOutputTokens}
              </div>
              <div className="kpi-sub mono">prompt {selectedRequest.promptTokens}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Cache Hits</div>
              <div className="kpi-value mono" style={{ fontSize: 16, color: "var(--sem-cached)" }}>
                {selectedRequest.cachedTokens} / {selectedRequest.cpuHitTokens}
              </div>
              <div className="kpi-sub">GPU cached / CPU hit</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Preemptions</div>
              <div
                className="kpi-value mono"
                style={{
                  fontSize: 16,
                  color: selectedRequest.preemptionCount > 0 ? "var(--sem-preempted)" : undefined
                }}
              >
                {selectedRequest.preemptionCount}
              </div>
              <div className="kpi-sub">
                {selectedRequest.finishReason
                  ? `finish: ${selectedRequest.finishReason}`
                  : selectedRequest.rejectReason
                    ? `reject: ${selectedRequest.rejectReason}`
                    : selectedRequest.timeoutStage
                      ? `timeout: ${selectedRequest.timeoutStage}`
                      : "in progress"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 11.5 }}>
            {selectedRequest.phases.map((ph, idx) => (
              <span
                key={`${ph.phase}-${idx}`}
                className="mono"
                style={{
                  padding: "3px 7px",
                  borderRadius: 6,
                  background: "var(--bg-inset)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-secondary)"
                }}
              >
                <strong style={{ color: "var(--text-primary)" }}>{ph.phase}</strong>{" "}
                {(ph.startUs / 1000).toFixed(1)}
                {ph.endUs !== undefined ? `→${(ph.endUs / 1000).toFixed(1)}` : "+"}ms
                {ph.podId ? ` (${ph.podId})` : ""}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
