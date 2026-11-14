import React, { useCallback, useEffect, useMemo, useState } from "react";
import { GlossaryModal } from "./components/GlossaryModal.js";
import { PlaybackBar } from "./components/PlaybackBar.js";
import { ScenarioDrawer } from "./components/ScenarioDrawer.js";
import {
  loadScenario,
  loadScenarioManifest,
  type LoadedScenario,
  type ScenarioManifestEntry
} from "./data/scenarioLoader.js";
import { VIEW_REGISTRY } from "./registry/viewRegistry.js";
import {
  parseUrlState,
  replaceUrlState,
  type AppMode,
  type ViewId
} from "./state/urlState.js";
import { getTimelineMarkers, usePlayback } from "./state/usePlayback.js";
import { AccuracyView } from "./views/AccuracyView.js";
import { CompareView } from "./views/CompareView.js";
import { CustomRunView, type CustomSimulationResult } from "./views/CustomRunView.js";
import { EventLogView } from "./views/EventLogView.js";
import { GpuMapView } from "./views/GpuMapView.js";
import { MetricsView } from "./views/MetricsView.js";
import { MultiGpuView } from "./views/MultiGpuView.js";
import { PdSplitView } from "./views/PdSplitView.js";
import { RequestTimelineView } from "./views/RequestTimelineView.js";
import { RooflineView } from "./views/RooflineView.js";
import { RoutingExplainedView } from "./views/RoutingExplainedView.js";
import { TiersView } from "./views/TiersView.js";
import { TopologyView } from "./views/TopologyView.js";

const MODE_TABS: ReadonlyArray<{ id: AppMode; label: string }> = [
  { id: "guided", label: "Guided" },
  { id: "compare", label: "Compare" },
  { id: "custom", label: "Custom Run" },
  { id: "accuracy", label: "Accuracy" }
];

