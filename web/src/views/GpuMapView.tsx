import React, { useEffect, useMemo, useRef, useState } from "react";
import type { KVBlockEvictedEvent, PoolConfig } from "@llm-viz/schema";
import { selectPods, type KVBlockSlotState, type PodState, type ReplayTimeline, type SimState } from "../replay/index.js";
import { InfoHint } from "../components/GlossaryModal.js";
import { EvictionPreemptionStrip } from "../components/EvictionPreemptionStrip.js";
import { SourceLinksChip } from "../components/SourceLinksChip.js";

export interface GpuMapViewProps {
  timeline: ReplayTimeline;
  state: SimState;
  tUs: number;
  podFilter: string;
  reqFilter?: string;
  onSeekUs?: (tUs: number) => void;
}

const EVICTION_FLASH_WINDOW_US = 250_000;

interface HoveredBlockInfo {
  readonly blockId: number;
  readonly tier: "gpu" | "cpu_dram";
  readonly statusLabel: string;
  readonly ownerReqs: readonly string[];
  readonly hash?: string;
  readonly x: number;
  readonly y: number;
}

interface GridGeometry {
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly stride: number;
  readonly cellSize: number;
}

function computeGridGeometry(totalBlocks: number, targetWidth = 480): GridGeometry {
  const safeBlocks = Math.max(1, totalBlocks);
  const stride = safeBlocks <= 900 ? 10 : safeBlocks <= 3200 ? 6 : 3;
  const cellSize = stride >= 10 ? 8 : stride >= 6 ? 4.5 : 2;
  const cols = Math.max(16, Math.floor(targetWidth / stride));
  const rows = Math.ceil(safeBlocks / cols);
  const width = cols * stride;
  const height = Math.max(64, rows * stride);
  return { width, height, cols, stride, cellSize };
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
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

interface KVBlockCanvasProps {
  testId: string;
  tier: "gpu" | "cpu_dram";
  totalBlocks: number;
  blocksMap: ReadonlyMap<number, KVBlockSlotState>;
  recentEvictions?: ReadonlyMap<number, number>;
}

const KVBlockCanvas: React.FC<KVBlockCanvasProps> = ({
  testId,
  tier,
  totalBlocks,
  blocksMap,
  recentEvictions
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoveredBlockInfo | null>(null);

  const geom = useMemo(() => computeGridGeometry(totalBlocks, 480), [totalBlocks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(geom.width * dpr);
    canvas.height = Math.round(geom.height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = "#0b1019";
    ctx.fillRect(0, 0, geom.width, geom.height);

    for (let bid = 0; bid < totalBlocks; bid++) {
      const col = bid % geom.cols;
      const row = Math.floor(bid / geom.cols);
      const x = col * geom.stride;
      const y = row * geom.stride;

      const slot = blocksMap.get(bid);
      const isRecentlyEvicted = recentEvictions?.has(bid) ?? false;

      if (!slot) {
        ctx.fillStyle = isRecentlyEvicted ? "#fb7185" : "#162032";
      } else if (tier === "cpu_dram") {
        ctx.fillStyle = slot.ownerReqIds.length > 0 ? "#2dd4bf" : "#14b8a6";
      } else if (slot.ownerReqIds.length > 1 || (slot.sharedWithReqs?.length ?? 0) > 0) {
        ctx.fillStyle = "#a855f7";
      } else if (slot.status === "cached" || slot.ownerReqIds.length === 0) {
        ctx.fillStyle = "#10b981";
      } else {
        ctx.fillStyle = "#38bdf8";
      }

      ctx.fillRect(x, y, geom.cellSize, geom.cellSize);

      if (slot && isRecentlyEvicted && geom.cellSize >= 4) {
        ctx.strokeStyle = "#fb7185";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, geom.cellSize - 1, geom.cellSize - 1);
      }
    }
  }, [geom, totalBlocks, blocksMap, recentEvictions, tier]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const scaleX = geom.width / rect.width;
    const scaleY = geom.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;

    const col = Math.floor(cx / geom.stride);
    const row = Math.floor(cy / geom.stride);
    const blockId = row * geom.cols + col;

    if (col < 0 || col >= geom.cols || blockId < 0 || blockId >= totalBlocks) {
      setHoverInfo(null);
      return;
    }

    const slot = blocksMap.get(blockId);
    const isEvicted = recentEvictions?.has(blockId) ?? false;
    let statusLabel = "free";
    if (!slot && isEvicted) {
      statusLabel = "recently evicted";
    } else if (slot) {
      if (slot.ownerReqIds.length > 1 || (slot.sharedWithReqs?.length ?? 0) > 0) {
        statusLabel = "prefix-shared";
      } else if (slot.status === "cached" || slot.ownerReqIds.length === 0) {
        statusLabel = tier === "cpu_dram" ? "cpu_dram cached" : "cached";
      } else {
        statusLabel = "active";
      }
    }

    setHoverInfo({
      blockId,
      tier,
      statusLabel,
      ownerReqs: slot?.ownerReqIds ?? [],
      hash: slot?.hash,
      x: Math.min(rect.width - 180, Math.max(8, e.clientX - rect.left + 12)),
      y: Math.max(8, e.clientY - rect.top - 10)
    });
  };

  return (
    <div className="kv-canvas-wrap">
      <canvas
        ref={canvasRef}
        data-testid={testId}
        className="kv-grid-canvas"
        style={{ aspectRatio: `${geom.width} / ${geom.height}` }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverInfo(null)}
      />
      {hoverInfo && (
        <div className="kv-tooltip mono" style={{ left: hoverInfo.x, top: hoverInfo.y }}>
          <div>
            <strong>block #{hoverInfo.blockId}</strong> ({hoverInfo.tier})
          </div>
          <div>state: {hoverInfo.statusLabel}</div>
          <div>
            owners:{" "}
            {hoverInfo.ownerReqs.length > 0 ? hoverInfo.ownerReqs.join(", ") : "none"}
          </div>
          {hoverInfo.hash && (
            <div>hash: {hoverInfo.hash.length > 14 ? `${hoverInfo.hash.slice(0, 14)}...` : hoverInfo.hash}</div>
          )}
        </div>
      )}
    </div>
  );
};

interface PodCardProps {
  pod: PodState;
  pool: PoolConfig;
  recentEvictions: ReadonlyMap<number, number>;
}

const PodGpuCard: React.FC<PodCardProps> = ({ pod, pool, recentEvictions }) => {
  const totalBytes = Math.max(1, pool.gpu_specs.memory_gib * 1024 ** 3);
  const mb = pool.memory_breakdown_bytes;
  const fixedBytes = mb.weights + mb.activation_peak + mb.cuda_graph + mb.comm_buffers;
  const kvPoolBytes = Math.max(0, totalBytes - fixedBytes);

  const segments = [
    { label: "Weights", bytes: mb.weights, color: "#64748b" },
    { label: "KV Cache Pool", bytes: kvPoolBytes, color: "#38bdf8" },
    { label: "Activations", bytes: mb.activation_peak, color: "#f59e0b" },
    { label: "CUDA Graphs", bytes: mb.cuda_graph, color: "#a855f7" },
    { label: "Comm Buffers", bytes: mb.comm_buffers, color: "#14b8a6" }
  ].filter((s) => s.bytes > 0);

  const activeOnlyCount = Math.max(0, pod.kvUsedBlocks);
  const cachedCount = pod.kvCachedBlocks;

  return (
    <div className="pod-card" data-testid={`pod-card-${pod.podId}`}>
      <div className="pod-header">
        <div className="pod-title-group">
          <span className="pod-id mono">{pod.podId}</span>
          <span className="badge badge-neutral">{pod.poolRole}</span>
          <span className={`badge ${getPodStatusBadgeClass(pod.status)}`}>{pod.status}</span>
          <span className="badge badge-neutral mono">TP={pod.tpDegree}</span>
        </div>
        <div className="pod-meta mono">
          {pool.gpu_type} · {pool.gpu_specs.memory_gib.toFixed(0)} GiB ·{" "}
          {pool.gpu_specs.bw_peak_tbs} TB/s · {pool.gpu_specs.tflops_peak} TF
        </div>
      </div>

      {/* HBM Anatomy Bar */}
      <div className="hbm-bar-container" data-testid={`hbm-bar-${pod.podId}`}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-secondary)" }}>
          <span>GPU HBM Breakdown ({pool.gpu_specs.memory_gib.toFixed(1)} GiB / GPU)</span>
          <span className="mono">block_size={pod.kvBlockSizeTokens} tok</span>
        </div>
        <div className="hbm-bar-track">
          {segments.map((seg) => {
            const pct = (seg.bytes / totalBytes) * 100;
            return (
              <div
                key={seg.label}
                className="hbm-segment"
                style={{ width: `${pct.toFixed(2)}%`, background: seg.color }}
                title={`${seg.label}: ${formatGiB(seg.bytes)} (${pct.toFixed(1)}%)`}
              />
            );
          })}
        </div>
        <div className="hbm-legend">
          {segments.map((seg) => {
            const pct = (seg.bytes / totalBytes) * 100;
            return (
              <span key={seg.label} className="chart-legend-item">
                <span className="legend-swatch" style={{ background: seg.color }} />
                <span>
                  {seg.label} <span className="mono">{formatGiB(seg.bytes)}</span> ({pct.toFixed(1)}%)
                </span>
              </span>
            );
          })}
        </div>
      </div>

      {/* GPU KV Block Grid */}
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 6,
            fontSize: 11.5,
            flexWrap: "wrap",
            gap: 6
          }}
        >
          <span style={{ fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}>
            GPU KV Blocks <InfoHint term="KV Block" />
          </span>
          <span className="mono" style={{ color: "var(--text-secondary)" }}>
            used {activeOnlyCount} · cached {cachedCount} · free {pod.kvFreeBlocks} / {pod.kvTotalBlocks}
          </span>
        </div>

        <KVBlockCanvas
          testId={`kv-canvas-${pod.podId}`}
          tier="gpu"
          totalBlocks={pod.kvTotalBlocks}
          blocksMap={pod.kvBlocks}
          recentEvictions={recentEvictions}
        />

        <div className="hbm-legend" style={{ marginTop: 6 }}>
          <span className="chart-legend-item">
            <span className="legend-swatch" style={{ background: "#38bdf8" }} /> Active
          </span>
          <span className="chart-legend-item">
            <span className="legend-swatch" style={{ background: "#a855f7" }} /> Prefix-Shared
          </span>
          <span className="chart-legend-item">
            <span className="legend-swatch" style={{ background: "#10b981" }} /> Cached (LRU)
          </span>
          <span className="chart-legend-item">
            <span className="legend-swatch" style={{ background: "#fb7185" }} /> Recently Evicted
          </span>
          <span className="chart-legend-item">
            <span className="legend-swatch" style={{ background: "#162032", border: "1px solid #2f415d" }} /> Free
          </span>
        </div>
      </div>

      {/* CPU DRAM Offload Tier Grid */}
      {pod.cpuTotalBlocks > 0 && (
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 6,
              fontSize: 11.5
            }}
          >
            <span style={{ fontWeight: 600, color: "var(--sem-cpu-dram)" }}>
              CPU DRAM Offload Pool
            </span>
            <span className="mono" style={{ color: "var(--text-secondary)" }}>
              used {pod.cpuUsedBlocks} / {pod.cpuTotalBlocks} blocks
            </span>
          </div>
          <KVBlockCanvas
            testId={`cpu-canvas-${pod.podId}`}
            tier="cpu_dram"
            totalBlocks={pod.cpuTotalBlocks}
            blocksMap={pod.cpuBlocks}
          />
        </div>
      )}
    </div>
  );
};

