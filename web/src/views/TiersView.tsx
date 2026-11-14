import React, { useMemo, useState } from "react";
import type { KVBlockMovedEvent } from "@llm-viz/schema";
import {
  selectActiveTierMoves,
  selectPods,
  type PodState,
  type ReplayTimeline,
  type SimState
} from "../replay/index.js";
import { InfoHint } from "../components/GlossaryModal.js";
import { SourceLinksChip } from "../components/SourceLinksChip.js";

export interface TiersViewProps {
  timeline: ReplayTimeline;
  state: SimState;
  tUs: number;
  podFilter?: string;
  reqFilter?: string;
  onSeekUs?: (tUs: number) => void;
  onSwitchScenario?: (scenarioId: string) => void;
}

const BYTES_PER_GIB = 1024 ** 3;
const BYTES_PER_MIB = 1024 ** 2;

const SOURCE_REFS: ReadonlyArray<{ path: string; role: string }> = [
  {
    path: "sim/engine_driver_handoff.go",
    role: "BLIS driver handoff & KV offload/reload event emission"
  },
  {
    path: "blis-vllm/core/vllm/offload.go",
    role: "Two-tier GPU HBM <-> Host CPU DRAM KV block offload/load manager"
  }
];

function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GIB) {
    return `${(bytes / BYTES_PER_GIB).toFixed(2)} GiB`;
  }
  if (bytes >= BYTES_PER_MIB) {
    return `${(bytes / BYTES_PER_MIB).toFixed(1)} MiB`;
  }
  return `${Math.round(bytes)} B`;
}

function formatMs(tUs: number): string {
  return `${(tUs / 1000).toFixed(2)} ms`;
}

function estimateBytesPerBlock(state: SimState, pods: readonly PodState[]): number {
  const tiers = state.header.topology.tiers;
  if (tiers.cpu_ram_blocks > 0 && tiers.cpu_ram_bytes > 0) {
    return tiers.cpu_ram_bytes / tiers.cpu_ram_blocks;
  }
  const pool =
    state.header.topology.pools.find((p) => pods.some((pod) => pod.poolRole === p.role)) ??
    state.header.topology.pools[0];
  if (!pool || pool.kv_blocks_per_gpu <= 0) {
    return 0;
  }
  const totalBytes = pool.gpu_specs.memory_gib * BYTES_PER_GIB;
  const mb = pool.memory_breakdown_bytes;
  const fixedBytes = mb.weights + mb.activation_peak + mb.cuda_graph + mb.comm_buffers;
  return Math.max(0, totalBytes - fixedBytes) / pool.kv_blocks_per_gpu;
}

