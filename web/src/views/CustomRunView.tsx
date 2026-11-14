import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PRESET_SPECS,
  resolvePresetSpec,
  type CanonicalPresetId,
  type InjectedRequestConfig,
  type PresetId,
  type RoutingPolicy,
  type SimulationRunConfig
} from "@llm-viz/local-runner/config";
import { parseScenarioNDJSON } from "../data/scenarioLoader.js";
import type { ReplayTimeline } from "../replay/timeline.js";
import type { ViewId } from "../state/urlState.js";
import { isWasmSupported, runBlisWasm } from "../wasm/wasmClient.js";

export type RoutingPolicyChoice = RoutingPolicy;
export type BackendChoice = "auto" | "wasm" | "local-runner";

export interface CustomSimulationResult {
  readonly title: string;
  readonly timeline: ReplayTimeline;
  readonly backend: "local-runner" | "wasm";
  readonly commandArgs: readonly string[];
  readonly injectedReqId?: string;
  readonly rawResult: unknown;
  readonly unknownEventCount: number;
}

export interface CustomRunViewProps {
  readonly onSimulationReady: (result: CustomSimulationResult) => void;
  readonly onOpenView?: (view: ViewId, focusReqId?: string) => void;
  readonly localRunnerUrl?: string; // defaults to "http://127.0.0.1:4190"
}

interface RunnerHealthState {
  readonly status: "checking" | "online" | "offline";
  readonly binary?: string;
  readonly error?: string;
}

interface LastRunSummary {
  readonly result: CustomSimulationResult;
  readonly elapsedMs: number;
  readonly warningCount: number;
}

const DEFAULT_LOCAL_RUNNER_URL = "http://127.0.0.1:4190";
const HEALTH_PROBE_TIMEOUT_MS = 2500;

const ROUTING_OPTIONS: ReadonlyArray<{
  readonly id: RoutingPolicyChoice;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    id: "prefix-cache",
    label: "Prefix Cache (prefix-cache)",
    hint: "Weighted prefix-cache hit scorer + queue + KV utilization"
  },
  {
    id: "least-loaded",
    label: "Least Loaded (least-loaded)",
    hint: "Balances queue depth and KV cache utilization"
  },
  {
    id: "round-robin",
    label: "Round Robin (round-robin)",
    hint: "Uniform random/round-robin picker across ready pods"
  }
];

function parsePositiveIntInput(label: string, raw: string): number {
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error(`${label} must be an integer >= 1.`);
  }
  return num;
}

function parseNonNegativeIntInput(label: string, raw: string): number {
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 0) {
    throw new Error(`${label} must be an integer >= 0.`);
  }
  return num;
}

function parseIntegerInput(label: string, raw: string): number {
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    throw new Error(`${label} must be an integer.`);
  }
  return num;
}

function parsePositiveFloatInput(label: string, raw: string): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return num;
}

function parseNonNegativeFloatInput(label: string, raw: string): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return num;
}

