import React from "react";
import type { HeaderRecord } from "@llm-viz/schema";
import { SourceLinksChip } from "../components/SourceLinksChip.js";

export interface AccuracyViewProps {
  readonly header?: HeaderRecord;
}

interface ValidationAnchorRow {
  readonly anchor: string;
  readonly verdict: string;
  readonly outputMetricError: string;
  readonly ttftError: string;
  readonly kvPoolRatio: string;
}

const PINNED_STACK = {
  blisCommitShort: "c79c7456",
  blisCommitFull: "c79c745619b16a8019339e3bbc79ee5e2923b258",
  toolchain: "go1.27.2",
  modules: [
    {
      name: "blis-vllm",
      modulePath: "github.com/inference-sim/blis-vllm",
      version: "v0.32.0-blis.3",
      models: "vLLM 0.32.0 (commit 5df63a72)"
    },
    {
      name: "llm-d-router",
      modulePath: "github.com/inference-sim/llm-d-router",
      version: "v1.0.0-blis.4",
      models: "llm-d 1.0.0 (commit b9393d1a)"
    },
    {
      name: "blis-substrate",
      modulePath: "github.com/inference-sim/blis-substrate",
      version: "v0.14.0",
      models: "Calibrated model & hardware catalog"
    }
  ]
} as const;

const VALIDATION_BUILD = "9e3c509c";
const VALIDATION_BINARY_SHA256 =
  "29fb09054a10ee51dc104f491cb09337e0ba527055b85653d281f23230451dff";

const VALIDATION_SUMMARY_ROWS: readonly ValidationAnchorRow[] = [
  {
    anchor: "InferenceX agentic, H100 TP8 (run of 09-18)",
    verdict: "PARTIAL",
    outputMetricError: "-13.6% (ITL, solo c1)",
    ttftError: "-40.7% (solo c1)",
    kvPoolRatio: "1.30"
  },
  {
    anchor: "InferenceX agentic, H200 TP4 (run of 09-21)",
    verdict: "PARTIAL",
    outputMetricError: "-10.1% (ITL, solo c1)",
    ttftError: "-31.9% (solo c1)",
    kvPoolRatio: "1.22"
  },
  {
    anchor: "InferenceX agentic, H200 TP8 (run of 09-21)",
    verdict: "PARTIAL",
    outputMetricError: "-19.2% (ITL, solo c1)",
    ttftError: "-36.5% (solo c1)",
    kvPoolRatio: "1.38"
  },
  {
    anchor: "InferenceX single-turn, all families",
    verdict: "PARTIAL (0 EXACT)",
    outputMetricError: "+1.2% (TPOT, signed mean)",
    ttftError: "-6.3% (signed mean)",
    kvPoolRatio: "not logged"
  },
  {
    anchor: "internal llm-d DSV4.1 H200, Agg-1r",
    verdict: "PARTIAL",
    outputMetricError: "-47.7% (ITL mean)",
    ttftError: "-62.7% (p50)",
    kvPoolRatio: "not logged"
  },
  {
    anchor: "internal llm-d DSV4.1 H200, Agg-2r",
    verdict: "PARTIAL",
    outputMetricError: "-45.0% (ITL mean)",
    ttftError: "-65.6% (p50)",
    kvPoolRatio: "not logged"
  },
  {
    anchor: "internal llm-d DSV4.1 H200, TP4-baseline",
    verdict: "PARTIAL",
    outputMetricError: "-39.0% (ITL mean)",
    ttftError: "-60.5% (p50)",
    kvPoolRatio: "1.57"
  },
  {
    anchor: "internal llm-d DSV4.1 H200, TP8-no-DSpark",
    verdict: "PARTIAL",
    outputMetricError: "-42.7% (ITL mean)",
    ttftError: "-59.2% (p50)",
    kvPoolRatio: "1.29"
  },
  {
    anchor: "internal llm-d DSV4.1 H200, TP8-no-Engram",
    verdict: "PARTIAL",
    outputMetricError: "-46.4% (ITL mean)",
    ttftError: "-61.1% (p50)",
    kvPoolRatio: "1.38"
  },
  {
    anchor: "internal llm-d DSV4.1 H200, TP8-no-KV-offload",
    verdict: "PARTIAL",
    outputMetricError: "-37.8% (ITL mean)",
    ttftError: "+4.8% (p50)",
    kvPoolRatio: "1.38"
  },
  {
    anchor: "llm-d Prism A1",
    verdict: "PARTIAL",
    outputMetricError: "+30.5% (TPOT, signed mean)",
    ttftError: "-13.6% (mean, signed mean)",
    kvPoolRatio: "not logged"
  },
  {
    anchor: "llm-d Prism A2",
    verdict: "PARTIAL",
    outputMetricError: "+27.7% (TPOT, signed mean)",
    ttftError: "+331.8% (mean, signed mean)",
    kvPoolRatio: "not logged"
  },
  {
    anchor: "llm-d Prism A2'",
    verdict: "PARTIAL",
    outputMetricError: "+26.0% (TPOT, signed mean)",
    ttftError: "-27.1% (mean, signed mean)",
    kvPoolRatio: "not logged"
  },
  {
    anchor: "llm-d Prism B (round-robin)",
    verdict: "PARTIAL",
    outputMetricError: "+65.1% (TPOT, signed mean)",
    ttftError: "-26.1% (mean, signed mean)",
    kvPoolRatio: "not logged"
  }
];

