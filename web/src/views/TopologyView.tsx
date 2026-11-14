import React, { useMemo, useState } from "react";
import type {
  KVTransferEvent,
  RequestArrivedEvent,
  RequestFinishedEvent,
  RequestRoutedEvent
} from "@llm-viz/schema";
import { SourceLinksChip } from "../components/SourceLinksChip.js";
import {
  selectActiveKVTransfers,
  selectFinalSummary,
  selectPods,
  selectRequestsForPod,
  type PodState,
  type PoolRole,
  type ReplayTimeline,
  type SimState
} from "../replay/index.js";

export interface TopologyViewProps {
  timeline: ReplayTimeline;
  state: SimState;
  tUs: number;
  reqFilter?: string;
  podFilter?: string;
  onSelectPod?: (podId: string) => void;
  onSeekUs?: (tUs: number) => void;
  onSelectRequest?: (reqId: string) => void;
}

const WINDOW_US = 200_000;
const SVG_W = 1120;
const POD_CARD_W = 300;
const POD_CARD_H = 104;
const POD_GAP_Y = 14;
const GROUP_HEADER_H = 26;
const GROUP_PAD_B = 14;
const GROUP_GAP_Y = 18;

const POOL_ORDER: readonly PoolRole[] = ["prefill", "decode", "colocated", "encode"];

type InspectionTarget =
  | { readonly kind: "gateway" }
  | { readonly kind: "pod"; readonly podId: string }
  | { readonly kind: "request"; readonly reqId: string };

interface PodLayout {
  readonly pod: PodState;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface PoolGroupLayout {
  readonly role: PoolRole;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly pods: readonly PodLayout[];
}

function cubicPoint(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number
): { x: number; y: number } {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y
  };
}

function podStatusColor(status: PodState["status"]): {
  stroke: string;
  pillBg: string;
  pillText: string;
} {
  switch (status) {
    case "ready":
      return { stroke: "#22c55e", pillBg: "rgba(34, 197, 94, 0.16)", pillText: "#22c55e" };
    case "loading":
      return { stroke: "#f59e0b", pillBg: "rgba(245, 158, 11, 0.16)", pillText: "#f59e0b" };
    case "draining":
      return { stroke: "#f97316", pillBg: "rgba(249, 115, 22, 0.18)", pillText: "#f97316" };
    case "terminated":
      return { stroke: "#475569", pillBg: "rgba(100, 116, 139, 0.16)", pillText: "#94a3b8" };
  }
}

function batchPhaseStyle(phase?: "prefill" | "decode" | "mixed"): {
  label: string;
  bg: string;
  color: string;
} {
  switch (phase) {
    case "prefill":
      return { label: "prefill", bg: "rgba(245, 158, 11, 0.18)", color: "#f59e0b" };
    case "decode":
      return { label: "decode", bg: "rgba(56, 189, 248, 0.18)", color: "#38bdf8" };
    case "mixed":
      return { label: "mixed", bg: "rgba(168, 85, 247, 0.18)", color: "#c084fc" };
    default:
      return { label: "idle", bg: "rgba(100, 116, 139, 0.16)", color: "#94a3b8" };
  }
}