export const App: React.FC = () => {
  const initialUrl = useMemo(() => parseUrlState(window.location.search), []);

  const [manifestEntries, setManifestEntries] = useState<readonly ScenarioManifestEntry[]>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>(initialUrl.scenario);
  const [loadedScenario, setLoadedScenario] = useState<LoadedScenario | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<AppMode>(initialUrl.mode);
  const [view, setView] = useState<ViewId>(initialUrl.view);
  const [compareId, setCompareId] = useState<string | undefined>(initialUrl.compare);
  const [reqFilter, setReqFilter] = useState<string>(initialUrl.req ?? "");
  const [podFilter, setPodFilter] = useState<string>(initialUrl.pod ?? "");
  const [customSim, setCustomSim] = useState<CustomSimulationResult | null>(null);

  const [drawerCollapsed, setDrawerCollapsed] = useState<boolean>(false);
  const [glossaryOpen, setGlossaryOpen] = useState<boolean>(false);

  const activeTimeline = customSim ? customSim.timeline : loadedScenario?.timeline ?? null;
  const playback = usePlayback(activeTimeline, initialUrl.t, initialUrl.speed);
  const markers = useMemo(() => getTimelineMarkers(activeTimeline), [activeTimeline]);

  // Load manifest once on mount.
  useEffect(() => {
    let cancelled = false;
    loadScenarioManifest()
      .then((manifest) => {
        if (cancelled) return;
        setManifestEntries(manifest.scenarios);
        if (
          manifest.scenarios.length > 0 &&
          !manifest.scenarios.some((s) => s.id === selectedScenarioId)
        ) {
          setSelectedScenarioId(manifest.scenarios[0].id);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load selected scenario stream & metadata whenever selectedScenarioId or manifest updates.
  useEffect(() => {
    if (manifestEntries.length === 0) {
      return;
    }
    const entry = manifestEntries.find((s) => s.id === selectedScenarioId) ?? manifestEntries[0];
    if (!entry) return;

    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    loadScenario(entry)
      .then((loaded) => {
        if (cancelled) return;
        setLoadedScenario(loaded);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [manifestEntries, selectedScenarioId]);

  // Sync URL query parameters on any navigation/playback state change.
  useEffect(() => {
    replaceUrlState({
      scenario: selectedScenarioId,
      t: playback.tUs,
      speed: playback.speed,
      view,
      mode,
      compare: compareId,
      req: reqFilter.trim() || undefined,
      pod: podFilter.trim() || undefined
    });
  }, [selectedScenarioId, playback.tUs, playback.speed, view, mode, compareId, reqFilter, podFilter]);

  const handleSelectScenario = useCallback(
    (nextId: string) => {
      playback.pause();
      playback.seekUs(0);
      if (customSim?.injectedReqId && reqFilter === customSim.injectedReqId) {
        setReqFilter("");
      }
      setCustomSim(null);
      setSelectedScenarioId(nextId);
    },
    [playback, customSim, reqFilter]
  );

  const handleSelectMode = useCallback(
    (nextMode: AppMode) => {
      if (nextMode === "custom" || nextMode === "accuracy") {
        playback.pause();
      }
      setMode(nextMode);
    },
    [playback]
  );

  const handleSimulationReady = useCallback(
    (result: CustomSimulationResult) => {
      playback.pause();
      playback.seekUs(0);
      setCustomSim(result);
    },
    [playback]
  );

  const handleOpenCustomView = useCallback((nextView: ViewId, focusReqId?: string) => {
    setMode("guided");
    setView(nextView);
    if (focusReqId) {
      setReqFilter(focusReqId);
    }
  }, []);

  const handleClearCustomSim = useCallback(() => {
    playback.pause();
    playback.seekUs(0);
    if (customSim?.injectedReqId && reqFilter === customSim.injectedReqId) {
      setReqFilter("");
    }
    setCustomSim(null);
  }, [playback, customSim, reqFilter]);

  const handleJumpToMarker = useCallback(
    (tUs: number) => {
      playback.pause();
      playback.seekUs(tUs);
    },
    [playback]
  );

  const handleSelectPod = useCallback((pod: string) => {
    setPodFilter((prev) => (prev === pod ? "" : pod));
  }, []);

  const handleSelectRequest = useCallback((req: string) => {
    setReqFilter(req);
  }, []);

  const compareLeftEntry = useMemo<ScenarioManifestEntry | null>(() => {
    if (customSim) {
      return {
        id: "custom-run",
        title: customSim.title,
        subtitle: `Custom ${customSim.backend} simulation`,
        events_file: "__custom__",
        recommended_views: [],
        event_count: customSim.timeline.eventCount,
        duration_us: customSim.timeline.durationUs,
        completed_requests: 0,
        events_bytes: 0
      };
    }
    return loadedScenario?.entry ?? null;
  }, [customSim, loadedScenario]);

  const unknownEventCount = customSim
    ? customSim.unknownEventCount
    : loadedScenario?.unknownEventCount ?? 0;

  const blisMeta = activeTimeline?.header.blis;

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="top-bar-left">
          <button
            type="button"
            data-testid="drawer-toggle"
            onClick={() => setDrawerCollapsed((c) => !c)}
            title={drawerCollapsed ? "Show scenario guide" : "Hide scenario guide"}
          >
            {drawerCollapsed ? "Guide ›" : "‹ Guide"}
          </button>

          <div className="app-brand">
            <span className="brand-dot" />
            <span>BLIS // LLM Inference Viz</span>
          </div>

          <nav className="mode-tabs" aria-label="Application Mode">
            {MODE_TABS.map((m) => (
              <button
                key={m.id}
                type="button"
                data-testid={`mode-tab-${m.id}`}
                className={`mode-tab ${mode === m.id ? "active" : ""}`}
                onClick={() => handleSelectMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="top-bar-right">
          {blisMeta && (
            <div className="blis-badge" data-testid="blis-metadata-badge">
              <span>
                vLLM <code>{blisMeta.vllm_version}</code>
              </span>
              <span>·</span>
              <span>
                llm-d <code>{blisMeta.llmd_version}</code>
              </span>
              <span>·</span>
              <span>
                BLIS <code>{blisMeta.commit.slice(0, 8)}</code>
              </span>
            </div>
          )}

          <button
            type="button"
            data-testid="glossary-toggle"
            onClick={() => setGlossaryOpen(true)}
          >
            Glossary
          </button>
        </div>
      </header>

      {(mode === "guided" || mode === "compare") && (
        <PlaybackBar
          playing={playback.playing}
          speed={playback.speed}
          tUs={playback.tUs}
          durationUs={activeTimeline?.durationUs ?? 0}
          currentEventIndex={playback.currentEventIndex}
          eventCount={activeTimeline?.eventCount ?? 0}
          reqFilter={reqFilter}
          podFilter={podFilter}
          disabled={(loading && !customSim) || !activeTimeline}
          onTogglePlay={playback.togglePlay}
          onStepEvent={playback.stepEvent}
          onChangeSpeed={playback.setSpeed}
          onSeekUs={playback.seekUs}
          onChangeReqFilter={setReqFilter}
          onChangePodFilter={setPodFilter}
        />
      )}

      <div className="workspace-body">
        <ScenarioDrawer
          collapsed={drawerCollapsed}
          scenarios={manifestEntries}
          selectedScenarioId={selectedScenarioId}
          loadedScenario={loadedScenario}
          markers={markers}
          onSelectScenario={handleSelectScenario}
          onJumpToMarker={handleJumpToMarker}
        />

        <main className="main-pane">
          <div className="view-tab-strip" role="tablist" aria-label="Visualization Views">
            {VIEW_REGISTRY.map((slot) => (
              <button
                key={slot.id}
                type="button"
                role="tab"
                aria-selected={mode === "guided" && view === slot.id}
                data-testid={`view-tab-${slot.id}`}
                className={`view-tab ${mode === "guided" && view === slot.id ? "active" : ""} ${
                  slot.implemented ? "" : "pending"
                }`}
                onClick={() => {
                  setMode("guided");
                  setView(slot.id);
                }}
                title={slot.description}
              >
                {slot.label}
              </button>
            ))}
          </div>

          <div className="view-content">
            {loadError && !customSim && (
              <div className="error-banner" role="alert" data-testid="load-error">
                Failed to load scenario: {loadError}
              </div>
            )}

            {customSim && mode !== "custom" && (
              <div className="custom-sim-banner" data-testid="custom-sim-banner" role="status">
                <div className="custom-sim-banner-info">
                  <span className="badge badge-ready">Custom</span>
                  <span>
                    Custom Simulation Active ({customSim.backend}) —{" "}
                    <strong>{customSim.title}</strong>
                  </span>
                  {customSim.injectedReqId && (
                    <span className="badge badge-transfer mono">
                      Injected: {customSim.injectedReqId}
                    </span>
                  )}
                </div>
                <div className="custom-sim-banner-actions">
                  {customSim.injectedReqId && (
                    <button
                      type="button"
                      className="primary"
                      data-testid="focus-injected-req-btn"
                      onClick={() => {
                        const targetId = customSim.injectedReqId ?? "";
                        setReqFilter((prev) => (prev === targetId ? "" : targetId));
                      }}
                    >
                      {reqFilter === customSim.injectedReqId
                        ? `Clear Request Filter (${customSim.injectedReqId})`
                        : `Highlight ${customSim.injectedReqId}`}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="back-to-preset-btn"
                    onClick={handleClearCustomSim}
                  >
                    Back to Preset Scenario
                  </button>
                </div>
              </div>
            )}

            {unknownEventCount > 0 && (
              <div className="panel-card" style={{ marginBottom: 12, borderColor: "var(--sem-prefill)" }}>
                Loaded with {unknownEventCount} unrecognized event record(s). They
                are preserved safely in the Event Log.
              </div>
            )}

            {mode === "compare" ? (
              (loading && !customSim) || !activeTimeline || !compareLeftEntry ? (
                <div className="loading-box" data-testid="loading-indicator">
                  Loading and indexing BLIS simulation stream...
                </div>
              ) : (
                <CompareView
                  manifestEntries={manifestEntries}
                  leftEntry={compareLeftEntry}
                  leftTimeline={activeTimeline}
                  tUs={playback.tUs}
                  reqFilter={reqFilter}
                  podFilter={podFilter}
                  compareId={compareId}
                  onChangeCompareId={setCompareId}
                  onSeekUs={playback.seekUs}
                />
              )
            ) : mode === "custom" ? (
              <CustomRunView
                onSimulationReady={handleSimulationReady}
                onOpenView={handleOpenCustomView}
              />
            ) : mode === "accuracy" ? (
              <AccuracyView header={activeTimeline?.header} />
            ) : (loading && !customSim) || !activeTimeline || !playback.simState ? (
              <div className="loading-box" data-testid="loading-indicator">
                Loading and indexing BLIS simulation stream...
              </div>
            ) : view === "gpu-map" ? (
              <GpuMapView
                timeline={activeTimeline}
                state={playback.simState}
                tUs={playback.tUs}
                podFilter={podFilter}
                reqFilter={reqFilter}
                onSeekUs={playback.seekUs}
              />
            ) : view === "metrics" ? (
              <MetricsView
                timeline={activeTimeline}
                state={playback.simState}
                tUs={playback.tUs}
                onSeekUs={playback.seekUs}
              />
            ) : view === "event-log" ? (
              <EventLogView
                timeline={activeTimeline}
                tUs={playback.tUs}
                currentEventIndex={playback.currentEventIndex}
                reqFilter={reqFilter}
                podFilter={podFilter}
                onSeekUs={playback.seekUs}
              />
            ) : view === "topology" ? (
              <TopologyView
                timeline={activeTimeline}
                state={playback.simState}
                tUs={playback.tUs}
                reqFilter={reqFilter}
                podFilter={podFilter}
                onSelectPod={handleSelectPod}
                onSeekUs={playback.seekUs}
                onSelectRequest={handleSelectRequest}
              />
            ) : view === "request-timeline" ? (
              <RequestTimelineView
                timeline={activeTimeline}
                state={playback.simState}
                tUs={playback.tUs}
                reqFilter={reqFilter}
                podFilter={podFilter}
                onSeekUs={playback.seekUs}
                onSelectPod={handleSelectPod}
              />
            ) : view === "routing-explained" ? (
              <RoutingExplainedView
                timeline={activeTimeline}
                state={playback.simState}
                tUs={playback.tUs}
                reqFilter={reqFilter}
                podFilter={podFilter}
                onSeekUs={playback.seekUs}
                onSelectPod={handleSelectPod}
              />
            ) : view === "tiers" ? (
              <TiersView
                timeline={activeTimeline}
                state={playback.simState}
                tUs={playback.tUs}
                podFilter={podFilter}
                reqFilter={reqFilter}
                onSeekUs={playback.seekUs}
                onSwitchScenario={handleSelectScenario}
              />
            ) : view === "pd-split" ? (
              <PdSplitView
                timeline={activeTimeline}
                state={playback.simState}
                tUs={playback.tUs}
                reqFilter={reqFilter}
                podFilter={podFilter}
                onSeekUs={playback.seekUs}
                onSelectPod={handleSelectPod}
                onSwitchScenario={handleSelectScenario}
              />
            ) : view === "multi-gpu" ? (
              <MultiGpuView
                state={playback.simState}
                podFilter={podFilter}
                onSwitchScenario={handleSelectScenario}
              />
            ) : (
              <RooflineView
                state={playback.simState}
                podFilter={podFilter}
                onSeekUs={playback.seekUs}
              />
            )}
          </div>
        </main>
      </div>

      <GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
    </div>
  );
};