interface UnmodelledItem {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  readonly badgeClass: string;
  readonly description: string;
}

const UNMODELLED_AND_DERIVED_ITEMS: readonly UnmodelledItem[] = [
  {
    id: "offload-nvme-s3",
    title: "Local NVMe/SSD & S3 Remote Offload Tiers",
    tag: "Not Modelled",
    badgeClass: "badge-evicted",
    description:
      "blis-vllm v0.32.0 models GPU HBM and CPU DRAM (OffloadingConnector / TieringOffloadingSpec) only. Local NVMe/SSD and S3/remote object-store KV tiers are explicitly not modelled (local_ssd_modelled: false, remote_store_modelled: false)."
  },
  {
    id: "pod-failure-injection",
    title: "Pod Failure & Fault Injection",
    tag: "Not Modelled",
    badgeClass: "badge-evicted",
    description:
      "Unexpected pod crashes, GPU ECC/OOM terminations, and fault injection are not modelled. Pod events reflect planned scaling/lifecycle transitions (pod.created, pod.loading, pod.ready, pod.draining, pod.terminated)."
  },
  {
    id: "scorer-breakdown",
    title: "Router Candidate Scorer Breakdown (scorer_breakdown)",
    tag: "Omitted by Default",
    badgeClass: "badge-neutral",
    description:
      "request.routed records emit composite candidate scores for each endpoint evaluated by llm-d-router; per-plugin scorer_breakdown weights are omitted unless BLIS router instrumentation is extended."
  },
  {
    id: "batch-step-roofline",
    title: "batch.step.roofline Analytical FLOPs & HBM Bytes",
    tag: "derived: true",
    badgeClass: "badge-prefill",
    description:
      "batch.step.roofline fields (flops, bytes_moved, arithmetic_intensity, achieved_tflops, achieved_bw_tbs, bottleneck) carry derived: true — they are analytically computed from model dimensions and batch token counts rather than sampled from hardware performance counters."
  },
  {
    id: "kv-block-tracker",
    title: "kv_block_tracker Physical Slot Reconstruction",
    tag: "derived: true",
    badgeClass: "badge-prefill",
    description:
      "The visualizer and BLIS kv_block_tracker reconstruct physical HBM block-slot residency maps from logical block lifecycle events (kv_block.allocated, kv_block.cached, kv_block.evicted, kv_block.moved) rather than reading raw vLLM GPU page-table addresses."
  }
];

