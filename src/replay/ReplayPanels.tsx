/** The menus of the Calibrated mode: the mode toggle, the scenario picker, the BLIS badge and the read-only settings. */
import type { ReactNode } from "react";
import { replayFields, replayText } from "../content/index.js";
import { fmtInt } from "../live/format.js";
import { Rich } from "../live/Rich.js";
import { scenarioFacts } from "./facts.js";
import { REPLAY_IDS, REPLAY_TITLES, type ReplayId } from "./scenarios.js";
import type { ReplayFile } from "./schema.js";

export type Mode = "explore" | "calibrated";

export const BLIS_REPO = "https://github.com/inference-sim/inference-sim";
/** The page of one commit of inference-sim on GitHub. */
export const blisCommitUrl = (commit: string): string => `${BLIS_REPO}/commit/${commit}`;
export const shortCommit = (commit: string): string => commit.slice(0, 7);

/** The names BLIS and the replay files use, as people write them. */
const MODEL_LABELS: Record<string, string> = { "llama-3.1-8b": "Llama 3.1 8B", "llama-70b": "Llama 3.1 70B" };
const GPU_LABELS: Record<string, string> = { h100: "H100", h200: "H200" };

export function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const options: [Mode, string][] = [
    ["explore", "Explore (TypeScript model)"],
    ["calibrated", "Calibrated (BLIS replay)"]
  ];
  return (
    <div className="lv-mode" role="group" aria-label="Mode">
      {options.map(([m, label]) => (
        <button key={m} className={m === mode ? "on" : ""} aria-pressed={m === mode} data-testid={`mode-${m}`} onClick={() => m !== mode && onChange(m)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** The badge that says a BLIS replay is on screen and names the commit it was produced by. */
export function BlisBadge({ commit }: { commit: string }) {
  const { title } = replayFields("badge", { title: "title" });
  return (
    <div className="lv-badge" data-testid="blis-badge">
      <b>{title}</b>
      <span>
        commit{" "}
        <a href={blisCommitUrl(commit)} target="_blank" rel="noopener noreferrer" data-testid="blis-commit">
          {shortCommit(commit)}
        </a>
      </span>
    </div>
  );
}

/** Left menu, Calibrated mode: the scenario picker, what it shows, the badge text and what a replay can and cannot show. */
export function ScenarioPanel({ id, file, status, error, onPick }: { id: ReplayId; file: ReplayFile | null; status: "loading" | "ready" | "failed"; error: string; onPick: (id: ReplayId) => void }) {
  return (
    <>
      <select className="lv-select" data-testid="scenario" value={id} onChange={(e) => onPick(e.target.value as ReplayId)} aria-label="Scenario">
        {REPLAY_IDS.map((x, i) => (
          <option key={x} value={x}>
            {i + 1}. {REPLAY_TITLES[x]}
          </option>
        ))}
      </select>
      {file && status === "ready" && (
        <>
          <p className="lv-note" data-testid="scenario-text">
            <Rich inline text={replayText(`scenario.${id}`, scenarioFacts(id, file))} />
          </p>
          <p className="lv-note lv-src">
            <Rich inline text={replayText("badge", { commit: `[${shortCommit(file.blis.commit)}](${blisCommitUrl(file.blis.commit)})` })} />
          </p>
          <details className="lv-arch">
            <summary>What this shows</summary>
            <Rich text={replayText("shows")} className="lv-note" />
          </details>
          <details className="lv-arch">
            <summary>What this does not show</summary>
            <Rich text={replayText("omits")} className="lv-note" />
          </details>
        </>
      )}
      {status === "loading" && <p className="lv-note">{replayText("loading")}</p>}
      {status === "failed" && (
        <p className="lv-note" data-testid="replay-failed">
          {replayText("failed", { reason: error })}
        </p>
      )}
      <Rich text={replayText("explore-only")} className="lv-note" />
    </>
  );
}

const Row = ({ k, v, id }: { k: ReactNode; v: ReactNode; id?: string }) => (
  <div className="lv-row" data-testid={id}>
    <span>{k}</span>
    <b>{v}</b>
  </div>
);

/** Right menu, Calibrated mode: the settings the scenario ran with, read-only. */
export function ReadOnlySettings({ file }: { file: ReplayFile }) {
  const p = file.params;
  const weights = file.scorers.map((s) => `${s.name.replace(/-scorer$/, "").replace("kv-cache-utilization", "KV use")} ×${s.weight}`).join(" · ");
  return (
    <>
      <div className="lv-readonly" data-testid="settings">
        <Row id="param-model" k="model" v={MODEL_LABELS[p.model] ?? p.model} />
        <Row id="param-gpu" k="GPU" v={GPU_LABELS[p.gpu] ?? p.gpu} />
        <Row id="param-tp" k="GPUs per pod (tensor parallel)" v={p.tp} />
        <Row id="param-replicas" k="pods" v={p.replicas} />
        <Row id="param-max-num-seqs" k="max_num_seqs (batch slots)" v={p.maxNumSeqs} />
        <Row id="param-token-budget" k="token budget per step" v={fmtInt(p.maxNumBatchedTokens)} />
        <Row id="param-gpu-memory-utilization" k="gpu_memory_utilization" v={p.gpuMemoryUtilisation.toFixed(2)} />
        <Row id="param-prefix-caching" k="prefix caching" v={p.prefixCaching ? "on" : "off"} />
        <Row id="param-kv-pool" k="KV pool per pod" v={`${fmtInt(p.kvBlocksPerReplica)} blocks`} />
        <Row id="param-routing" k="routing policy" v={p.routing} />
        {weights && <Row id="param-scorers" k="router scores" v={weights} />}
        <Row id="param-deadline" k="shed after waiting at the router" v={p.queueDeadlineS ? `${p.queueDeadlineS} s` : "never"} />
      </div>
      <Rich text={replayText("params.note")} className="lv-note" />
    </>
  );
}