export const CustomRunView: React.FC<CustomRunViewProps> = ({
  onSimulationReady,
  onOpenView,
  localRunnerUrl = DEFAULT_LOCAL_RUNNER_URL
}) => {
  const normalizedRunnerUrl = useMemo(
    () => localRunnerUrl.trim().replace(/\/+$/, "") || DEFAULT_LOCAL_RUNNER_URL,
    [localRunnerUrl]
  );

  const wasmSupported = useMemo(() => isWasmSupported(), []);

  // Backend selector & health probe state
  const [runnerHealth, setRunnerHealth] = useState<RunnerHealthState>({ status: "checking" });
  const [backendChoice, setBackendChoice] = useState<BackendChoice>("auto");
  const probeIdRef = useRef(0);

  const probeRunnerHealth = useCallback(async () => {
    const currentProbeId = ++probeIdRef.current;
    setRunnerHealth({ status: "checking" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);

    try {
      const res = await fetch(`${normalizedRunnerUrl}/health`, {
        method: "GET",
        signal: controller.signal
      });
      if (probeIdRef.current !== currentProbeId) return;

      let payload: Record<string, unknown> | null = null;
      try {
        payload = (await res.json()) as Record<string, unknown>;
      } catch {
        payload = null;
      }

      if (res.ok && payload && payload.ok === true) {
        setRunnerHealth({
          status: "online",
          binary: typeof payload.binary === "string" ? payload.binary : undefined
        });
      } else {
        const msg =
          payload && typeof payload.error === "string"
            ? payload.error
            : `HTTP ${res.status} ${res.statusText}`;
        setRunnerHealth({ status: "offline", error: msg });
      }
    } catch (err) {
      if (probeIdRef.current !== currentProbeId) return;
      setRunnerHealth({
        status: "offline",
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      clearTimeout(timer);
    }
  }, [normalizedRunnerUrl]);

  useEffect(() => {
    void probeRunnerHealth();
    return () => {
      probeIdRef.current += 1;
    };
  }, [probeRunnerHealth]);

  // Simulation form fields
  const [preset, setPreset] = useState<PresetId>("llama-3.1-8b-instruct");
  const [numRequests, setNumRequests] = useState<string>("16");
  const [rate, setRate] = useState<string>("4");
  const [promptTokens, setPromptTokens] = useState<string>("64");
  const [outputTokens, setOutputTokens] = useState<string>("32");
  const [prefixTokens, setPrefixTokens] = useState<string>("0");
  const [maxNumSeqs, setMaxNumSeqs] = useState<string>("");
  const [gpuMemUtil, setGpuMemUtil] = useState<string>("");
  const [routingPolicy, setRoutingPolicy] = useState<RoutingPolicyChoice>("least-loaded");
  const [numInstances, setNumInstances] = useState<string>("1");
  const [disaggregated, setDisaggregated] = useState<boolean>(false);
  const [prefillInstances, setPrefillInstances] = useState<string>("1");
  const [decodeInstances, setDecodeInstances] = useState<string>("1");
  const [offloadCpuGib, setOffloadCpuGib] = useState<string>("0");
  const [seed, setSeed] = useState<string>("42");

  // Single-request injection fields
  const [injectEnabled, setInjectEnabled] = useState<boolean>(false);
  const [injectArrivalS, setInjectArrivalS] = useState<string>("0.5");
  const [injectPromptTokens, setInjectPromptTokens] = useState<string>("128");
  const [injectOutputTokens, setInjectOutputTokens] = useState<string>("64");
  const [injectPrefixGroup, setInjectPrefixGroup] = useState<string>("shared");

  // Execution state
  const [running, setRunning] = useState<boolean>(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<LastRunSummary | null>(null);

  const presetSpec = useMemo(() => resolvePresetSpec(preset), [preset]);

  const effectiveBackend: "local-runner" | "wasm" =
    backendChoice === "local-runner"
      ? "local-runner"
      : backendChoice === "wasm"
        ? "wasm"
        : runnerHealth.status === "online"
          ? "local-runner"
          : "wasm";

  const derivedTotalInstances = useMemo(() => {
    if (!disaggregated) {
      return Number(numInstances) || 1;
    }
    return (Number(prefillInstances) || 0) + (Number(decodeInstances) || 0);
  }, [disaggregated, numInstances, prefillInstances, decodeInstances]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setRunError(null);

    let config: SimulationRunConfig;
    let parsedInstances: number;
    let parsedPrefill = 0;
    let parsedDecode = 0;

    try {
      const parsedNumRequests = parsePositiveIntInput("Requests", numRequests);
      const parsedRate = parsePositiveFloatInput("Arrival rate", rate);
      const parsedPrompt = parsePositiveIntInput("Prompt tokens", promptTokens);
      const parsedOutput = parsePositiveIntInput("Output tokens", outputTokens);
      const parsedPrefix = parseNonNegativeIntInput("Prefix tokens", prefixTokens);
      const parsedOffload = parseNonNegativeFloatInput("CPU offload (GiB)", offloadCpuGib);
      const parsedSeed = parseIntegerInput("Seed", seed);

      let parsedMaxSeqs: number | undefined;
      if (maxNumSeqs.trim() !== "") {
        parsedMaxSeqs = parsePositiveIntInput("max_num_seqs", maxNumSeqs);
      }

      let parsedGpuMemUtil: number | undefined;
      if (gpuMemUtil.trim() !== "") {
        const val = Number(gpuMemUtil);
        if (!Number.isFinite(val) || val <= 0 || val > 1) {
          throw new Error("gpu_memory_utilization must be in (0, 1].");
        }
        parsedGpuMemUtil = val;
      }

      if (disaggregated) {
        parsedPrefill = parsePositiveIntInput("Prefill instances", prefillInstances);
        parsedDecode = parsePositiveIntInput("Decode instances", decodeInstances);
        parsedInstances = parsedPrefill + parsedDecode;
      } else {
        parsedInstances = parsePositiveIntInput("Instances", numInstances);
      }

      let injectedReq: InjectedRequestConfig | undefined;
      if (injectEnabled) {
        const arrivalS = parseNonNegativeFloatInput("Injected arrival (s)", injectArrivalS);
        const injPrompt = parsePositiveIntInput("Injected prompt tokens", injectPromptTokens);
        const injOutput = parsePositiveIntInput("Injected output tokens", injectOutputTokens);
        const trimmedGroup = injectPrefixGroup.trim();
        injectedReq = {
          arrival_s: arrivalS,
          prompt_tokens: injPrompt,
          output_tokens: injOutput,
          ...(trimmedGroup ? { prefix_group: trimmedGroup } : {})
        };
      }

      config = {
        preset,
        num_requests: parsedNumRequests,
        rate: parsedRate,
        prompt_tokens: parsedPrompt,
        output_tokens: parsedOutput,
        prefix_tokens: parsedPrefix,
        ...(parsedMaxSeqs !== undefined ? { max_num_seqs: parsedMaxSeqs } : {}),
        ...(parsedGpuMemUtil !== undefined ? { gpu_memory_utilization: parsedGpuMemUtil } : {}),
        routing_policy: routingPolicy,
        num_instances: parsedInstances,
        ...(disaggregated
          ? { prefill_instances: parsedPrefill, decode_instances: parsedDecode }
          : {}),
        offload_cpu_gib: parsedOffload,
        seed: parsedSeed,
        ...(injectedReq ? { injected_request: injectedReq } : {})
      };
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      return;
    }

    if (effectiveBackend === "wasm" && !wasmSupported) {
      setRunError(
        "Browser WebAssembly Worker + DecompressionStream('gzip') is not supported in this browser."
      );
      return;
    }

    setRunning(true);
    const t0 = performance.now();

    try {
      let ndjson: string;
      let rawResult: unknown;
      let commandArgs: string[];
      let injectedReqId: string | undefined;

      if (effectiveBackend === "local-runner") {
        const res = await fetch(`${normalizedRunnerUrl}/api/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config)
        });
        const payload = (await res.json()) as {
          ok?: boolean;
          error?: string;
          ndjson?: string;
          result?: unknown;
          commandArgs?: string[];
          injectedReqId?: string;
        };
        if (!res.ok || !payload.ok || typeof payload.ndjson !== "string") {
          throw new Error(
            payload.error || `Local runner request failed (HTTP ${res.status} ${res.statusText})`
          );
        }
        ndjson = payload.ndjson;
        rawResult = payload.result ?? {};
        commandArgs = Array.isArray(payload.commandArgs) ? payload.commandArgs : [];
        injectedReqId = payload.injectedReqId;
      } else {
        const wasmOut = await runBlisWasm(config);
        ndjson = wasmOut.ndjson;
        rawResult = wasmOut.result;
        commandArgs = wasmOut.commandArgs;
        injectedReqId = wasmOut.injectedReqId;
      }

      const parsed = parseScenarioNDJSON(ndjson);
      const elapsedMs = Math.max(1, Math.round(performance.now() - t0));

      const topologyLabel = disaggregated
        ? `${parsedPrefill}P+${parsedDecode}D`
        : `${parsedInstances}x`;
      const title = `Custom · ${presetSpec.model} (${topologyLabel}, ${routingPolicy})`;

      const simResult: CustomSimulationResult = {
        title,
        timeline: parsed.timeline,
        backend: effectiveBackend,
        commandArgs,
        ...(injectedReqId !== undefined ? { injectedReqId } : {}),
        rawResult,
        unknownEventCount: parsed.unknownEventCount
      };

      setLastRun({
        result: simResult,
        elapsedMs,
        warningCount: parsed.issues.length
      });
      onSimulationReady(simResult);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const labelStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 12,
    color: "var(--text-secondary)"
  };

  const sectionTitleStyle: React.CSSProperties = {
    margin: "0 0 10px 0",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)"
  };

  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 10
  };

  return (
    <div data-testid="view-custom-run" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header */}
      <div className="panel-card view-header-row">
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>Custom Simulation Runner</h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 3 }}>
            Configure a BLIS v0.32.0 + llm-d v1.0.0 scenario, optionally inject a single tracked
            request, and replay the resulting event stream across every view.
          </div>
        </div>
        <span className="badge badge-neutral mono">
          Active Backend: {effectiveBackend === "local-runner" ? "local-runner" : "wasm"}
        </span>
      </div>

      {/* Backend Selector & Health Probe */}
      <div
        className="panel-card"
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <div className="view-header-row">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Execution Backend</span>
            {runnerHealth.status === "online" ? (
              <span className="badge badge-ready" data-testid="runner-health-status">
                Local Native Runner (Online)
              </span>
            ) : runnerHealth.status === "checking" ? (
              <span className="badge badge-neutral" data-testid="runner-health-status">
                Probing Local Runner ({normalizedRunnerUrl})...
              </span>
            ) : (
              <span className="badge badge-prefill" data-testid="runner-health-status">
                Local Runner Offline — Using Browser WASM (26.4 MB gzipped)
              </span>
            )}
          </div>

          <button
            type="button"
            data-testid="recheck-runner-btn"
            onClick={() => void probeRunnerHealth()}
            disabled={runnerHealth.status === "checking" || running}
          >
            Recheck Runner
          </button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 10
          }}
        >
          <div
            data-testid="custom-backend-select"
            role="radiogroup"
            aria-label="Simulation Execution Backend"
            style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
          >
            {(
              [
                { id: "auto", label: "Auto" },
                { id: "wasm", label: "Browser WASM" },
                { id: "local-runner", label: "Local Runner" }
              ] as const
            ).map((opt) => {
              const selected = backendChoice === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`backend-option-${opt.id}`}
                  className={`view-tab ${selected ? "active" : ""}`}
                  onClick={() => setBackendChoice(opt.id)}
                  disabled={running}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {runnerHealth.status === "online" && runnerHealth.binary
              ? `Binary: ${runnerHealth.binary}`
              : `Health URL: ${normalizedRunnerUrl}/health`}
          </div>
        </div>

        {backendChoice === "local-runner" && runnerHealth.status === "offline" && (
          <div style={{ fontSize: 11.5, color: "var(--sem-prefill)" }}>
            Local runner is offline ({runnerHealth.error ?? "unreachable"}). Start it with{" "}
            <code className="mono">pnpm --filter @llm-viz/local-runner start</code> or switch to{" "}
            <strong>Auto</strong> / <strong>Browser WASM</strong>.
          </div>
        )}

        {!wasmSupported && effectiveBackend === "wasm" && (
          <div className="error-banner" style={{ marginBottom: 0 }}>
            Browser WebAssembly Workers or <code>DecompressionStream(&apos;gzip&apos;)</code> are
            unavailable in this browser environment.
          </div>
        )}
      </div>

      {/* Simulation Form */}
      <form
        data-testid="custom-run-form"
        onSubmit={(e) => void handleSubmit(e)}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        {/* Model & Hardware Preset */}
        <div className="panel-card">
          <h3 style={sectionTitleStyle}>Model &amp; Hardware Preset</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={labelStyle}>
              <span>Calibrated BLIS Preset</span>
              <select
                data-testid="input-preset"
                value={preset}
                onChange={(e) => setPreset(e.target.value as PresetId)}
                disabled={running}
              >
                {(Object.keys(PRESET_SPECS) as CanonicalPresetId[]).map((id) => (
                  <option key={id} value={id}>
                    {PRESET_SPECS[id].label}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span className="badge badge-neutral mono">model: {presetSpec.model}</span>
              <span className="badge badge-neutral mono">hw: {presetSpec.hardware}</span>
              <span className="badge badge-neutral mono">TP={presetSpec.tp}</span>
              <span className="badge badge-neutral mono">block_size={presetSpec.blockSize}</span>
              <span className="badge badge-neutral mono">max_model_len={presetSpec.maxModelLen}</span>
              {presetSpec.quantization && (
                <span className="badge badge-decode mono">
                  quant: {presetSpec.quantization} / kv: {presetSpec.kvCacheDtype ?? "auto"}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Workload & Engine Parameters */}
        <div className="panel-card">
          <h3 style={sectionTitleStyle}>Workload &amp; Engine Limits</h3>
          <div style={gridStyle}>
            <label style={labelStyle}>
              <span>num_requests</span>
              <input
                type="number"
                min={1}
                step={1}
                value={numRequests}
                onChange={(e) => setNumRequests(e.target.value)}
                disabled={running}
                required
              />
            </label>

            <label style={labelStyle}>
              <span>rate (req/s)</span>
              <input
                type="number"
                min={0.01}
                step="any"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                disabled={running}
                required
              />
            </label>

            <label style={labelStyle}>
              <span>prompt_tokens</span>
              <input
                type="number"
                min={1}
                step={1}
                value={promptTokens}
                onChange={(e) => setPromptTokens(e.target.value)}
                disabled={running}
                required
              />
            </label>

            <label style={labelStyle}>
              <span>output_tokens</span>
              <input
                type="number"
                min={1}
                step={1}
                value={outputTokens}
                onChange={(e) => setOutputTokens(e.target.value)}
                disabled={running}
                required
              />
            </label>

            <label style={labelStyle}>
              <span>prefix_tokens</span>
              <input
                type="number"
                min={0}
                step={1}
                value={prefixTokens}
                onChange={(e) => setPrefixTokens(e.target.value)}
                disabled={running}
                required
              />
            </label>

            <label style={labelStyle}>
              <span>max_num_seqs (optional)</span>
              <input
                type="number"
                min={1}
                step={1}
                placeholder="BLIS default"
                value={maxNumSeqs}
                onChange={(e) => setMaxNumSeqs(e.target.value)}
                disabled={running}
              />
            </label>

            <label style={labelStyle}>
              <span>gpu_memory_utilization (optional)</span>
              <input
                type="number"
                min={0.05}
                max={1}
                step="any"
                placeholder="BLIS default (0.9)"
                value={gpuMemUtil}
                onChange={(e) => setGpuMemUtil(e.target.value)}
                disabled={running}
              />
            </label>

            <label style={labelStyle}>
              <span>seed</span>
              <input
                type="number"
                step={1}
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                disabled={running}
                required
              />
            </label>
          </div>
        </div>

        {/* Routing, Topology & Memory Offload */}
        <div className="panel-card">
          <h3 style={sectionTitleStyle}>Routing, Topology &amp; CPU Offload</h3>
          <div style={gridStyle}>
            <label style={labelStyle}>
              <span>routing_policy</span>
              <select
                value={routingPolicy}
                onChange={(e) => setRoutingPolicy(e.target.value as RoutingPolicyChoice)}
                disabled={running}
              >
                {ROUTING_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={labelStyle}>
              <span>num_instances {disaggregated ? "(P + D)" : ""}</span>
              <input
                type="number"
                min={1}
                step={1}
                value={disaggregated ? String(derivedTotalInstances) : numInstances}
                onChange={(e) => setNumInstances(e.target.value)}
                disabled={running || disaggregated}
                required
              />
            </label>

            <label style={labelStyle}>
              <span>offload_cpu_gib (CPU DRAM tier)</span>
              <input
                type="number"
                min={0}
                step="any"
                value={offloadCpuGib}
                onChange={(e) => setOffloadCpuGib(e.target.value)}
                disabled={running}
                required
              />
            </label>
          </div>

          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                fontSize: 12.5
              }}
            >
              <input
                type="checkbox"
                data-testid="disaggregated-pd-toggle"
                checked={disaggregated}
                onChange={(e) => setDisaggregated(e.target.checked)}
                disabled={running}
              />
              <span>
                Enable Disaggregated Prefill / Decode (P/D Split via{" "}
                <code className="mono">NixlConnector</code>)
              </span>
            </label>

            {disaggregated && (
              <div style={gridStyle}>
                <label style={labelStyle}>
                  <span>prefill_instances</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={prefillInstances}
                    onChange={(e) => setPrefillInstances(e.target.value)}
                    disabled={running}
                    required
                  />
                </label>

                <label style={labelStyle}>
                  <span>decode_instances</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={decodeInstances}
                    onChange={(e) => setDecodeInstances(e.target.value)}
                    disabled={running}
                    required
                  />
                </label>
              </div>
            )}
          </div>
        </div>

        {/* Single-Request Injection */}
        <div className="panel-card" data-testid="inject-request-section">
          <div className="view-header-row" style={{ marginBottom: injectEnabled ? 10 : 0 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
                Single-Request Injection
              </h3>
              <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
                Inject a deterministic probe request at a target timestamp to trace its routing,
                KV allocation, and step-by-step latency.
              </div>
            </div>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: 500
              }}
            >
              <input
                type="checkbox"
                data-testid="inject-toggle"
                checked={injectEnabled}
                onChange={(e) => setInjectEnabled(e.target.checked)}
                disabled={running}
              />
              <span>Inject Request</span>
            </label>
          </div>

          {injectEnabled && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={gridStyle}>
                <label style={labelStyle}>
                  <span>arrival_s (seconds)</span>
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={injectArrivalS}
                    onChange={(e) => setInjectArrivalS(e.target.value)}
                    disabled={running}
                    required
                  />
                </label>

                <label style={labelStyle}>
                  <span>prompt_tokens</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={injectPromptTokens}
                    onChange={(e) => setInjectPromptTokens(e.target.value)}
                    disabled={running}
                    required
                  />
                </label>

                <label style={labelStyle}>
                  <span>output_tokens</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={injectOutputTokens}
                    onChange={(e) => setInjectOutputTokens(e.target.value)}
                    disabled={running}
                    required
                  />
                </label>

                <label style={labelStyle}>
                  <span>prefix_group (optional)</span>
                  <input
                    type="text"
                    placeholder="e.g. shared"
                    value={injectPrefixGroup}
                    onChange={(e) => setInjectPrefixGroup(e.target.value)}
                    disabled={running}
                  />
                </label>
              </div>

              {injectPrefixGroup.trim() !== "" && Number(prefixTokens) === 0 && (
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  Note: <code className="mono">prefix_group</code> is attached only when{" "}
                  <code className="mono">prefix_tokens &gt; 0</code> so prompt token counts remain
                  exact.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Execute & Errors */}
        {runError && (
          <div className="error-banner" role="alert" style={{ marginBottom: 0 }}>
            Simulation failed: {runError}
          </div>
        )}

        <div className="panel-card view-header-row">
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {running
              ? effectiveBackend === "wasm"
                ? "Running BLIS inside browser WebAssembly worker (first run downloads 26.4 MB gzipped WASM)..."
                : `Executing native BLIS via ${normalizedRunnerUrl}/api/run...`
              : `Ready to execute ${disaggregated ? `${prefillInstances}P + ${decodeInstances}D` : `${numInstances}x`} ${presetSpec.model} via ${effectiveBackend}.`}
          </div>

          <button
            type="submit"
            className="primary"
            data-testid="custom-run-submit"
            disabled={running}
            style={{ padding: "7px 16px", fontWeight: 600 }}
          >
            {running ? "Running Simulation..." : "Run Simulation"}
          </button>
        </div>
      </form>

      {/* Run Status Summary */}
      {lastRun && (
        <div
          className="panel-card"
          data-testid="custom-run-status"
          style={{ display: "flex", flexDirection: "column", gap: 10 }}
        >
          <div className="view-header-row">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="badge badge-ready">Simulation Complete</span>
              <strong style={{ fontSize: 13 }}>{lastRun.result.title}</strong>
              <span className="badge badge-neutral mono">
                backend: {lastRun.result.backend}
              </span>
              {lastRun.result.injectedReqId && (
                <span
                  className="badge mono"
                  data-testid="injected-req-pill"
                  style={{
                    background: "var(--sem-shared-bg)",
                    color: "var(--sem-shared)",
                    borderColor: "rgba(168, 85, 247, 0.35)"
                  }}
                >
                  Injected Request: {lastRun.result.injectedReqId}
                </span>
              )}
            </div>

            <span className="mono" style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
              {lastRun.result.timeline.eventCount.toLocaleString()} events ·{" "}
              {(lastRun.result.timeline.durationUs / 1000).toFixed(2)} ms sim · {lastRun.elapsedMs}{" "}
              ms wall
            </span>
          </div>

          {lastRun.result.unknownEventCount > 0 && (
            <div style={{ fontSize: 11.5, color: "var(--sem-prefill)" }}>
              Preserved {lastRun.result.unknownEventCount} unrecognized event record(s) in Event
              Log ({lastRun.warningCount} warning(s)).
            </div>
          )}

          {onOpenView && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Inspect in:</span>
              <button
                type="button"
                className="primary"
                data-testid="jump-topology"
                onClick={() => onOpenView("topology", lastRun.result.injectedReqId)}
              >
                Cluster Topology
              </button>
              <button
                type="button"
                className="primary"
                data-testid="jump-request-timeline"
                onClick={() => onOpenView("request-timeline", lastRun.result.injectedReqId)}
              >
                Request Timeline
              </button>
              <button
                type="button"
                className="primary"
                data-testid="jump-gpu-map"
                onClick={() => onOpenView("gpu-map", lastRun.result.injectedReqId)}
              >
                GPU &amp; KV Map
              </button>
            </div>
          )}

          {lastRun.result.commandArgs.length > 0 && (
            <details>
              <summary
                style={{ cursor: "pointer", fontSize: 11.5, color: "var(--text-secondary)" }}
              >
                CLI Arguments ({lastRun.result.commandArgs.length})
              </summary>
              <pre
                className="event-detail-json"
                style={{
                  padding: 8,
                  background: "var(--bg-inset)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6
                }}
              >
                blis {lastRun.result.commandArgs.join(" ")}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
};