export const TiersView: React.FC<TiersViewProps> = ({
  timeline,
  state,
  tUs,
  podFilter = "",
  reqFilter = "",
  onSeekUs,
  onSwitchScenario
}) => {
  const [directionFilter, setDirectionFilter] = useState<"all" | "offload" | "load">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "started" | "completed">("all");

  const pods = useMemo(() => {
    const all = selectPods(state);
    const q = podFilter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((p) => p.podId.toLowerCase().includes(q));
  }, [state, podFilter]);

  const tiers = state.header.topology.tiers;
  const bytesPerBlock = useMemo(() => estimateBytesPerBlock(state, pods), [state, pods]);

  // Tier 1 (GPU HBM) aggregates across displayed pods
  const gpuTotals = useMemo(() => {
    let used = 0;
    let cached = 0;
    let free = 0;
    let total = 0;
    for (const p of pods) {
      used += p.kvUsedBlocks;
      cached += p.kvCachedBlocks;
      free += p.kvFreeBlocks;
      total += p.kvTotalBlocks;
    }
    return { used, cached, free, total };
  }, [pods]);

  // Tier 2 (CPU DRAM) aggregates across displayed pods
  const cpuTotals = useMemo(() => {
    let used = 0;
    let total = 0;
    for (const p of pods) {
      used += p.cpuUsedBlocks;
      total += p.cpuTotalBlocks;
    }
    return { used, total, free: Math.max(0, total - used) };
  }, [pods]);

  const activeMoves = useMemo(() => {
    const podQ = podFilter.trim().toLowerCase();
    const reqQ = reqFilter.trim().toLowerCase();
    return selectActiveTierMoves(state).filter((m) => {
      if (podQ && !m.podId.toLowerCase().includes(podQ)) return false;
      if (reqQ && !m.reqId.toLowerCase().includes(reqQ)) return false;
      return true;
    });
  }, [state, podFilter, reqFilter]);

  // Pre-index all kv.block.moved events once per timeline
  const allMoveEvents = useMemo(() => {
    const out: KVBlockMovedEvent[] = [];
    for (const ev of timeline.events) {
      if (ev.type === "kv.block.moved") {
        out.push(ev);
      }
    }
    return out;
  }, [timeline]);

  const visibleMoveEvents = useMemo(() => {
    const podQ = podFilter.trim().toLowerCase();
    const reqQ = reqFilter.trim().toLowerCase();
    const out: KVBlockMovedEvent[] = [];
    for (let i = allMoveEvents.length - 1; i >= 0; i--) {
      const ev = allMoveEvents[i];
      if (ev.t_us > tUs) continue;
      if (podQ && !ev.pod_id.toLowerCase().includes(podQ)) continue;
      if (reqQ && !ev.req_id.toLowerCase().includes(reqQ)) continue;
      if (directionFilter !== "all" && ev.direction !== directionFilter) continue;
      if (statusFilter !== "all" && ev.status !== statusFilter) continue;
      out.push(ev);
      if (out.length >= 120) break;
    }
    return out;
  }, [allMoveEvents, tUs, podFilter, reqFilter, directionFilter, statusFilter]);

  const moveCountsUpToNow = useMemo(() => {
    let offloads = 0;
    let loads = 0;
    let blocksOffloaded = 0;
    let blocksLoaded = 0;
    for (const ev of allMoveEvents) {
      if (ev.t_us > tUs) break;
      if (ev.status !== "completed") continue;
      if (ev.direction === "offload") {
        offloads += 1;
        blocksOffloaded += ev.num_blocks;
      } else {
        loads += 1;
        blocksLoaded += ev.num_blocks;
      }
    }
    return { offloads, loads, blocksOffloaded, blocksLoaded };
  }, [allMoveEvents, tUs]);

  const gpuDenom = Math.max(1, gpuTotals.total);
  const gpuUsedPct = (gpuTotals.used / gpuDenom) * 100;
  const gpuCachedPct = (gpuTotals.cached / gpuDenom) * 100;
  const gpuFreePct = Math.max(0, 100 - gpuUsedPct - gpuCachedPct);

  const cpuConfigured = tiers.cpu_ram_blocks > 0;
  const cpuDenom = Math.max(1, cpuTotals.total);
  const cpuUsedPct = cpuConfigured ? (cpuTotals.used / cpuDenom) * 100 : 0;

  const localSsdNote =
    tiers.unmodelled_notes?.local_ssd ??
    tiers.unmodelled_notes?.nvme ??
    "BLIS v0.32.0 models GPU HBM (Tier 1) and Host CPU DRAM (Tier 2) only. Local NVMe/SSD KV spillover (e.g. LMCache disk tier) is not modelled in this binary.";
  const remoteStoreNote =
    tiers.unmodelled_notes?.remote_store ??
    tiers.unmodelled_notes?.s3 ??
    "BLIS v0.32.0 does not model remote object/KV stores (S3, Mooncake, Redis, or disaggregated shared KV fabric outside P/D transfer).";

  return (
    <div data-testid="view-tiers" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header & CTA when CPU tier is inactive */}
      <div
        className="panel-card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap"
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>KV Cache Memory Hierarchy (4 Tiers)</h2>
            <InfoHint term="KV Block" />
            <InfoHint term="Eviction" />
          </div>
          <div style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 3 }}>
            Live occupancy across BLIS-modelled tiers (GPU HBM &amp; Host CPU DRAM) alongside unmodelled storage tiers.
          </div>
        </div>

        {!cpuConfigured && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="badge badge-neutral">CPU DRAM offloading disabled in this scenario</span>
            {onSwitchScenario && (
              <button
                type="button"
                className="primary"
                data-testid="cta-switch-05-memory-tiers"
                onClick={() => onSwitchScenario("05-memory-tiers")}
              >
                Inspect CPU DRAM Offload (05-memory-tiers)
              </button>
            )}
          </div>
        )}
      </div>

      {/* 4-Tier Hierarchy Grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 12
        }}
      >
        {/* Tier 1: GPU HBM */}
        <div
          className="panel-card"
          data-testid="tier-card-gpu-hbm"
          style={{ display: "flex", flexDirection: "column", gap: 10, borderColor: "rgba(56, 189, 248, 0.35)" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--sem-decode)", fontWeight: 700, textTransform: "uppercase" }}>
                Tier 1 · Device Memory
              </div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>GPU HBM</div>
            </div>
            <span className="badge badge-decode">Modelled</span>
          </div>

          <div className="hbm-bar-track" aria-label="GPU HBM KV block occupancy">
            <div
              className="hbm-segment"
              style={{ width: `${gpuUsedPct.toFixed(2)}%`, background: "#38bdf8" }}
              title={`Active: ${gpuTotals.used} blocks`}
            />
            <div
              className="hbm-segment"
              style={{ width: `${gpuCachedPct.toFixed(2)}%`, background: "#10b981" }}
              title={`Cached (LRU): ${gpuTotals.cached} blocks`}
            />
          </div>

          <div className="mono" style={{ fontSize: 12, display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 10px" }}>
            <span style={{ color: "var(--text-secondary)" }}>Active (pinned)</span>
            <span>
              {gpuTotals.used} blk ({formatBytes(gpuTotals.used * bytesPerBlock)})
            </span>
            <span style={{ color: "var(--text-secondary)" }}>Cached (LRU)</span>
            <span style={{ color: "var(--sem-cached)" }}>
              {gpuTotals.cached} blk ({formatBytes(gpuTotals.cached * bytesPerBlock)})
            </span>
            <span style={{ color: "var(--text-secondary)" }}>Free</span>
            <span>
              {gpuTotals.free} blk ({formatBytes(gpuTotals.free * bytesPerBlock)})
            </span>
            <span style={{ color: "var(--text-muted)" }}>Usable / Header</span>
            <span style={{ color: "var(--text-secondary)" }}>
              {gpuTotals.total} / {tiers.gpu_hbm_blocks} blk ({gpuFreePct.toFixed(0)}% free)
            </span>
          </div>

          {pods.length > 1 && (
            <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 8, fontSize: 11 }}>
              <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>Per-Pod GPU KV</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {pods.map((p) => (
                  <div key={p.podId} className="mono" style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{p.podId}</span>
                    <span style={{ color: "var(--text-secondary)" }}>
                      {p.kvUsedBlocks}u + {p.kvCachedBlocks}c / {p.kvTotalBlocks}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Tier 2: Host CPU DRAM */}
        <div
          className="panel-card"
          data-testid="tier-card-cpu-dram"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            borderColor: cpuConfigured ? "rgba(20, 184, 166, 0.4)" : "var(--border-subtle)",
            opacity: cpuConfigured ? 1 : 0.78
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--sem-cpu-dram)", fontWeight: 700, textTransform: "uppercase" }}>
                Tier 2 · Host Offload Pool
              </div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Host CPU DRAM</div>
            </div>
            <span className={`badge ${cpuConfigured ? "badge-cpu_dram" : "badge-neutral"}`}>
              {cpuConfigured ? "Active" : "0 Blocks"}
            </span>
          </div>

          <div className="hbm-bar-track" aria-label="CPU DRAM offload occupancy">
            <div
              className="hbm-segment"
              style={{ width: `${Math.min(100, cpuUsedPct).toFixed(2)}%`, background: "#14b8a6" }}
              title={`CPU DRAM Used: ${cpuTotals.used} / ${cpuTotals.total} blocks`}
            />
          </div>

          <div className="mono" style={{ fontSize: 12, display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 10px" }}>
            <span style={{ color: "var(--text-secondary)" }}>Used / Capacity</span>
            <span>
              {cpuTotals.used} / {cpuConfigured ? cpuTotals.total : tiers.cpu_ram_blocks} blk
            </span>
            <span style={{ color: "var(--text-secondary)" }}>Used / Total Bytes</span>
            <span>
              {formatBytes(cpuTotals.used * bytesPerBlock)} / {formatBytes(tiers.cpu_ram_bytes)}
            </span>
            <span style={{ color: "var(--text-secondary)" }}>Completed Offloads</span>
            <span style={{ color: "var(--sem-prefill)" }}>
              {moveCountsUpToNow.offloads} ({moveCountsUpToNow.blocksOffloaded} blk)
            </span>
            <span style={{ color: "var(--text-secondary)" }}>Completed Reloads</span>
            <span style={{ color: "var(--sem-cpu-dram)" }}>
              {moveCountsUpToNow.loads} ({moveCountsUpToNow.blocksLoaded} blk)
            </span>
          </div>

          <div style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
              In-Flight PCIe Transfers ({activeMoves.length})
            </div>
            {activeMoves.length === 0 ? (
              <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>No active kv.block.moved transfer at {formatMs(tUs)}.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {activeMoves.map((m) => (
                  <div
                    key={m.key}
                    className="mono"
                    data-testid={`active-tier-move-${m.transferId}`}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 7px",
                      borderRadius: 5,
                      background: "var(--bg-inset)",
                      border: "1px solid var(--border-subtle)",
                      fontSize: 11
                    }}
                  >
                    <span className={`badge ${m.direction === "offload" ? "badge-prefill" : "badge-cpu_dram"}`}>
                      {m.direction === "offload" ? "GPU -> CPU" : "CPU -> GPU"}
                    </span>
                    <span>{m.reqId}</span>
                    <span style={{ color: "var(--text-secondary)" }}>{m.numBlocks} blk</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Tier 3: Local NVMe / SSD (Unmodelled) */}
        <div
          className="panel-card"
          data-testid="tier-card-local-ssd"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            borderStyle: tiers.local_ssd_modelled ? "solid" : "dashed",
            borderColor: tiers.local_ssd_modelled ? "var(--border-strong)" : "var(--text-muted)",
            background: tiers.local_ssd_modelled
              ? "var(--bg-surface)"
              : "repeating-linear-gradient(-45deg, rgba(15, 22, 35, 0.96), rgba(15, 22, 35, 0.96) 10px, rgba(22, 32, 50, 0.72) 10px, rgba(22, 32, 50, 0.72) 20px)",
            opacity: tiers.local_ssd_modelled ? 1 : 0.85
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>
                Tier 3 · Local Disk Cache
              </div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Local NVMe / SSD</div>
            </div>
            <span className="badge badge-neutral">
              {tiers.local_ssd_modelled ? "Modelled" : "Unmodelled in BLIS v0.32.0"}
            </span>
          </div>

          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            {localSsdNote}
          </div>

          <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)", marginTop: "auto" }}>
            local_ssd_modelled = {String(tiers.local_ssd_modelled)}
          </div>
        </div>

        {/* Tier 4: Remote Store / S3 (Unmodelled) */}
        <div
          className="panel-card"
          data-testid="tier-card-remote-store"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            borderStyle: tiers.remote_store_modelled ? "solid" : "dashed",
            borderColor: tiers.remote_store_modelled ? "var(--border-strong)" : "var(--text-muted)",
            background: tiers.remote_store_modelled
              ? "var(--bg-surface)"
              : "repeating-linear-gradient(-45deg, rgba(15, 22, 35, 0.96), rgba(15, 22, 35, 0.96) 10px, rgba(22, 32, 50, 0.72) 10px, rgba(22, 32, 50, 0.72) 20px)",
            opacity: tiers.remote_store_modelled ? 1 : 0.85
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>
                Tier 4 · Shared Object / KV Fabric
              </div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Remote Store / S3</div>
            </div>
            <span className="badge badge-neutral">
              {tiers.remote_store_modelled ? "Modelled" : "Unmodelled in BLIS v0.32.0"}
            </span>
          </div>

          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            {remoteStoreNote}
          </div>

          <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)", marginTop: "auto" }}>
            remote_store_modelled = {String(tiers.remote_store_modelled)}
          </div>
        </div>
      </div>

      {/* Any extra unmodelled_notes entries */}
      {Object.keys(tiers.unmodelled_notes ?? {}).length > 0 && (
        <div className="panel-card" data-testid="tiers-unmodelled-notes">
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600, marginBottom: 6 }}>
            Header Unmodelled Notes
          </div>
          <dl className="flags-grid" style={{ margin: 0 }}>
            {Object.entries(tiers.unmodelled_notes).map(([k, v]) =>
              v ? (
                <React.Fragment key={k}>
                  <dt className="mono">{k}</dt>
                  <dd>{v}</dd>
                </React.Fragment>
              ) : null
            )}
          </dl>
        </div>
      )}

      {/* kv.block.moved Transfer Ledger */}
      <div className="panel-card" data-testid="tier-move-ledger">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginBottom: 10,
            flexWrap: "wrap"
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: 13.5 }}>Tier Transfer Ledger (kv.block.moved)</h3>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
              Showing events at or before {formatMs(tUs)}. Click any row to seek playback to that transfer timestamp.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <select
              aria-label="Filter tier moves by direction"
              data-testid="tier-direction-filter"
              value={directionFilter}
              onChange={(e) => setDirectionFilter(e.target.value as "all" | "offload" | "load")}
            >
              <option value="all">All Directions</option>
              <option value="offload">Offload (GPU -&gt; CPU)</option>
              <option value="load">Load (CPU -&gt; GPU)</option>
            </select>
            <select
              aria-label="Filter tier moves by status"
              data-testid="tier-status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "all" | "started" | "completed")}
            >
              <option value="all">All Statuses</option>
              <option value="started">Started</option>
              <option value="completed">Completed</option>
            </select>
          </div>
        </div>

        {visibleMoveEvents.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 0" }}>
            No matching <code>kv.block.moved</code> events observed up to {formatMs(tUs)}.
            {!cpuConfigured && onSwitchScenario && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => onSwitchScenario("05-memory-tiers")}
                  style={{ marginLeft: 6 }}
                >
                  Load 05-memory-tiers
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="event-log-table-wrap">
            <table className="event-log-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Xfer</th>
                  <th>Direction</th>
                  <th>Status</th>
                  <th>Pod</th>
                  <th>Request</th>
                  <th>Blocks / Tokens</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {visibleMoveEvents.map((ev) => (
                  <tr
                    key={`${ev.seq}-${ev.transfer_id}`}
                    className="event-log-row"
                    data-testid={`tier-move-row-${ev.seq}`}
                    onClick={() => onSeekUs?.(ev.t_us)}
                    title="Click to seek to this transfer"
                  >
                    <td className="mono">{formatMs(ev.t_us)}</td>
                    <td className="mono">#{ev.transfer_id}</td>
                    <td>
                      <span className={`badge ${ev.direction === "offload" ? "badge-prefill" : "badge-cpu_dram"}`}>
                        {ev.direction === "offload" ? "offload (GPU->CPU)" : "load (CPU->GPU)"}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${ev.status === "completed" ? "badge-cached" : "badge-transfer"}`}>
                        {ev.status}
                      </span>
                    </td>
                    <td className="mono">{ev.pod_id}</td>
                    <td className="mono">{ev.req_id}</td>
                    <td className="mono">
                      {ev.num_blocks} blk ({ev.tokens} tok)
                    </td>
                    <td className="mono">
                      {ev.duration_us > 0 ? `${(ev.duration_us / 1000).toFixed(2)} ms` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Source References Footer */}
      <div
        className="panel-card"
        data-testid="tiers-source-links"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 11.5 }}
      >
        <SourceLinksChip
          glossaryTerm="Eviction"
          links={[
            { path: "sim/engine_driver_handoff.go", label: "Driver Handoff", glossaryTerm: "Eviction" },
            { path: "sim/kv_block_tracker.go", label: "KV Tracker", glossaryTerm: "KV Block" }
          ]}
        />
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {SOURCE_REFS.map((ref) => (
            <span key={ref.path} title={ref.role} style={{ color: "var(--text-secondary)" }}>
              <code className="mono" style={{ color: "var(--accent-primary)" }}>
                {ref.path}
              </code>{" "}
              <span style={{ color: "var(--text-muted)" }}>({ref.role})</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
