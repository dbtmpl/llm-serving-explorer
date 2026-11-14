import React, { useMemo } from "react";
import type { KVTransferEvent } from "@llm-viz/schema";
import { SourceLinksChip } from "../components/SourceLinksChip.js";
import {
  selectActiveKVTransfers,
  selectPods,
  selectRequestsForPod,
  type PodState,
  type ReplayTimeline,
  type SimState
} from "../replay/index.js";

export interface PdSplitViewProps {
  timeline: ReplayTimeline;
  state: SimState;
  tUs: number;
  reqFilter?: string;
  podFilter?: string;
  onSeekUs?: (tUs: number) => void;
  onSelectPod?: (podId: string) => void;
  onSwitchScenario?: (scenarioId: string) => void;
}

interface TransferRecord {
  readonly key: string;
  readonly reqId: string;
  readonly fromPod: string;
  readonly toPod: string;
  readonly numKVBlocks: number;
  readonly pulledKVBlocks: number;
  readonly startedAtUs: number;
  readonly completedAtUs?: number;
  readonly durationUs: number;
  readonly status: "started" | "completed";
}

function getPodStatusBadgeClass(status: PodState["status"]): string {
  switch (status) {
    case "ready":
      return "badge-ready";
    case "loading":
      return "badge-prefill";
    case "draining":
      return "badge-draining";
    case "terminated":
      return "badge-neutral";
  }
}

