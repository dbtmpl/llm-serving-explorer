import React, { useMemo, useState } from "react";
import type { CandidateScore } from "@llm-viz/schema";
import { SourceLinksChip } from "../components/SourceLinksChip.js";
import {
  selectPods,
  selectRoutingHistory,
  type ReplayTimeline,
  type RequestRoutingInfo,
  type SimState
} from "../replay/index.js";

export interface RoutingExplainedViewProps {
  timeline: ReplayTimeline;
  state: SimState;
  tUs: number;
  reqFilter: string;
  podFilter: string;
  onSeekUs: (tUs: number) => void;
  onSelectPod?: (podId: string) => void;
}

type RoutingDecisionEntry = RequestRoutingInfo & { readonly reqId: string };

const POD_PALETTE = [
  "#58a6ff",
  "#10b981",
  "#f59e0b",
  "#c084fc",
  "#38bdf8",
  "#fb7185",
  "#14b8a6",
  "#f97316"
];

function buildCandidateRows(decision: RoutingDecisionEntry): readonly CandidateScore[] {
  if (decision.candidates && decision.candidates.length > 0) {
    return decision.candidates.slice().sort((a, b) => b.score - a.score);
  }
  if (decision.scores) {
    return Object.entries(decision.scores)
      .filter((entry): entry is [string, number] => entry[1] !== undefined)
      .map(([pod_id, score]) => ({
        pod_id,
        score,
        queue_depth: 0,
        batch_size: 0,
        kv_utilization: 0,
        free_kv_blocks: 0
      }))
      .sort((a, b) => b.score - a.score);
  }
  return [];
}

