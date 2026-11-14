import React, { useMemo } from "react";
import type { PoolConfig } from "@llm-viz/schema";
import { selectPods, type PodState, type SimState } from "../replay/index.js";
import { InfoHint } from "../components/GlossaryModal.js";
import { SourceLinksChip } from "../components/SourceLinksChip.js";

export interface MultiGpuViewProps {
  state: SimState;
  podFilter?: string;
  onSwitchScenario?: (scenarioId: string) => void;
}

const BYTES_PER_GIB = 1024 ** 3;

function formatGiB(bytes: number): string {
  return `${(bytes / BYTES_PER_GIB).toFixed(2)} GiB`;
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

export const MultiGpuView: React.FC<MultiGpuViewProps> = ({
  state,
  podFilter = "",
  onSwitchScenario
}) => {
  const allPods = useMemo(() => selectPods(state), [state]);
  const pods = useMemo(() => {
    const q = podFilter.trim().toLowerCase();
    if (!q) return allPods;
    return allPods.filter((p) => p.podId.toLowerCase().includes(q));
  }, [allPods, podFilter]);

  const pools = state.header.topology.pools;
  const allSingleGpu = useMemo(() => allPods.every((p) => p.tpDegree <= 1), [allPods]);

  return (
    <div data-testid="view-multi-gpu" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header & TP=1 CTA */}
      <div
        className="panel-card"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap"
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>Intra-Pod Multi-GPU Parallelism (TP / PP / DP)</h2>
            <InfoHint term="TP" />
            <InfoHint term="KV Block" />
          </div>
          <div style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 3 }}>
            Model: <code className="mono">{state.header.scenario.model}</code> · Hardware:{" "}
            <code className="mono">{state.header.scenario.hardware}</code> · Per-rank HBM sharding, KV heads, and NVLink AllReduce links.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <SourceLinksChip
            glossaryTerm="TP"
            links={[
              { path: "sim/cluster/cluster.go", label: "Cluster Topology", glossaryTerm: "TP" },
              { path: "sim/instance_config.go", label: "Instance & GPU Config" }
            ]}
          />
          {allSingleGpu && (
            <>
              <span className="badge badge-neutral">All pods are TP=1 in this scenario</span>
              {onSwitchScenario && (
                <button
                  type="button"
                  className="primary"
                  data-testid="cta-switch-07-pd-disaggregation"
                  onClick={() => onSwitchScenario("07-pd-disaggregation")}
                >
                  Inspect Llama-70B TP=2 (07-pd-disaggregation)
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Pool Parallelism Summary Strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 10
        }}
      >
        {pools.map((pool: PoolConfig, idx: number) => (
          <div
            key={`${pool.role}-${idx}`}
            className="kpi-card"
            data-testid={`pool-parallelism-${pool.role}`}
          >
            <div className="kpi-label">
              Pool: <span style={{ color: "var(--text-primary)" }}>{pool.role}</span> · {pool.replicas} replica(s)
            </div>
            <div className="kpi-value mono" style={{ fontSize: 16 }}>
              TP={pool.tp} · PP={pool.pp} · DP={pool.dp} · {pool.gpus_per_pod} GPU/pod
            </div>
            <div className="kpi-sub mono">
              {pool.gpu_type} · {pool.gpu_specs.memory_gib.toFixed(1)} GiB · {pool.gpu_specs.sm_count} SMs ·{" "}
              {pool.gpu_specs.bw_peak_tbs} TB/s
            </div>
          </div>
        ))}
      </div>

      {pods.length === 0 ? (
        <div className="panel-card" style={{ color: "var(--text-secondary)" }}>
          No pods match the current filter.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {pods.map((pod) => {
            const pool = pools.find((p) => p.role === pod.poolRole) ?? pools[0];
            const specs = pool.gpu_specs;
            const mb = pool.memory_breakdown_bytes;
            const totalGpuBytes = Math.max(1, specs.memory_gib * BYTES_PER_GIB);
            const fixedBytes = mb.weights + mb.activation_peak + mb.cuda_graph + mb.comm_buffers;
            const kvPoolBytes = Math.max(0, totalGpuBytes - fixedBytes);
            const rankCount = Math.max(1, pod.gpuIds.length, pod.tpDegree, pool.gpus_per_pod);

            const weightsPct = (mb.weights / totalGpuBytes) * 100;
            const kvUsedRatio = pod.kvTotalBlocks > 0 ? pod.kvUsedBlocks / pod.kvTotalBlocks : 0;
            const kvCachedRatio = pod.kvTotalBlocks > 0 ? pod.kvCachedBlocks / pod.kvTotalBlocks : 0;
            const kvPoolPct = (kvPoolBytes / totalGpuBytes) * 100;
            const actCommBytes = mb.activation_peak + mb.comm_buffers + mb.cuda_graph;
            const actCommPct = (actCommBytes / totalGpuBytes) * 100;

            return (
              <div
                key={pod.podId}
                className="pod-card"
                data-testid={`multi-gpu-pod-${pod.podId}`}
              >
                {/* Pod Header */}
                <div className="pod-header">
                  <div className="pod-title-group">
                    <span className="pod-id mono">{pod.podId}</span>
                    <span className="badge badge-neutral">{pod.poolRole}</span>
                    <span className={`badge ${getPodStatusBadgeClass(pod.status)}`}>{pod.status}</span>
                    <span className="badge badge-decode mono">tp_degree={pod.tpDegree}</span>
                    <span className="badge badge-neutral mono">pp={pool.pp}</span>
                    <span className="badge badge-neutral mono">dp={pool.dp}</span>
                    <span className="badge badge-neutral mono">gpus_per_pod={pool.gpus_per_pod}</span>
                  </div>
                  <div className="pod-meta mono">
                    gpu_ids=[{pod.gpuIds.join(", ")}]
                  </div>
                </div>

                {/* NVLink / TP AllReduce Interconnect Indicator */}
                {pod.tpDegree > 1 ? (
                  <div
                    data-testid={`nvlink-banner-${pod.podId}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 6,
                      background: "var(--sem-transfer-bg)",
                      border: "1px solid rgba(192, 132, 252, 0.45)",
                      flexWrap: "wrap"
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="badge badge-transfer mono">NVLink / TP AllReduce</span>
                      <span style={{ fontSize: 12, color: "var(--text-primary)" }}>
                        {pod.tpDegree}-way Tensor Parallel synchronization across{" "}
                        <span className="mono">{pod.gpuIds.join(" <-> ")}</span>
                      </span>
                    </div>
                    <span className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                      Total weights across pod: {formatGiB(mb.weights * pod.tpDegree)} ({formatGiB(mb.weights)} / GPU)
                    </span>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: "6px 10px",
                      borderRadius: 6,
                      background: "var(--bg-inset)",
                      border: "1px solid var(--border-subtle)",
                      fontSize: 11.5,
                      color: "var(--text-secondary)"
                    }}
                  >
                    Single-GPU pod (<span className="mono">tp_degree=1</span>) — no intra-pod TP AllReduce required.
                  </div>
                )}

                {/* Per-GPU Rank Cards with Interconnect Links */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "stretch",
                    gap: 10,
                    flexWrap: "wrap"
                  }}
                >
                  {Array.from({ length: rankCount }, (_, rank) => {
                    const gpuId = pod.gpuIds[rank] ?? `${pod.podId}-gpu-${rank}`;
                    const ppStage = pool.pp > 1 ? Math.floor((rank * pool.pp) / rankCount) : 0;

                    return (
                      <React.Fragment key={gpuId}>
                        <div
                          data-testid={`gpu-rank-card-${pod.podId}-${rank}`}
                          style={{
                            flex: "1 1 280px",
                            background: "var(--bg-inset)",
                            border: "1px solid var(--border-strong)",
                            borderRadius: 8,
                            padding: 12,
                            display: "flex",
                            flexDirection: "column",
                            gap: 9
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                            <div>
                              <span className="mono" style={{ fontWeight: 700, fontSize: 13 }}>
                                GPU #{rank}
                              </span>{" "}
                              <span className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                                ({gpuId})
                              </span>
                            </div>
                            <div style={{ display: "flex", gap: 4 }}>
                              <span className="badge badge-neutral mono">{pool.gpu_type}</span>
                              {pool.pp > 1 && (
                                <span className="badge badge-prefill mono">PP {ppStage}</span>
                              )}
                            </div>
                          </div>

                          {/* Hardware Specs */}
                          <div
                            className="mono"
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                              gap: "4px 10px",
                              fontSize: 11.5,
                              padding: "6px 8px",
                              background: "var(--bg-surface)",
                              borderRadius: 6,
                              border: "1px solid var(--border-subtle)"
                            }}
                          >
                            <div>
                              <span style={{ color: "var(--text-muted)" }}>HBM:</span>{" "}
                              {specs.memory_gib.toFixed(1)} GiB
                            </div>
                            <div>
                              <span style={{ color: "var(--text-muted)" }}>SMs:</span> {specs.sm_count}
                            </div>
                            <div>
                              <span style={{ color: "var(--text-muted)" }}>BF16:</span> {specs.tflops_peak} TF
                              {specs.tflops_fp8 > 0 ? ` · FP8: ${specs.tflops_fp8} TF` : ""}
                            </div>
                            <div>
                              <span style={{ color: "var(--text-muted)" }}>BW:</span> {specs.bw_peak_tbs} TB/s
                            </div>
                          </div>

                          {/* Per-GPU HBM Sharded Bar */}
                          <div className="hbm-bar-track" title="Per-GPU HBM allocation">
                            <div
                              className="hbm-segment"
                              style={{ width: `${weightsPct.toFixed(2)}%`, background: "#64748b" }}
                              title={`Weights / GPU: ${formatGiB(mb.weights)}`}
                            />
                            <div
                              className="hbm-segment"
                              style={{
                                width: `${(kvPoolPct * kvUsedRatio).toFixed(2)}%`,
                                background: "#38bdf8"
                              }}
                              title={`Active KV shard: ${pod.kvUsedBlocks} / ${pod.kvTotalBlocks} blocks`}
                            />
                            <div
                              className="hbm-segment"
                              style={{
                                width: `${(kvPoolPct * kvCachedRatio).toFixed(2)}%`,
                                background: "#10b981"
                              }}
                              title={`Cached KV shard: ${pod.kvCachedBlocks} / ${pod.kvTotalBlocks} blocks`}
                            />
                            <div
                              className="hbm-segment"
                              style={{ width: `${actCommPct.toFixed(2)}%`, background: "#f59e0b" }}
                              title={`Activations + CUDA Graphs + Comm Buffers: ${formatGiB(actCommBytes)}`}
                            />
                          </div>

                          {/* Sharded Memory Breakdown */}
                          <div
                            className="mono"
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr auto",
                              gap: "3px 10px",
                              fontSize: 11.5
                            }}
                          >
                            <span style={{ color: "var(--text-secondary)" }}>
                              Weights / GPU {pod.tpDegree > 1 ? `(1/${pod.tpDegree} TP shard)` : "(replicated)"}
                            </span>
                            <span>{formatGiB(mb.weights)}</span>

                            <span style={{ color: "var(--text-secondary)" }}>
                              KV Shard ({pod.tpDegree > 1 ? `1/${pod.tpDegree} heads` : "full"})
                            </span>
                            <span>
                              <span style={{ color: "var(--sem-decode)" }}>{pod.kvUsedBlocks}u</span> +{" "}
                              <span style={{ color: "var(--sem-cached)" }}>{pod.kvCachedBlocks}c</span> /{" "}
                              {pod.kvTotalBlocks} blk ({formatGiB(kvPoolBytes)})
                            </span>

                            <span style={{ color: "var(--text-secondary)" }}>Activation Peak</span>
                            <span>{formatGiB(mb.activation_peak)}</span>

                            <span style={{ color: "var(--text-secondary)" }}>CUDA Graph</span>
                            <span>{formatGiB(mb.cuda_graph)}</span>

                            <span style={{ color: "var(--text-secondary)" }}>Comm Buffers</span>
                            <span>{formatGiB(mb.comm_buffers)}</span>
                          </div>
                        </div>

                        {/* Visual NVLink connector between adjacent ranks */}
                        {pod.tpDegree > 1 && rank < rankCount - 1 && (
                          <div
                            aria-label={`NVLink AllReduce link between GPU #${rank} and GPU #${rank + 1}`}
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              justifyContent: "center",
                              padding: "4px 6px",
                              color: "var(--sem-transfer)",
                              fontSize: 10.5,
                              fontWeight: 700
                            }}
                          >
                            <span className="mono">NVLink</span>
                            <span className="mono" style={{ fontSize: 14 }}>
                              &lt;-&gt;
                            </span>
                            <span className="mono">AllReduce</span>
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