export const TopologyView: React.FC<TopologyViewProps> = ({
  timeline,
  state,
  tUs,
  reqFilter = "",
  podFilter = "",
  onSelectPod,
  onSeekUs,
  onSelectRequest
}) => {
  const [inspect, setInspect] = useState<InspectionTarget>({ kind: "gateway" });

  const pods = useMemo(() => selectPods(state), [state]);
  const summary = useMemo(() => selectFinalSummary(state), [state]);
  const activeTransfers = useMemo(() => selectActiveKVTransfers(state), [state]);

  const windowFromUs = Math.max(0, tUs - WINDOW_US);
  const windowEvents = useMemo(
    () => timeline.eventsInRange(windowFromUs, tUs),
    [timeline, windowFromUs, tUs]
  );

  const recentArrivals = useMemo(
    () => windowEvents.filter((e): e is RequestArrivedEvent => e.type === "request.arrived"),
    [windowEvents]
  );
  const recentRouted = useMemo(
    () => windowEvents.filter((e): e is RequestRoutedEvent => e.type === "request.routed"),
    [windowEvents]
  );
  const recentFinished = useMemo(
    () => windowEvents.filter((e): e is RequestFinishedEvent => e.type === "request.finished"),
    [windowEvents]
  );
  const recentTransfers = useMemo(
    () => windowEvents.filter((e): e is KVTransferEvent => e.type === "kv.transfer"),
    [windowEvents]
  );

  const reqQuery = reqFilter.trim().toLowerCase();
  const podQuery = podFilter.trim().toLowerCase();

  // Compute SVG layout for pool groups and pods
  const { groups, podCenterMap, svgHeight } = useMemo(() => {
    const byRole = new Map<PoolRole, PodState[]>();
    for (const role of POOL_ORDER) {
      byRole.set(role, []);
    }
    for (const pod of pods) {
      const list = byRole.get(pod.poolRole) ?? [];
      list.push(pod);
      byRole.set(pod.poolRole, list);
    }

    const groupLayouts: PoolGroupLayout[] = [];
    const centers = new Map<string, { leftX: number; rightX: number; y: number }>();
    let curY = 24;
    const groupX = 510;
    const groupW = POD_CARD_W + 28;

    for (const role of POOL_ORDER) {
      const list = (byRole.get(role) ?? []).slice().sort((a, b) => a.podId.localeCompare(b.podId));
      if (list.length === 0) continue;

      const podLayouts: PodLayout[] = [];
      let podY = curY + GROUP_HEADER_H + 6;
      for (const pod of list) {
        const x = groupX + 14;
        podLayouts.push({ pod, x, y: podY, w: POD_CARD_W, h: POD_CARD_H });
        centers.set(pod.podId, {
          leftX: x,
          rightX: x + POD_CARD_W,
          y: podY + POD_CARD_H / 2
        });
        podY += POD_CARD_H + POD_GAP_Y;
      }

      const groupH = GROUP_HEADER_H + 6 + list.length * POD_CARD_H + (list.length - 1) * POD_GAP_Y + GROUP_PAD_B;
      groupLayouts.push({
        role,
        x: groupX,
        y: curY,
        w: groupW,
        h: groupH,
        pods: podLayouts
      });
      curY += groupH + GROUP_GAP_Y;
    }

    const totalH = Math.max(360, curY + 12);
    return { groups: groupLayouts, podCenterMap: centers, svgHeight: totalH };
  }, [pods]);

  const midY = svgHeight / 2;
  const arrivalsBox = { x: 24, y: midY - 64, w: 170, h: 128 };
  const gatewayBox = { x: 248, y: midY - 86, w: 196, h: 172 };
  const outputBox = { x: 924, y: midY - 68, w: 172, h: 136 };

  // Merge activeTransfers + recent window kv.transfer events for cross-pod arc display
  const transferArcs = useMemo(() => {
    const seen = new Set<string>();
    const arcs: Array<{
      key: string;
      reqId: string;
      fromPod: string;
      toPod: string;
      numKVBlocks: number;
      active: boolean;
      progress: number;
    }> = [];

    for (const tr of activeTransfers) {
      seen.add(tr.key);
      const elapsed = Math.max(0, tUs - tr.startedAtUs);
      arcs.push({
        key: tr.key,
        reqId: tr.reqId,
        fromPod: tr.fromPod,
        toPod: tr.toPod,
        numKVBlocks: tr.numKVBlocks,
        active: true,
        progress: Math.min(0.95, 0.15 + (elapsed / WINDOW_US) * 0.8)
      });
    }

    for (const ev of recentTransfers) {
      const key =
        ev.transfer_id !== undefined
          ? String(ev.transfer_id)
          : `${ev.req_id}:${ev.from_pod}->${ev.to_pod}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const progress = Math.max(0, Math.min(1, (tUs - ev.t_us) / WINDOW_US));
      arcs.push({
        key,
        reqId: ev.req_id,
        fromPod: ev.from_pod,
        toPod: ev.to_pod,
        numKVBlocks: ev.num_kv_blocks,
        active: ev.status === "started",
        progress
      });
    }
    return arcs;
  }, [activeTransfers, recentTransfers, tUs]);

  // Selected inspection details
  const inspectedPod = inspect.kind === "pod" ? state.pods.get(inspect.podId) : undefined;
  const inspectedPodReqs = useMemo(
    () => (inspectedPod ? selectRequestsForPod(state, inspectedPod.podId) : undefined),
    [state, inspectedPod]
  );
  const inspectedReq = inspect.kind === "request" ? state.requests.get(inspect.reqId) : undefined;

  return (
    <div data-testid="view-topology" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
          <h2 style={{ margin: 0, fontSize: 15 }}>Cluster Topology &amp; Live Request Flow</h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Animated 200 ms lookback window (
            <span className="mono">
              {(windowFromUs / 1000).toFixed(1)} – {(tUs / 1000).toFixed(1)} ms
            </span>
            ) · Click any pod, the gateway, or a recent request badge to inspect.
          </div>
        </div>
        <SourceLinksChip
          glossaryTerm="EPP"
          links={[
            { path: "sim/cluster/cluster.go", label: "Cluster", glossaryTerm: "P/D Split" },
            { path: "sim/llmd/gateway.go", label: "llm-d Gateway", glossaryTerm: "EPP" },
            { path: "sim/engine_driver.go", label: "Engine Driver" }
          ]}
        />
      </div>

      {/* Main Interactive Topology SVG */}
      <div className="panel-card" style={{ padding: 10, overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${SVG_W} ${svgHeight}`}
          style={{ width: "100%", minWidth: 820, height: "auto", display: "block" }}
          role="img"
          aria-label="Cluster topology and request flow diagram"
        >
          <defs>
            <pattern
              id="draining-stripes"
              width="8"
              height="8"
              patternTransform="rotate(45 0 0)"
              patternUnits="userSpaceOnUse"
            >
              <rect width="8" height="8" fill="#162032" />
              <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(249, 115, 22, 0.28)" strokeWidth="3" />
            </pattern>
            <marker id="arrow-flow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569" />
            </marker>
            <marker id="arrow-kv" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="#c084fc" />
            </marker>
          </defs>

          {/* Static structural edges: Arrivals -> Gateway */}
          <line
            x1={arrivalsBox.x + arrivalsBox.w}
            y1={midY}
            x2={gatewayBox.x - 4}
            y2={midY}
            stroke="#2f415d"
            strokeWidth={2}
            markerEnd="url(#arrow-flow)"
          />

          {/* Edges: Gateway -> each Pod */}
          {groups.flatMap((g) =>
            g.pods.map(({ pod, x, y, h }) => {
              const start = { x: gatewayBox.x + gatewayBox.w, y: midY };
              const end = { x: x - 4, y: y + h / 2 };
              const c1 = { x: start.x + 36, y: start.y };
              const c2 = { x: end.x - 36, y: end.y };
              const isMatchPod = !podQuery || pod.podId.toLowerCase().includes(podQuery);
              const isSelected = inspect.kind === "pod" && inspect.podId === pod.podId;
              return (
                <path
                  key={`gw->${pod.podId}`}
                  d={`M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`}
                  fill="none"
                  stroke={isSelected ? "#58a6ff" : "#24344d"}
                  strokeWidth={isSelected ? 2.2 : 1.5}
                  opacity={isMatchPod ? 0.9 : 0.25}
                  markerEnd="url(#arrow-flow)"
                />
              );
            })
          )}

          {/* Edges: each Pod -> Output Stream */}
          {groups.flatMap((g) =>
            g.pods.map(({ pod, x, y, w, h }) => {
              const start = { x: x + w, y: y + h / 2 };
              const end = { x: outputBox.x - 4, y: midY };
              const c1 = { x: start.x + 36, y: start.y };
              const c2 = { x: end.x - 36, y: end.y };
              const isMatchPod = !podQuery || pod.podId.toLowerCase().includes(podQuery);
              return (
                <path
                  key={`${pod.podId}->out`}
                  d={`M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`}
                  fill="none"
                  stroke="#1f2b3e"
                  strokeWidth={1.5}
                  opacity={isMatchPod ? 0.85 : 0.25}
                  markerEnd="url(#arrow-flow)"
                />
              );
            })
          )}

          {/* Arrivals / Clients Node */}
          <g>
            <rect
              x={arrivalsBox.x}
              y={arrivalsBox.y}
              width={arrivalsBox.w}
              height={arrivalsBox.h}
              rx={10}
              fill="#0f1623"
              stroke="#2f415d"
              strokeWidth={1.5}
            />
            <text x={arrivalsBox.x + 14} y={arrivalsBox.y + 24} fill="#e6edf7" fontSize={13} fontWeight={700}>
              Arrivals / Clients
            </text>
            <text x={arrivalsBox.x + 14} y={arrivalsBox.y + 46} fill="#9fb0c9" fontSize={11.5}>
              Total Arrived
            </text>
            <text
              x={arrivalsBox.x + arrivalsBox.w - 14}
              y={arrivalsBox.y + 46}
              textAnchor="end"
              fill="#e6edf7"
              fontSize={13}
              fontWeight={700}
              fontFamily="var(--font-mono)"
            >
              {state.gateway.totalArrived}
            </text>
            <text x={arrivalsBox.x + 14} y={arrivalsBox.y + 68} fill="#9fb0c9" fontSize={11.5}>
              Last 200ms
            </text>
            <text
              x={arrivalsBox.x + arrivalsBox.w - 14}
              y={arrivalsBox.y + 68}
              textAnchor="end"
              fill="#58a6ff"
              fontSize={12}
              fontWeight={600}
              fontFamily="var(--font-mono)"
            >
              {recentArrivals.length} req
            </text>
            <text x={arrivalsBox.x + 14} y={arrivalsBox.y + 92} fill="#6c7f9c" fontSize={10.5}>
              Model: {state.header.scenario.model.split("/").pop()}
            </text>
            <text x={arrivalsBox.x + 14} y={arrivalsBox.y + 110} fill="#6c7f9c" fontSize={10.5}>
              HW: {state.header.scenario.hardware}
            </text>
          </g>

          {/* llm-d Gateway Node */}
          <g
            style={{ cursor: "pointer" }}
            onClick={() => setInspect({ kind: "gateway" })}
            data-testid="topology-gateway-node"
          >
            <rect
              x={gatewayBox.x}
              y={gatewayBox.y}
              width={gatewayBox.w}
              height={gatewayBox.h}
              rx={10}
              fill="#162032"
              stroke={inspect.kind === "gateway" ? "#58a6ff" : "#2f415d"}
              strokeWidth={inspect.kind === "gateway" ? 2 : 1.5}
            />
            <text x={gatewayBox.x + 14} y={gatewayBox.y + 24} fill="#e6edf7" fontSize={13} fontWeight={700}>
              llm-d Gateway (EPP)
            </text>
            <text x={gatewayBox.x + 14} y={gatewayBox.y + 42} fill="#6c7f9c" fontSize={10.5}>
              Policy: {state.header.scenario.routing_policy ?? "default"}
            </text>

            {/* Queue Depth Pill */}
            <rect
              x={gatewayBox.x + 14}
              y={gatewayBox.y + 52}
              width={gatewayBox.w - 28}
              height={24}
              rx={6}
              fill="#0b1019"
              stroke="#1f2b3e"
            />
            <text x={gatewayBox.x + 22} y={gatewayBox.y + 68} fill="#9fb0c9" fontSize={11}>
              Gateway Queue
            </text>
            <text
              x={gatewayBox.x + gatewayBox.w - 22}
              y={gatewayBox.y + 68}
              textAnchor="end"
              fill={state.gateway.queueDepth > 0 ? "#f59e0b" : "#22c55e"}
              fontSize={12}
              fontWeight={700}
              fontFamily="var(--font-mono)"
            >
              {state.gateway.queueDepth}
            </text>

            <text x={gatewayBox.x + 14} y={gatewayBox.y + 94} fill="#9fb0c9" fontSize={11}>
              Admitted / Rejected / Timeout
            </text>
            <text
              x={gatewayBox.x + 14}
              y={gatewayBox.y + 111}
              fill="#e6edf7"
              fontSize={11.5}
              fontFamily="var(--font-mono)"
            >
              {state.gateway.totalAdmitted} /{" "}
              <tspan fill={state.gateway.totalRejected > 0 ? "#fb7185" : "#9fb0c9"}>
                {state.gateway.totalRejected}
              </tspan>{" "}
              /{" "}
              <tspan fill={state.gateway.totalTimedOut > 0 ? "#f97316" : "#9fb0c9"}>
                {state.gateway.totalTimedOut}
              </tspan>
            </text>

            <text x={gatewayBox.x + 14} y={gatewayBox.y + 132} fill="#6c7f9c" fontSize={10.5}>
              Recent Dispatches (200ms):
            </text>
            {recentRouted.slice(-2).map((ev, idx) => (
              <g
                key={`${ev.seq}-${ev.req_id}`}
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  setInspect({ kind: "request", reqId: ev.req_id });
                  onSelectRequest?.(ev.req_id);
                }}
              >
                <rect
                  x={gatewayBox.x + 14 + idx * 86}
                  y={gatewayBox.y + 140}
                  width={82}
                  height={20}
                  rx={5}
                  fill="rgba(88, 166, 255, 0.14)"
                  stroke="rgba(88, 166, 255, 0.4)"
                />
                <text
                  x={gatewayBox.x + 55 + idx * 86}
                  y={gatewayBox.y + 153}
                  textAnchor="middle"
                  fill="#cfe6ff"
                  fontSize={10}
                  fontFamily="var(--font-mono)"
                >
                  {ev.req_id.replace("request_", "req_")}
                </text>
              </g>
            ))}
          </g>

          {/* Pool Groups & Pod Cards */}
          {groups.map((group) => {
            const poolCfg = state.header.topology.pools.find((p) => p.role === group.role);
            return (
              <g key={group.role}>
                <rect
                  x={group.x}
                  y={group.y}
                  width={group.w}
                  height={group.h}
                  rx={10}
                  fill="rgba(15, 22, 35, 0.65)"
                  stroke="#2f415d"
                  strokeDasharray="4,4"
                />
                <text
                  x={group.x + 14}
                  y={group.y + 18}
                  fill="#9fb0c9"
                  fontSize={11}
                  fontWeight={700}
                  style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
                >
                  {group.role} pool ({group.pods.length})
                </text>
                {poolCfg && (
                  <text
                    x={group.x + group.w - 14}
                    y={group.y + 18}
                    textAnchor="end"
                    fill="#6c7f9c"
                    fontSize={10.5}
                    fontFamily="var(--font-mono)"
                  >
                    TP={poolCfg.tp} · {poolCfg.gpu_type}
                  </text>
                )}

                {group.pods.map(({ pod, x, y, w, h }) => {
                  const st = podStatusColor(pod.status);
                  const batch = batchPhaseStyle(pod.lastBatchStep?.phase);
                  const kvTotal = Math.max(1, pod.kvTotalBlocks);
                  const activeFrac = Math.min(1, pod.kvUsedBlocks / kvTotal);
                  const cachedFrac = Math.min(1 - activeFrac, pod.kvCachedBlocks / kvTotal);
                  const kvBarW = w - 24;
                  const isTerminated = pod.status === "terminated";
                  const isDraining = pod.status === "draining";
                  const isSelected = inspect.kind === "pod" && inspect.podId === pod.podId;
                  const isFilteredOut = Boolean(podQuery && !pod.podId.toLowerCase().includes(podQuery));

                  return (
                    <g
                      key={pod.podId}
                      data-testid={`topology-pod-${pod.podId}`}
                      style={{ cursor: "pointer" }}
                      opacity={isFilteredOut ? 0.3 : isTerminated ? 0.48 : 1}
                      onClick={() => {
                        setInspect({ kind: "pod", podId: pod.podId });
                        onSelectPod?.(pod.podId);
                      }}
                    >
                      <rect
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        rx={8}
                        fill={isDraining ? "url(#draining-stripes)" : "#0f1623"}
                        stroke={isSelected ? "#58a6ff" : st.stroke}
                        strokeWidth={isSelected ? 2.2 : 1.5}
                      >
                        {isDraining && (
                          <animate
                            attributeName="stroke-opacity"
                            values="1;0.35;1"
                            dur="1.4s"
                            repeatCount="indefinite"
                          />
                        )}
                      </rect>

                      {/* Header row: pod_id, pool_role, state pill */}
                      <text
                        x={x + 12}
                        y={y + 20}
                        fill="#e6edf7"
                        fontSize={12.5}
                        fontWeight={700}
                        fontFamily="var(--font-mono)"
                      >
                        {pod.podId}
                      </text>
                      <text x={x + 12} y={y + 34} fill="#6c7f9c" fontSize={10}>
                        {pod.poolRole} · TP={pod.tpDegree}
                      </text>

                      {/* State Pill */}
                      <rect x={x + w - 82} y={y + 8} width={70} height={18} rx={9} fill={st.pillBg} />
                      <text
                        x={x + w - 47}
                        y={y + 20}
                        textAnchor="middle"
                        fill={st.pillText}
                        fontSize={10}
                        fontWeight={700}
                      >
                        {pod.status}
                      </text>

                      {/* Batch Phase Badge + Queue/Run + Preemptions */}
                      <rect x={x + 12} y={y + 42} width={56} height={18} rx={9} fill={batch.bg} />
                      <text
                        x={x + 40}
                        y={y + 54}
                        textAnchor="middle"
                        fill={batch.color}
                        fontSize={10}
                        fontWeight={600}
                      >
                        {batch.label}
                      </text>

                      <text
                        x={x + 76}
                        y={y + 55}
                        fill="#9fb0c9"
                        fontSize={10.5}
                        fontFamily="var(--font-mono)"
                      >
                        Q:{pod.queuedRequestIds.size} R:{pod.runningRequestIds.size}
                      </text>

                      {pod.preemptions > 0 && (
                        <g>
                          <rect
                            x={x + w - 76}
                            y={y + 42}
                            width={64}
                            height={18}
                            rx={9}
                            fill="rgba(239, 68, 68, 0.18)"
                          />
                          <text
                            x={x + w - 44}
                            y={y + 54}
                            textAnchor="middle"
                            fill="#ef4444"
                            fontSize={10}
                            fontWeight={700}
                            fontFamily="var(--font-mono)"
                          >
                            pre:{pod.preemptions}
                          </text>
                        </g>
                      )}

                      {/* KV Utilization Bar */}
                      <text x={x + 12} y={y + 76} fill="#6c7f9c" fontSize={10}>
                        KV HBM
                      </text>
                      <text
                        x={x + w - 12}
                        y={y + 76}
                        textAnchor="end"
                        fill="#9fb0c9"
                        fontSize={10}
                        fontFamily="var(--font-mono)"
                      >
                        {pod.kvUsedBlocks}+{pod.kvCachedBlocks}/{pod.kvTotalBlocks} (
                        {(((pod.kvUsedBlocks + pod.kvCachedBlocks) / kvTotal) * 100).toFixed(0)}%)
                      </text>
                      <rect
                        x={x + 12}
                        y={y + 82}
                        width={kvBarW}
                        height={10}
                        rx={4}
                        fill="#0b1019"
                        stroke="#1f2b3e"
                      />
                      {activeFrac > 0 && (
                        <rect
                          x={x + 12}
                          y={y + 82}
                          width={Math.max(2, kvBarW * activeFrac)}
                          height={10}
                          rx={4}
                          fill="#38bdf8"
                        />
                      )}
                      {cachedFrac > 0 && (
                        <rect
                          x={x + 12 + kvBarW * activeFrac}
                          y={y + 82}
                          width={Math.max(2, kvBarW * cachedFrac)}
                          height={10}
                          fill="#10b981"
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* Cross-Pod KV Transfer Arcs (P/D disaggregation) */}
          {transferArcs.map((arc, idx) => {
            const fromCenter = podCenterMap.get(arc.fromPod);
            const toCenter = podCenterMap.get(arc.toPod);
            if (!fromCenter || !toCenter) return null;
            const ctrlX = fromCenter.rightX + 36 + (idx % 3) * 14;
            const start = { x: fromCenter.rightX, y: fromCenter.y };
            const end = { x: toCenter.rightX, y: toCenter.y };
            const c1 = { x: ctrlX, y: start.y };
            const c2 = { x: ctrlX, y: end.y };
            const pt = cubicPoint(start, c1, c2, end, arc.progress);
            const matchesReq = !reqQuery || arc.reqId.toLowerCase().includes(reqQuery);
            return (
              <g key={`kv-${arc.key}`} opacity={matchesReq ? 1 : 0.25}>
                <path
                  d={`M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`}
                  fill="none"
                  stroke="#c084fc"
                  strokeWidth={arc.active ? 2.4 : 1.5}
                  strokeDasharray="5,4"
                  markerEnd="url(#arrow-kv)"
                />
                <circle cx={pt.x} cy={pt.y} r={5} fill="#c084fc" stroke="#090d14" strokeWidth={1.5} />
                <text
                  x={ctrlX + 6}
                  y={(start.y + end.y) / 2}
                  fill="#c084fc"
                  fontSize={10}
                  fontFamily="var(--font-mono)"
                >
                  {arc.numKVBlocks} blks
                </text>
              </g>
            );
          })}

          {/* Animated Flow Packets: Arrivals -> Gateway */}
          {recentArrivals.slice(-16).map((ev) => {
            const p = Math.max(0, Math.min(1, (tUs - ev.t_us) / WINDOW_US));
            const x = arrivalsBox.x + arrivalsBox.w + p * (gatewayBox.x - (arrivalsBox.x + arrivalsBox.w) - 6);
            const matchesReq = !reqQuery || ev.req_id.toLowerCase().includes(reqQuery);
            return (
              <circle
                key={`arr-${ev.seq}`}
                cx={x}
                cy={midY}
                r={4}
                fill="#58a6ff"
                opacity={matchesReq ? 0.95 : 0.2}
              />
            );
          })}

          {/* Animated Flow Packets: Gateway -> Chosen Pod */}
          {recentRouted.slice(-24).map((ev) => {
            const targetPod = podCenterMap.get(ev.chosen_pod);
            if (!targetPod) return null;
            const p = Math.max(0, Math.min(1, (tUs - ev.t_us) / WINDOW_US));
            const start = { x: gatewayBox.x + gatewayBox.w, y: midY };
            const end = { x: targetPod.leftX - 4, y: targetPod.y };
            const pt = cubicPoint(start, { x: start.x + 36, y: start.y }, { x: end.x - 36, y: end.y }, end, p);
            const matchesReq = !reqQuery || ev.req_id.toLowerCase().includes(reqQuery);
            return (
              <g
                key={`route-${ev.seq}`}
                style={{ cursor: "pointer" }}
                opacity={matchesReq ? 1 : 0.2}
                onClick={() => {
                  setInspect({ kind: "request", reqId: ev.req_id });
                  onSelectRequest?.(ev.req_id);
                }}
              >
                <circle cx={pt.x} cy={pt.y} r={5} fill="#f59e0b" stroke="#090d14" strokeWidth={1.5} />
              </g>
            );
          })}

          {/* Animated Flow Packets: Pod -> Output Stream */}
          {recentFinished.slice(-18).map((ev) => {
            const srcPod = podCenterMap.get(ev.pod_id);
            if (!srcPod) return null;
            const p = Math.max(0, Math.min(1, (tUs - ev.t_us) / WINDOW_US));
            const start = { x: srcPod.rightX, y: srcPod.y };
            const end = { x: outputBox.x - 4, y: midY };
            const pt = cubicPoint(start, { x: start.x + 36, y: start.y }, { x: end.x - 36, y: end.y }, end, p);
            const matchesReq = !reqQuery || ev.req_id.toLowerCase().includes(reqQuery);
            return (
              <circle
                key={`fin-${ev.seq}`}
                cx={pt.x}
                cy={pt.y}
                r={4.5}
                fill="#10b981"
                stroke="#090d14"
                strokeWidth={1.2}
                opacity={matchesReq ? 0.95 : 0.2}
              />
            );
          })}

          {/* Output Stream Node */}
          <g>
            <rect
              x={outputBox.x}
              y={outputBox.y}
              width={outputBox.w}
              height={outputBox.h}
              rx={10}
              fill="#0f1623"
              stroke="#2f415d"
              strokeWidth={1.5}
            />
            <text x={outputBox.x + 14} y={outputBox.y + 24} fill="#e6edf7" fontSize={13} fontWeight={700}>
              Output Stream
            </text>
            <text x={outputBox.x + 14} y={outputBox.y + 48} fill="#9fb0c9" fontSize={11.5}>
              Completed
            </text>
            <text
              x={outputBox.x + outputBox.w - 14}
              y={outputBox.y + 48}
              textAnchor="end"
              fill="#22c55e"
              fontSize={13}
              fontWeight={700}
              fontFamily="var(--font-mono)"
            >
              {summary.completedRequests}
            </text>
            <text x={outputBox.x + 14} y={outputBox.y + 70} fill="#9fb0c9" fontSize={11.5}>
              Tokens
            </text>
            <text
              x={outputBox.x + outputBox.w - 14}
              y={outputBox.y + 70}
              textAnchor="end"
              fill="#38bdf8"
              fontSize={12}
              fontWeight={600}
              fontFamily="var(--font-mono)"
            >
              {state.clusterTotals.totalOutputTokens}
            </text>
            <text x={outputBox.x + 14} y={outputBox.y + 92} fill="#9fb0c9" fontSize={11.5}>
              Throughput
            </text>
            <text
              x={outputBox.x + outputBox.w - 14}
              y={outputBox.y + 92}
              textAnchor="end"
              fill="#e6edf7"
              fontSize={12}
              fontFamily="var(--font-mono)"
            >
              {(summary.outputTokS > 0 ? summary.outputTokS : summary.snapshotOutputTokS ?? 0).toFixed(0)} tok/s
            </text>
            <text x={outputBox.x + 14} y={outputBox.y + 114} fill="#6c7f9c" fontSize={10.5}>
              Recent Finishes: {recentFinished.length}
            </text>
          </g>
        </svg>
      </div>

      {/* Interactive Selection Inspector Strip */}
      <div className="panel-card" data-testid="topology-inspector">
        {inspect.kind === "pod" && inspectedPod ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong className="mono">{inspectedPod.podId}</strong>
                <span className="badge badge-neutral">{inspectedPod.poolRole}</span>
                <span className={`badge badge-${inspectedPod.status === "ready" ? "ready" : inspectedPod.status === "draining" ? "draining" : "neutral"}`}>
                  {inspectedPod.status}
                </span>
                {inspectedPod.drainReason && (
                  <span style={{ fontSize: 11.5, color: "var(--sem-draining)" }}>
                    reason: {inspectedPod.drainReason}
                  </span>
                )}
              </div>
              <span className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                GPUs: {inspectedPod.gpuIds.join(", ")} · Completed: {inspectedPod.completedRequests} · Preemptions:{" "}
                {inspectedPod.preemptions}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Running ({inspectedPodReqs?.running.length ?? 0}):{" "}
              <span className="mono">
                {inspectedPodReqs && inspectedPodReqs.running.length > 0
                  ? inspectedPodReqs.running.map((r) => r.reqId).join(", ")
                  : "none"}
              </span>{" "}
              · Queued ({inspectedPodReqs?.queued.length ?? 0}):{" "}
              <span className="mono">
                {inspectedPodReqs && inspectedPodReqs.queued.length > 0
                  ? inspectedPodReqs.queued.map((r) => r.reqId).join(", ")
                  : "none"}
              </span>
            </div>
          </div>
        ) : inspect.kind === "request" && inspectedReq ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong className="mono">{inspectedReq.reqId}</strong>
                <span className="badge badge-decode">{inspectedReq.status}</span>
                {inspectedReq.assignedPod && (
                  <span className="badge badge-neutral mono">pod: {inspectedReq.assignedPod}</span>
                )}
              </div>
              {onSeekUs && inspectedReq.routedAtUs !== undefined && (
                <button type="button" onClick={() => onSeekUs(inspectedReq.routedAtUs!)}>
                  Seek to routed ({(inspectedReq.routedAtUs / 1000).toFixed(1)} ms)
                </button>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }} className="mono">
              prompt={inspectedReq.promptTokens} · computed={inspectedReq.computedTokens} · emitted=
              {inspectedReq.emittedTokens}/{inspectedReq.maxOutputTokens} · cached={inspectedReq.cachedTokens}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div>
              <strong>llm-d Gateway Inspector</strong>
              <span style={{ marginLeft: 10, fontSize: 12, color: "var(--text-secondary)" }}>
                Queue depth <span className="mono">{state.gateway.queueDepth}</span> · Last decision:{" "}
                <span className="mono">
                  {state.gateway.lastRoutingDecision
                    ? `${state.gateway.lastRoutingDecision.reqId} -> ${state.gateway.lastRoutingDecision.chosenPod}`
                    : "none yet"}
                </span>
              </span>
            </div>
            <div style={{ display: "flex", gap: 10, fontSize: 11.5, color: "var(--text-secondary)" }}>
              <span>● Blue: Arrival</span>
              <span style={{ color: "var(--sem-prefill)" }}>● Amber: Routed</span>
              <span style={{ color: "var(--sem-transfer)" }}>● Purple: KV Transfer</span>
              <span style={{ color: "var(--sem-cached)" }}>● Green: Finished</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