export const RoutingExplainedView: React.FC<RoutingExplainedViewProps> = ({
  state,
  reqFilter,
  podFilter,
  onSeekUs,
  onSelectPod
}) => {
  const [selectedReqId, setSelectedReqId] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = useState(true);
  const [seekOnClick, setSeekOnClick] = useState(false);

  const allDecisions = useMemo(() => selectRoutingHistory(state), [state]);
  const pods = useMemo(() => selectPods(state), [state]);

  const filteredDecisions = useMemo(() => {
    const rq = reqFilter.trim().toLowerCase();
    const pq = podFilter.trim().toLowerCase();
    const list = allDecisions.filter((d) => {
      if (rq && !d.reqId.toLowerCase().includes(rq)) return false;
      if (pq) {
        const hitPod =
          d.chosenPod.toLowerCase().includes(pq) ||
          (d.prefillPod?.toLowerCase().includes(pq) ?? false) ||
          (d.decodePod?.toLowerCase().includes(pq) ?? false);
        if (!hitPod) return false;
      }
      return true;
    });
    return newestFirst ? list.slice().reverse() : list;
  }, [allDecisions, reqFilter, podFilter, newestFirst]);

  const selectedDecision = useMemo(() => {
    if (selectedReqId) {
      const found = filteredDecisions.find((d) => d.reqId === selectedReqId);
      if (found) return found;
    }
    return newestFirst ? filteredDecisions[0] : filteredDecisions[filteredDecisions.length - 1];
  }, [selectedReqId, filteredDecisions, newestFirst]);

  // Per-pod routing distribution across all routed requests up to tUs
  const distribution = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pod of pods) {
      counts.set(pod.podId, 0);
    }
    for (const d of allDecisions) {
      counts.set(d.chosenPod, (counts.get(d.chosenPod) ?? 0) + 1);
    }
    const total = allDecisions.length;
    const rows = Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([podId, count], idx) => ({
        podId,
        count,
        pct: total > 0 ? (count / total) * 100 : 0,
        color: POD_PALETTE[idx % POD_PALETTE.length]
      }));
    return { total, rows };
  }, [allDecisions, pods]);

  const candidates = useMemo(
    () => (selectedDecision ? buildCandidateRows(selectedDecision) : []),
    [selectedDecision]
  );

  const maxScore = useMemo(() => {
    let maxVal = 1e-6;
    for (const c of candidates) {
      if (c.score > maxVal) maxVal = c.score;
    }
    return maxVal;
  }, [candidates]);

  const regretCount = useMemo(
    () => allDecisions.filter((d) => (d.regret ?? 0) > 0).length,
    [allDecisions]
  );

  return (
    <div data-testid="view-routing-explained" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
          <h2 style={{ margin: 0, fontSize: 15 }}>llm-d Routing Explained (Endpoint Picker)</h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Inspect candidate scores, queue depth, KV utilization, and routing regret up to current cursor.
          </div>
        </div>
        <SourceLinksChip
          glossaryTerm="EPP"
          links={[
            { path: "sim/cluster/gateway.go", label: "Cluster Gateway" },
            { path: "sim/llmd/gateway.go", label: "llm-d EPP Scorer", glossaryTerm: "EPP" }
          ]}
        />
      </div>

      {/* Per-pod Routing Distribution Summary Bar */}
      <div className="panel-card" data-testid="routing-distribution-summary">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 8
          }}
        >
          <strong style={{ fontSize: 12.5 }}>
            Per-Pod Routing Distribution ({distribution.total} routed up to t)
          </strong>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
            Non-zero regret decisions:{" "}
            <strong style={{ color: regretCount > 0 ? "var(--sem-prefill)" : "var(--sem-ready)" }}>
              {regretCount}
            </strong>
          </span>
        </div>

        <div className="hbm-bar-track" style={{ height: 20, marginBottom: 8 }}>
          {distribution.rows.map((r) =>
            r.count > 0 ? (
              <div
                key={r.podId}
                className="hbm-segment"
                style={{
                  width: `${r.pct}%`,
                  background: r.color
                }}
                title={`${r.podId}: ${r.count} requests (${r.pct.toFixed(1)}%)`}
              />
            ) : null
          )}
        </div>

        <div className="hbm-legend">
          {distribution.rows.map((r) => (
            <button
              key={r.podId}
              type="button"
              onClick={() => onSelectPod?.(r.podId)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "2px 8px",
                fontSize: 11.5
              }}
            >
              <span className="legend-swatch" style={{ background: r.color }} />
              <span className="mono">{r.podId}</span>
              <span className="mono" style={{ color: "var(--text-secondary)" }}>
                {r.count} ({r.pct.toFixed(0)}%)
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Left / Right Split */}
      <div className="routing-split-grid">
        {/* Left: Routing Decisions List */}
        <div className="panel-card" style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid var(--border-subtle)",
              background: "var(--bg-elevated)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap"
            }}
          >
            <strong style={{ fontSize: 12 }}>Decisions ({filteredDecisions.length})</strong>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={newestFirst}
                  onChange={(e) => setNewestFirst(e.target.checked)}
                />
                Newest
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={seekOnClick}
                  onChange={(e) => setSeekOnClick(e.target.checked)}
                />
                Seek on click
              </label>
            </div>
          </div>

          <div style={{ maxHeight: 520, overflowY: "auto" }} data-testid="routing-decision-list">
            {filteredDecisions.length === 0 ? (
              <div style={{ padding: 18, color: "var(--text-secondary)", fontSize: 12 }}>
                No routing decisions recorded up to this timestamp. Scrub forward to inspect dispatches.
              </div>
            ) : (
              filteredDecisions.map((d) => {
                const isSelected = selectedDecision?.reqId === d.reqId;
                const hasRegret = (d.regret ?? 0) > 0;
                return (
                  <div
                    key={d.reqId}
                    data-testid={`routing-decision-item-${d.reqId}`}
                    onClick={() => {
                      setSelectedReqId(d.reqId);
                      if (seekOnClick) {
                        onSeekUs(d.tUs);
                      }
                    }}
                    style={{
                      padding: "8px 12px",
                      borderBottom: "1px solid var(--border-subtle)",
                      cursor: "pointer",
                      background: isSelected ? "var(--accent-primary-dim)" : "transparent",
                      display: "flex",
                      flexDirection: "column",
                      gap: 3
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <span className="mono" style={{ fontWeight: 600, fontSize: 12 }}>
                        {d.reqId}
                      </span>
                      <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {(d.tUs / 1000).toFixed(1)} ms
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <span className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                        → {d.chosenPod}
                        {d.disaggregate && d.decodePod ? ` (D:${d.decodePod})` : ""}
                      </span>
                      {hasRegret ? (
                        <span className="badge badge-preempted mono" style={{ fontSize: 10 }}>
                          regret {d.regret!.toFixed(2)}
                        </span>
                      ) : (
                        <span className="badge badge-ready mono" style={{ fontSize: 10 }}>
                          opt
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Candidate Inspector */}
        <div className="panel-card" data-testid="routing-inspector">
          {!selectedDecision ? (
            <div style={{ padding: 20, color: "var(--text-secondary)" }}>
              Select a routing decision on the left to inspect candidate scores.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Decision Header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 8,
                  paddingBottom: 10,
                  borderBottom: "1px solid var(--border-subtle)"
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong className="mono" style={{ fontSize: 15 }}>
                    {selectedDecision.reqId}
                  </strong>
                  <span className="badge badge-neutral mono">
                    t = {(selectedDecision.tUs / 1000).toFixed(2)} ms
                  </span>
                  <span className="badge badge-decode mono">
                    chosen: {selectedDecision.chosenPod}
                  </span>
                  {selectedDecision.disaggregate && (
                    <span className="badge badge-transfer mono">
                      P/D: {selectedDecision.prefillPod ?? selectedDecision.chosenPod} →{" "}
                      {selectedDecision.decodePod ?? "—"}
                    </span>
                  )}
                  {selectedDecision.reason && (
                    <span className="badge badge-neutral">{selectedDecision.reason}</span>
                  )}
                  {(selectedDecision.regret ?? 0) > 0 ? (
                    <span className="badge badge-preempted mono" data-testid="routing-regret-badge">
                      regret: {selectedDecision.regret!.toFixed(3)}
                    </span>
                  ) : (
                    <span className="badge badge-ready mono" data-testid="routing-regret-badge">
                      regret: 0 (optimal)
                    </span>
                  )}
                </div>

                <button type="button" onClick={() => onSeekUs(selectedDecision.tUs)}>
                  Seek to decision time
                </button>
              </div>

              {/* Candidate Score Horizontal Comparison Chart */}
              <div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 8
                  }}
                >
                  <strong style={{ fontSize: 13 }}>
                    Candidate Endpoints Comparison ({candidates.length})
                  </strong>
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                    Winning pod highlighted · Bars scaled to max score ({maxScore.toFixed(2)})
                  </span>
                </div>

                {candidates.length === 0 ? (
                  <div style={{ padding: 14, color: "var(--text-secondary)", background: "var(--bg-inset)", borderRadius: 6 }}>
                    No per-candidate score array recorded for this decision.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {candidates.map((cand) => {
                      const isWinner =
                        cand.pod_id === selectedDecision.chosenPod ||
                        cand.pod_id === selectedDecision.decodePod;
                      const scorePct = Math.max(0, Math.min(100, (cand.score / maxScore) * 100));
                      const kvPct = Math.max(0, Math.min(100, cand.kv_utilization * 100));

                      return (
                        <div
                          key={cand.pod_id}
                          data-testid={`candidate-bar-${cand.pod_id}`}
                          style={{
                            padding: 10,
                            borderRadius: 8,
                            background: isWinner ? "rgba(88, 166, 255, 0.08)" : "var(--bg-inset)",
                            border: isWinner
                              ? "1px solid var(--accent-primary)"
                              : "1px solid var(--border-subtle)"
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 8,
                              marginBottom: 6
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <button
                                type="button"
                                className="mono"
                                onClick={() => onSelectPod?.(cand.pod_id)}
                                style={{ padding: "2px 7px", fontSize: 12, fontWeight: 700 }}
                              >
                                {cand.pod_id}
                              </button>
                              {isWinner && (
                                <span className="badge badge-ready" style={{ fontSize: 10 }}>
                                  WINNING POD
                                </span>
                              )}
                            </div>
                            <span className="mono" style={{ fontWeight: 700, fontSize: 13 }}>
                              score {cand.score.toFixed(3)}
                            </span>
                          </div>

                          {/* Composite Score Horizontal Bar */}
                          <div
                            style={{
                              height: 12,
                              borderRadius: 4,
                              background: "#090d14",
                              border: "1px solid var(--border-subtle)",
                              overflow: "hidden",
                              marginBottom: 8
                            }}
                          >
                            <div
                              style={{
                                width: `${scorePct}%`,
                                height: "100%",
                                background: isWinner ? "#58a6ff" : "#475569",
                                transition: "width 150ms ease"
                              }}
                            />
                          </div>

                          {/* Candidate Telemetry Metrics */}
                          <div
                            className="mono"
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                              gap: 6,
                              fontSize: 11.5,
                              color: "var(--text-secondary)"
                            }}
                          >
                            <div>
                              queue_depth: <strong style={{ color: "var(--text-primary)" }}>{cand.queue_depth}</strong>
                            </div>
                            <div>
                              batch_size: <strong style={{ color: "var(--text-primary)" }}>{cand.batch_size}</strong>
                            </div>
                            <div>
                              kv_util: <strong style={{ color: "var(--text-primary)" }}>{kvPct.toFixed(1)}%</strong>
                            </div>
                            <div>
                              free_kv: <strong style={{ color: "var(--text-primary)" }}>{cand.free_kv_blocks}</strong>
                            </div>
                            {cand.in_flight_requests !== undefined && (
                              <div>
                                in_flight:{" "}
                                <strong style={{ color: "var(--text-primary)" }}>{cand.in_flight_requests}</strong>
                              </div>
                            )}
                          </div>

                          {/* Optional Scorer Breakdown */}
                          {cand.scorer_breakdown && Object.keys(cand.scorer_breakdown).length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                              {Object.entries(cand.scorer_breakdown).map(([name, val]) =>
                                val !== undefined ? (
                                  <span key={name} className="badge badge-neutral mono" style={{ fontSize: 10 }}>
                                    {name}: {val.toFixed(3)}
                                  </span>
                                ) : null
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