export const PdSplitView: React.FC<PdSplitViewProps> = ({
  timeline,
  state,
  tUs,
  reqFilter = "",
  podFilter = "",
  onSeekUs,
  onSelectPod,
  onSwitchScenario
}) => {
  const pods = useMemo(() => selectPods(state), [state]);
  const activeTransfers = useMemo(() => selectActiveKVTransfers(state), [state]);

  const prefillPods = useMemo(
    () =>
      pods
        .filter((p) => p.poolRole === "prefill")
        .sort((a, b) => a.podId.localeCompare(b.podId)),
    [pods]
  );

  const decodePods = useMemo(
    () =>
      pods
        .filter((p) => p.poolRole === "decode")
        .sort((a, b) => a.podId.localeCompare(b.podId)),
    [pods]
  );

  const isDisaggregated = useMemo(() => {
    if (prefillPods.length > 0 || decodePods.length > 0) {
      return true;
    }
    return state.header.topology.pools.some(
      (p) => p.role === "prefill" || p.role === "decode"
    );
  }, [prefillPods.length, decodePods.length, state.header.topology.pools]);

  const prefillPoolCfg = useMemo(
    () => state.header.topology.pools.find((p) => p.role === "prefill"),
    [state.header.topology.pools]
  );
  const decodePoolCfg = useMemo(
    () => state.header.topology.pools.find((p) => p.role === "decode"),
    [state.header.topology.pools]
  );

  const reqQuery = reqFilter.trim().toLowerCase();
  const podQuery = podFilter.trim().toLowerCase();

  // Reconstruct all kv.transfer records observed up to tUs (both active and completed)
  const transferRecords = useMemo(() => {
    const byKey = new Map<string, TransferRecord>();
    const events = timeline.eventsInRange(0, tUs);
    for (const ev of events) {
      if (ev.type !== "kv.transfer") continue;
      const tr = ev as KVTransferEvent;
      const key =
        tr.transfer_id !== undefined
          ? String(tr.transfer_id)
          : `${tr.req_id}:${tr.from_pod}->${tr.to_pod}`;
      const existing = byKey.get(key);
      if (tr.status === "started") {
        byKey.set(key, {
          key,
          reqId: tr.req_id,
          fromPod: tr.from_pod,
          toPod: tr.to_pod,
          numKVBlocks: tr.num_kv_blocks,
          pulledKVBlocks: tr.pulled_kv_blocks,
          startedAtUs: tr.t_us,
          durationUs: tr.duration_us,
          status: "started"
        });
      } else {
        byKey.set(key, {
          key,
          reqId: tr.req_id,
          fromPod: tr.from_pod,
          toPod: tr.to_pod,
          numKVBlocks: tr.num_kv_blocks,
          pulledKVBlocks: tr.pulled_kv_blocks,
          startedAtUs: existing?.startedAtUs ?? Math.max(0, tr.t_us - tr.duration_us),
          completedAtUs: tr.t_us,
          durationUs: tr.duration_us,
          status: "completed"
        });
      }
    }

    // Ensure any activeTransfer in state is reflected
    for (const active of activeTransfers) {
      if (!byKey.has(active.key)) {
        byKey.set(active.key, {
          key: active.key,
          reqId: active.reqId,
          fromPod: active.fromPod,
          toPod: active.toPod,
          numKVBlocks: active.numKVBlocks,
          pulledKVBlocks: active.pulledKVBlocks,
          startedAtUs: active.startedAtUs,
          durationUs: Math.max(0, tUs - active.startedAtUs),
          status: "started"
        });
      }
    }

    return Array.from(byKey.values())
      .filter((tr) => {
        if (reqQuery && !tr.reqId.toLowerCase().includes(reqQuery)) return false;
        if (
          podQuery &&
          !tr.fromPod.toLowerCase().includes(podQuery) &&
          !tr.toPod.toLowerCase().includes(podQuery)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "started" ? -1 : 1;
        return b.startedAtUs - a.startedAtUs;
      });
  }, [timeline, tUs, activeTransfers, reqQuery, podQuery]);

  const outgoingCountByPod = useMemo(() => {
    const map = new Map<string, { active: number; completed: number; blocks: number }>();
    for (const tr of transferRecords) {
      const cur = map.get(tr.fromPod) ?? { active: 0, completed: 0, blocks: 0 };
      map.set(tr.fromPod, {
        active: cur.active + (tr.status === "started" ? 1 : 0),
        completed: cur.completed + (tr.status === "completed" ? 1 : 0),
        blocks: cur.blocks + tr.pulledKVBlocks
      });
    }
    return map;
  }, [transferRecords]);

  return (
    <div data-testid="view-pd-split" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <style>{`
        @keyframes pdTransferPulse {
          0% { background-position: 0 0; }
          100% { background-position: 28px 0; }
        }
      `}</style>

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
          <h2 style={{ margin: 0, fontSize: 15 }}>Prefill / Decode Disaggregation (P/D Split)</h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Prompt compute on Prefill pool → Cross-pod KV transfer fabric → Autoregressive generation on Decode pool.
          </div>
        </div>
        <SourceLinksChip
          glossaryTerm="P/D Split"
          links={[
            { path: "sim/cluster/pd_events.go", label: "P/D Events", glossaryTerm: "P/D Split" },
            { path: "sim/engine_driver_handoff.go", label: "KV Handoff" }
          ]}
        />
      </div>

      {/* Colocated Mode Informational Banner */}
      {!isDisaggregated && (
        <div
          className="panel-card"
          data-testid="pd-colocated-banner"
          style={{
            borderColor: "var(--sem-prefill)",
            background: "rgba(245, 158, 11, 0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12
          }}
        >
          <div style={{ maxWidth: 680 }}>
            <strong style={{ color: "var(--sem-prefill)" }}>
              Colocated Scenario Active ({state.header.scenario.name})
            </strong>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
              This scenario uses colocated pods where prefill and decode share GPU HBM locally on the
              same pod, so no cross-pod <code className="mono">kv.transfer</code> handoffs occur.
            </div>
          </div>

          {onSwitchScenario && (
            <button
              type="button"
              className="primary"
              data-testid="pd-switch-scenario-btn"
              onClick={() => onSwitchScenario("07-pd-disaggregation")}
            >
              Switch to 07-pd-disaggregation
            </button>
          )}
        </div>
      )}

      {/* 3-Column Flow Layout: Prefill Pool -> KV Transfer Fabric -> Decode Pool */}
      <div className="pd-split-grid">
        {/* Column 1: Prefill Pool Pods */}
        <div className="panel-card" data-testid="pd-prefill-column" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ fontSize: 13, color: "var(--sem-prefill)" }}>
              Prefill Pool Pods ({prefillPods.length})
            </strong>
            {prefillPoolCfg && (
              <span className="badge badge-prefill mono" style={{ fontSize: 10.5 }}>
                TP={prefillPoolCfg.tp} · {prefillPoolCfg.gpu_type}
              </span>
            )}
          </div>

          {prefillPods.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "12px 0" }}>
              No dedicated prefill pods in this topology.
            </div>
          ) : (
            prefillPods.map((pod) => {
              const reqs = selectRequestsForPod(state, pod.podId);
              const outStats = outgoingCountByPod.get(pod.podId);
              const kvPct =
                pod.kvTotalBlocks > 0
                  ? ((pod.kvUsedBlocks + pod.kvCachedBlocks) / pod.kvTotalBlocks) * 100
                  : 0;
              const isFilteredOut = Boolean(podQuery && !pod.podId.toLowerCase().includes(podQuery));

              return (
                <div
                  key={pod.podId}
                  data-testid={`pd-prefill-pod-${pod.podId}`}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    background: "var(--bg-inset)",
                    border: "1px solid var(--border-subtle)",
                    opacity: isFilteredOut ? 0.35 : 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <button
                      type="button"
                      className="mono"
                      onClick={() => onSelectPod?.(pod.podId)}
                      style={{ padding: "2px 7px", fontWeight: 700, fontSize: 12 }}
                    >
                      {pod.podId}
                    </button>
                    <span className={`badge ${getPodStatusBadgeClass(pod.status)}`}>{pod.status}</span>
                  </div>

                  <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    Queue: {reqs.queued.length} · Running: {reqs.running.length} · KV: {kvPct.toFixed(1)}%
                  </div>

                  {/* Prompt Compute Progress per active request */}
                  {reqs.running.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {reqs.running.map((r) => {
                        const pct =
                          r.promptTokens > 0
                            ? Math.min(100, (r.computedTokens / r.promptTokens) * 100)
                            : 0;
                        return (
                          <div key={r.reqId} style={{ fontSize: 11 }}>
                            <div style={{ display: "flex", justifyContent: "space-between" }} className="mono">
                              <span>{r.reqId}</span>
                              <span>
                                {r.computedTokens}/{r.promptTokens} tok
                              </span>
                            </div>
                            <div
                              style={{
                                height: 6,
                                borderRadius: 3,
                                background: "var(--bg-surface)",
                                overflow: "hidden",
                                marginTop: 2
                              }}
                            >
                              <div
                                style={{
                                  width: `${pct}%`,
                                  height: "100%",
                                  background: "var(--sem-prefill)"
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Idle (no active prefill)</div>
                  )}

                  <div
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: "var(--sem-transfer)",
                      borderTop: "1px solid var(--border-subtle)",
                      paddingTop: 5
                    }}
                  >
                    KV handoffs: {outStats?.active ?? 0} active · {outStats?.completed ?? 0} sent (
                    {outStats?.blocks ?? 0} blks)
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Column 2: Cross-Pod KV Transfer Fabric */}
        <div className="panel-card" data-testid="pd-transfer-fabric" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ fontSize: 13, color: "var(--sem-transfer)" }}>
              Cross-Pod KV Transfer Fabric
            </strong>
            <span className="badge badge-transfer mono">
              {activeTransfers.length} active / {transferRecords.length} total
            </span>
          </div>

          {transferRecords.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "12px 0" }}>
              No <code className="mono">kv.transfer</code> events observed up to current timestamp.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 520, overflowY: "auto" }}>
              {transferRecords.slice(0, 40).map((tr) => {
                const isActive = tr.status === "started";
                const pulledPct =
                  tr.numKVBlocks > 0
                    ? Math.min(100, Math.round((tr.pulledKVBlocks / tr.numKVBlocks) * 100))
                    : 100;

                return (
                  <div
                    key={tr.key}
                    data-testid={`kv-transfer-${tr.key}`}
                    style={{
                      padding: 9,
                      borderRadius: 8,
                      background: "var(--bg-inset)",
                      border: isActive
                        ? "1px solid var(--sem-transfer)"
                        : "1px solid var(--border-subtle)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 5
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <span className="mono" style={{ fontWeight: 700, fontSize: 12 }}>
                        {tr.reqId}
                      </span>
                      <span className={`badge ${isActive ? "badge-transfer" : "badge-ready"}`} style={{ fontSize: 10 }}>
                        {isActive ? "in flight" : "completed"}
                      </span>
                    </div>

                    <div className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      {tr.fromPod} → {tr.toPod}
                    </div>

                    {/* Animated Progress Bar */}
                    <div
                      style={{
                        height: 8,
                        borderRadius: 4,
                        background: "var(--bg-surface)",
                        border: "1px solid var(--border-subtle)",
                        overflow: "hidden"
                      }}
                    >
                      <div
                        style={{
                          width: `${pulledPct}%`,
                          height: "100%",
                          background: isActive
                            ? "repeating-linear-gradient(45deg, #c084fc, #c084fc 7px, #9333ea 7px, #9333ea 14px)"
                            : "#c084fc",
                          backgroundSize: isActive ? "28px 28px" : undefined,
                          animation: isActive ? "pdTransferPulse 0.8s linear infinite" : undefined
                        }}
                      />
                    </div>

                    <div
                      className="mono"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        fontSize: 11,
                        color: "var(--text-secondary)"
                      }}
                    >
                      <span>
                        blocks: {tr.pulledKVBlocks}/{tr.numKVBlocks}
                      </span>
                      <span>
                        duration:{" "}
                        {tr.status === "completed"
                          ? `${(tr.durationUs / 1000).toFixed(2)} ms`
                          : `${((tUs - tr.startedAtUs) / 1000).toFixed(2)} ms…`}
                      </span>
                      {onSeekUs && (
                        <button
                          type="button"
                          onClick={() => onSeekUs(tr.startedAtUs)}
                          style={{ padding: "1px 6px", fontSize: 10.5 }}
                        >
                          seek
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Column 3: Decode Pool Pods */}
        <div className="panel-card" data-testid="pd-decode-column" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <strong style={{ fontSize: 13, color: "var(--sem-decode)" }}>
              Decode Pool Pods ({decodePods.length})
            </strong>
            {decodePoolCfg && (
              <span className="badge badge-decode mono" style={{ fontSize: 10.5 }}>
                TP={decodePoolCfg.tp} · max_seqs={decodePoolCfg.max_num_seqs}
              </span>
            )}
          </div>

          {decodePods.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "12px 0" }}>
              No dedicated decode pods in this topology.
            </div>
          ) : (
            decodePods.map((pod) => {
              const reqs = selectRequestsForPod(state, pod.podId);
              const maxSeqs = Math.max(1, decodePoolCfg?.max_num_seqs ?? 1);
              const batchUtilPct = Math.min(100, (reqs.running.length / maxSeqs) * 100);
              const kvPct =
                pod.kvTotalBlocks > 0
                  ? ((pod.kvUsedBlocks + pod.kvCachedBlocks) / pod.kvTotalBlocks) * 100
                  : 0;
              const isFilteredOut = Boolean(podQuery && !pod.podId.toLowerCase().includes(podQuery));

              return (
                <div
                  key={pod.podId}
                  data-testid={`pd-decode-pod-${pod.podId}`}
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    background: "var(--bg-inset)",
                    border: "1px solid var(--border-subtle)",
                    opacity: isFilteredOut ? 0.35 : 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                    <button
                      type="button"
                      className="mono"
                      onClick={() => onSelectPod?.(pod.podId)}
                      style={{ padding: "2px 7px", fontWeight: 700, fontSize: 12 }}
                    >
                      {pod.podId}
                    </button>
                    <span className={`badge ${getPodStatusBadgeClass(pod.status)}`}>{pod.status}</span>
                  </div>

                  {/* Batch & KV Utilization */}
                  <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    Queue: {reqs.queued.length} · Batch: {reqs.running.length}/{maxSeqs} (
                    {batchUtilPct.toFixed(0)}%) · KV: {kvPct.toFixed(1)}%
                  </div>

                  <div
                    style={{
                      height: 7,
                      borderRadius: 4,
                      background: "var(--bg-surface)",
                      border: "1px solid var(--border-subtle)",
                      overflow: "hidden"
                    }}
                    title={`Batch utilization ${batchUtilPct.toFixed(0)}%`}
                  >
                    <div
                      style={{
                        width: `${batchUtilPct}%`,
                        height: "100%",
                        background: "var(--sem-decode)"
                      }}
                    />
                  </div>

                  {/* Active Decode Generation Requests */}
                  {reqs.running.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {reqs.running.map((r) => {
                        const pct =
                          r.maxOutputTokens > 0
                            ? Math.min(100, (r.emittedTokens / r.maxOutputTokens) * 100)
                            : 0;
                        return (
                          <div key={r.reqId} style={{ fontSize: 11 }}>
                            <div style={{ display: "flex", justifyContent: "space-between" }} className="mono">
                              <span>{r.reqId}</span>
                              <span>
                                {r.emittedTokens}/{r.maxOutputTokens} tok
                              </span>
                            </div>
                            <div
                              style={{
                                height: 6,
                                borderRadius: 3,
                                background: "var(--bg-surface)",
                                overflow: "hidden",
                                marginTop: 2
                              }}
                            >
                              <div
                                style={{
                                  width: `${pct}%`,
                                  height: "100%",
                                  background: "var(--sem-decode)"
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      Idle (no active decode requests)
                    </div>
                  )}

                  {reqs.queued.length > 0 && (
                    <div className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      Waiting queue: {reqs.queued.map((q) => q.reqId).join(", ")}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
