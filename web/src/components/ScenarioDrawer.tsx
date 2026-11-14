import React from "react";
import type { LoadedScenario, ScenarioManifestEntry } from "../data/scenarioLoader.js";
import type { MarkerKind, TimelineMarker } from "../state/usePlayback.js";
import { NarrativeRenderer } from "./NarrativeRenderer.js";

export interface ScenarioDrawerProps {
  collapsed: boolean;
  scenarios: readonly ScenarioManifestEntry[];
  selectedScenarioId: string;
  loadedScenario: LoadedScenario | null;
  markers: readonly TimelineMarker[];
  onSelectScenario: (scenarioId: string) => void;
  onJumpToMarker: (tUs: number) => void;
}

const MARKER_BADGE_CLASS: Record<MarkerKind, string> = {
  eviction: "badge-evicted",
  preemption: "badge-preempted",
  move: "badge-cpu_dram",
  transfer: "badge-transfer",
  "scale-up": "badge-ready",
  "scale-down": "badge-draining"
};

function summarizeRoutingPolicy(raw: string | undefined): string {
  if (!raw) return "default";
  if (raw.startsWith("llm-d:")) {
    if (raw.includes("always-disagg-pd-decider")) return "llm-d P/D disagg";
    if (raw.includes("prefix-cache-scorer")) return "llm-d prefix + queue scorer";
    if (raw.includes("active-request-scorer")) return "llm-d active-request scorer";
    return "llm-d EPP";
  }
  return raw;
}

export const ScenarioDrawer: React.FC<ScenarioDrawerProps> = ({
  collapsed,
  scenarios,
  selectedScenarioId,
  loadedScenario,
  markers,
  onSelectScenario,
  onJumpToMarker
}) => {
  const activeEntry = scenarios.find((s) => s.id === selectedScenarioId) ?? loadedScenario?.entry;
  const header = loadedScenario?.timeline.header;

  return (
    <aside className={`scenario-drawer ${collapsed ? "collapsed" : ""}`} aria-label="Scenario Guide">
      <div className="drawer-section">
        <h3 className="drawer-section-title">Scenario</h3>
        <select
          className="scenario-select"
          data-testid="scenario-select"
          aria-label="Select Scenario"
          value={selectedScenarioId}
          onChange={(e) => onSelectScenario(e.target.value)}
        >
          {scenarios.map((sc) => (
            <option key={sc.id} value={sc.id}>
              {sc.title}
            </option>
          ))}
        </select>
        {activeEntry && <div className="scenario-subtitle">{activeEntry.subtitle}</div>}
      </div>

      {markers.length > 0 && (
        <div className="drawer-section">
          <h3 className="drawer-section-title">Timeline Bookmarks</h3>
          <div className="bookmark-list">
            {markers.map((marker) => (
              <button
                key={marker.id}
                type="button"
                className="bookmark-btn"
                data-testid={`marker-${marker.id}`}
                onClick={() => onJumpToMarker(marker.tUs)}
                title={`Jump to ${(marker.tUs / 1000).toFixed(2)} ms (event #${marker.eventIndex + 1})`}
              >
                <span className={`badge ${MARKER_BADGE_CLASS[marker.kind]}`}>{marker.label}</span>
                <span className="mono">{(marker.tUs / 1000).toFixed(1)}ms</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {header && (
        <div className="drawer-section">
          <h3 className="drawer-section-title">BLIS Configuration</h3>
          <dl className="flags-grid">
            <dt>Model</dt>
            <dd className="mono">{header.scenario.model}</dd>
            <dt>Hardware</dt>
            <dd className="mono">{header.scenario.hardware}</dd>
            <dt>Seed</dt>
            <dd className="mono">{header.scenario.seed}</dd>
            <dt>Routing</dt>
            <dd>{summarizeRoutingPolicy(header.scenario.routing_policy)}</dd>
            <dt>Pools</dt>
            <dd className="mono">
              {header.topology.pools
                .map((p) => `${p.replicas}x ${p.role} (TP=${p.tp}, ${p.gpu_type})`)
                .join(", ")}
            </dd>
            <dt>Tiers</dt>
            <dd className="mono">
              GPU {header.topology.tiers.gpu_hbm_blocks} blk
              {header.topology.tiers.cpu_ram_blocks > 0
                ? ` + CPU ${header.topology.tiers.cpu_ram_blocks} blk`
                : ""}
            </dd>
          </dl>
        </div>
      )}

      {loadedScenario && (
        <div className="drawer-section" style={{ borderBottom: "none" }}>
          <h3 className="drawer-section-title">Scenario Guide</h3>
          <NarrativeRenderer markdown={loadedScenario.narrativeMd} />
        </div>
      )}
    </aside>
  );
};