export const AccuracyView: React.FC<AccuracyViewProps> = ({ header }) => {
  const blisHeader = header?.blis;
  const headerStackEntries = blisHeader?.stack_versions
    ? Object.entries(blisHeader.stack_versions).filter(([, v]) => typeof v === "string" && v.length > 0)
    : [];
  const tierNotes = header?.topology?.tiers;

  return (
    <div data-testid="view-accuracy" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header */}
      <div className="panel-card view-header-row">
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>
            Model Fidelity, Calibration &amp; Accuracy Notes
          </h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 3 }}>
            Pinned BLIS simulation stack, published validation error bounds, preset catalog
            calibrations, and visualizer-derived signal boundaries.
          </div>
        </div>
        <SourceLinksChip
          title="BLIS Sources"
          links={[
            { path: "sim/events_schema.go", label: "Event Schema" },
            { path: "sim/roofline.go", label: "Roofline Model", glossaryTerm: "AI" },
            { path: "sim/kv_block_tracker.go", label: "KV Block Tracker", glossaryTerm: "KV Block" }
          ]}
        />
      </div>

      {/* 1. Pinned BLIS Stack Versions */}
      <section className="panel-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="view-header-row">
          <h3 style={{ margin: 0, fontSize: 14 }}>Pinned BLIS Stack Versions</h3>
          <span className="badge badge-decode mono">
            BLIS commit {PINNED_STACK.blisCommitShort} · {PINNED_STACK.toolchain}
          </span>
        </div>

        {/* Active Stream Header (dynamic from loaded scenario/custom run) */}
        <div
          data-testid="accuracy-active-header"
          style={{
            padding: "10px 12px",
            background: "var(--bg-inset)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            display: "flex",
            flexDirection: "column",
            gap: 6
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Active Stream Header (<code className="mono">header.blis</code>)
          </div>
          {blisHeader ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <span className="badge badge-ready mono">
                commit: {blisHeader.commit.slice(0, 12)}
              </span>
              <span className="badge badge-neutral mono">
                vllm_version: {blisHeader.vllm_version}
              </span>
              <span className="badge badge-neutral mono">
                llmd_version: {blisHeader.llmd_version}
              </span>
              {headerStackEntries.map(([modName, modVer]) => (
                <span key={modName} className="badge badge-neutral mono">
                  {modName}: {modVer}
                </span>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              No active scenario header loaded — displaying pinned repository stack metadata from{" "}
              <code className="mono">engine/stack.json</code>.
            </div>
          )}
        </div>

        {/* Pinned repository stack.json */}
        <div className="event-log-table-wrap">
          <table className="event-log-table">
            <thead>
              <tr>
                <th>Module</th>
                <th>Pinned Version</th>
                <th>Models / Role</th>
                <th>Go Module Path</th>
              </tr>
            </thead>
            <tbody>
              {PINNED_STACK.modules.map((mod) => (
                <tr key={mod.name} className="event-log-row" style={{ cursor: "default" }}>
                  <td>
                    <strong className="mono">{mod.name}</strong>
                  </td>
                  <td className="mono">{mod.version}</td>
                  <td>{mod.models}</td>
                  <td className="mono" style={{ color: "var(--text-secondary)" }}>
                    {mod.modulePath}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Repository submodule commit: {PINNED_STACK.blisCommitFull} (
          <code className="mono">engine/stack.json</code>)
        </div>
      </section>

      {/* 2. BLIS Validation Summary Table */}
      <section className="panel-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="view-header-row">
          <h3 style={{ margin: 0, fontSize: 14 }}>BLIS Validation Summary</h3>
          <span className="badge badge-prefill mono">
            build {VALIDATION_BUILD} · No anchor is EXACT
          </span>
        </div>

        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Published anchor-by-anchor comparison against measured serving runs from{" "}
          <code className="mono">engine/docs/validation/index.md</code> (build{" "}
          <code className="mono">{VALIDATION_BUILD}</code>, binary sha256{" "}
          <code className="mono">{VALIDATION_BINARY_SHA256.slice(0, 12)}…</code>). Every anchor is{" "}
          <strong>PARTIAL</strong> because at least one configuration or workload difference
          cannot be removed (such as a different vLLM version, benchmark-client fork, or unlogged
          engine setting); none is used to fit coefficients.
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 8,
            fontSize: 11.5,
            background: "var(--bg-inset)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            padding: "8px 10px",
            color: "var(--text-secondary)"
          }}
        >
          <div>
            <strong>Signed error:</strong>{" "}
            <code className="mono">100 * (BLIS / measured - 1)</code> (sign indicates bias)
          </div>
          <div>
            <strong>MAPE / Shape error:</strong> mean absolute signed error; shape removes a
            constant lowest-load offset
          </div>
          <div>
            <strong>KV-pool ratio:</strong> BLIS KV-cache pool / pool logged by vLLM at start-up
          </div>
        </div>

        <div className="event-log-table-wrap" style={{ overflowX: "auto" }}>
          <table className="event-log-table" data-testid="accuracy-validation-table">
            <thead>
              <tr>
                <th>Anchor</th>
                <th>Verdict</th>
                <th>Output-Metric Error</th>
                <th>TTFT Error</th>
                <th>KV Pool BLIS/vLLM</th>
              </tr>
            </thead>
            <tbody>
              {VALIDATION_SUMMARY_ROWS.map((row) => (
                <tr key={row.anchor} className="event-log-row" style={{ cursor: "default" }}>
                  <td>{row.anchor}</td>
                  <td>
                    <span className="badge badge-prefill mono">{row.verdict}</span>
                  </td>
                  <td className="mono">{row.outputMetricError}</td>
                  <td className="mono">{row.ttftError}</td>
                  <td className="mono">{row.kvPoolRatio}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 3. Hardware Presets & Catalog Calibration Notes (ADR 0003) */}
      <section className="panel-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="view-header-row">
          <h3 style={{ margin: 0, fontSize: 14 }}>
            Hardware Presets &amp; Catalog Calibration Notes
          </h3>
          <span className="badge badge-neutral mono">ADR 0003 · blis-substrate v0.14.0</span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 12
          }}
        >
          <div
            style={{
              background: "var(--bg-inset)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 6
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong className="mono">llama-3.1-8b-instruct · a100-sxm</strong>
              <span className="badge badge-ready mono">TP=1 · 94/135 evidenced</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              NVIDIA A100-SXM4-80GB (<code className="mono">80.0 GiB</code>,{" "}
              <code className="mono">312 TFlopsPeak</code>,{" "}
              <code className="mono">2.039 TB/s</code> HBM, <code className="mono">block_size: 16</code>
              ). 79 measured + 15 vendor_spec coefficients.
            </div>
            <div style={{ fontSize: 11.5, color: "var(--sem-prefill)" }}>
              Catalog note: No 40 GB A100 entry exists in BLIS&apos;s catalog.{" "}
              <code className="mono">a100-sxm</code> (80 GiB) is the closest calibrated A100;
              KV-pressure scenarios constrain the pool via{" "}
              <code className="mono">gpu_memory_utilization</code> (e.g. 0.25–0.35) without
              modifying the hardware catalog.
            </div>
          </div>

          <div
            style={{
              background: "var(--bg-inset)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 6
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <strong className="mono">llama-3.1-70b-instruct · h100 (FP8)</strong>
              <span className="badge badge-decode mono">TP=2 · 119/162 evidenced</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              2× NVIDIA H100 SXM5 80GB (<code className="mono">79.1896 GiB/GPU</code>,{" "}
              <code className="mono">989.5 TFlopsPeak</code> /{" "}
              <code className="mono">1979.0 TFlopsFP8</code>,{" "}
              <code className="mono">3.35 TB/s</code> HBM, <code className="mono">block_size: 16</code>
              ). 105 measured + 14 vendor_spec coefficients.
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
              Matches BLIS&apos;s AISimulate calibrated configuration: BF16 70B weights (~140 GB)
              exceed a single 80 GB H100, so <code className="mono">FP8</code> with{" "}
              <code className="mono">TP=2</code> is the closest calibrated H100 deployment.
            </div>
          </div>
        </div>
      </section>

      {/* 4. Unmodelled Features & Visualizer-Derived Signals */}
      <section className="panel-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="view-header-row">
          <h3 style={{ margin: 0, fontSize: 14 }}>
            Unmodelled Features &amp; Visualizer-Derived Signals
          </h3>
          {tierNotes && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <span className="badge badge-neutral mono">
                local_ssd_modelled: {String(tierNotes.local_ssd_modelled)}
              </span>
              <span className="badge badge-neutral mono">
                remote_store_modelled: {String(tierNotes.remote_store_modelled)}
              </span>
            </div>
          )}
        </div>

        <ul
          data-testid="accuracy-unmodelled-list"
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 8
          }}
        >
          {UNMODELLED_AND_DERIVED_ITEMS.map((item) => (
            <li
              key={item.id}
              style={{
                background: "var(--bg-inset)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 6,
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 4
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 12.5 }}>{item.title}</strong>
                <span className={`badge ${item.badgeClass} mono`}>{item.tag}</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {item.description}
              </div>
            </li>
          ))}
        </ul>

        {tierNotes?.unmodelled_notes && Object.keys(tierNotes.unmodelled_notes).length > 0 && (
          <div
            style={{
              background: "var(--bg-inset)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              padding: "8px 12px",
              fontSize: 11.5,
              color: "var(--text-secondary)"
            }}
          >
            <strong>Stream Header Unmodelled Notes:</strong>
            <ul style={{ margin: "4px 0 0 0", paddingLeft: 18 }}>
              {Object.entries(tierNotes.unmodelled_notes).map(([k, v]) =>
                v ? (
                  <li key={k}>
                    <code className="mono">{k}</code>: {v}
                  </li>
                ) : null
              )}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
};