export const GpuMapView: React.FC<GpuMapViewProps> = ({
  timeline,
  state,
  tUs,
  podFilter,
  reqFilter = "",
  onSeekUs
}) => {
  const pods = useMemo(() => {
    const all = selectPods(state);
    const q = podFilter.trim().toLowerCase();
    if (!q) return all;
    return all.filter((p) => p.podId.toLowerCase().includes(q));
  }, [state, podFilter]);

  const recentEvictionsByPod = useMemo(() => {
    const map = new Map<string, Map<number, number>>();
    const fromUs = Math.max(0, tUs - EVICTION_FLASH_WINDOW_US);
    const recent = timeline.eventsInRange(fromUs, tUs);
    for (const ev of recent) {
      if (ev.type !== "kv.block.evicted" || ev.tier !== "gpu") {
        continue;
      }
      const typed = ev as KVBlockEvictedEvent;
      let podMap = map.get(typed.pod_id);
      if (!podMap) {
        podMap = new Map<number, number>();
        map.set(typed.pod_id, podMap);
      }
      for (const bid of typed.block_ids) {
        podMap.set(bid, typed.t_us);
      }
    }
    return map;
  }, [timeline, tUs]);

  const pools = state.header.topology.pools;

  return (
    <div data-testid="gpu-map-view" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="view-header-row">
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>GPU HBM Anatomy &amp; Paged KV Cache Grid</h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Live block occupancy matched to BLIS snapshots, prefix sharing, and LRU eviction flashes.
          </div>
        </div>
        <SourceLinksChip
          glossaryTerm="KV Block"
          links={[
            { path: "sim/engine_driver.go", label: "Engine Driver", glossaryTerm: "Preemption" },
            { path: "sim/kv_block_tracker.go", label: "KV Block Tracker", glossaryTerm: "Prefix Cache" }
          ]}
        />
      </div>

      <EvictionPreemptionStrip
        timeline={timeline}
        state={state}
        tUs={tUs}
        podFilter={podFilter}
        reqFilter={reqFilter}
        onSeekUs={onSeekUs}
      />

      {pods.length === 0 ? (
        <div className="panel-card" style={{ color: "var(--text-secondary)" }}>
          No pods match the current filter.
        </div>
      ) : (
        <div className="gpu-pods-grid">
          {pods.map((pod) => {
            const pool = pools.find((p) => p.role === pod.poolRole) ?? pools[0];
            return (
              <PodGpuCard
                key={pod.podId}
                pod={pod}
                pool={pool}
                recentEvictions={recentEvictionsByPod.get(pod.podId) ?? new Map()}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};
