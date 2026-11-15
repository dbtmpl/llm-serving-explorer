/** "Dive in" panel of the Calibrated mode: what BLIS recorded about the selected part of the graph. */
import { useState, type ReactNode } from "react";
import { replayText } from "../content/index.js";
import { fmtInt, } from "../live/format.js";
import { Rich } from "../live/Rich.js";
import { sessionColor, type Target } from "../live/render.js";
import type { ReplayRun } from "./adapter.js";

const Row = ({ k, v }: { k: ReactNode; v: ReactNode }) => (
  <div className="lv-row">
    <span>{k}</span>
    <b>{v}</b>
  </div>
);

const ms = (s: number) => `${(s * 1000).toFixed(0)} ms`;
const score = (v: number) => v.toFixed(2);

/** Short names for the router's plugins, as columns. */
const COLUMN: Record<string, string> = { "queue-scorer": "queue", "kv-cache-utilization-scorer": "KV use", "prefix-cache-scorer": "prefix" };

function RouterView({ run }: { run: ReplayRun }) {
  const [picked, setPicked] = useState<number | null>(null);
  const recent = run.decisions.slice(-12).reverse();
  const d = (picked !== null ? run.decisions.find((x) => x.reqIndex === picked) : undefined) ?? run.decisions[run.decisions.length - 1];
  const w = run.world;
  return (
    <>
      <Row k="held at the router" v={w.gatewayQueue.length} />
      <Row k="in flight" v={w.reqs.size} />
      <Row k="routed so far" v={fmtInt(run.decisions.length)} />
      {run.file.params.queueDeadlineS > 0 && <Row k="shed so far" v={w.m.failed} />}
      {d && (
        <>
          <select className="lv-select" data-testid="decision-pick" value={d.reqIndex} onChange={(e) => setPicked(Number(e.target.value))} aria-label="Decision">
            {recent.map((x) => {
              const r = run.request(x.reqIndex);
              return (
                <option key={x.reqIndex} value={x.reqIndex}>
                  session {r.session} · round {r.round} → pod-{x.chosen}
                </option>
              );
            })}
          </select>
          {run.file.scorers.length > 0 ? (
            <div className="lv-table-wrap">
              <table className="lv-table" data-testid="decision-table">
                <thead>
                  <tr>
                    <th>pod</th>
                    {run.file.scorers.map((s) => (
                      <th key={s.name}>
                        {COLUMN[s.name] ?? s.name} ×{s.weight}
                      </th>
                    ))}
                    <th>total</th>
                  </tr>
                </thead>
                <tbody>
                  {d.scores.map((row, pod) => (
                    <tr key={pod} className={pod === d.chosen ? "on" : ""}>
                      <td>
                        pod-{pod}
                        {pod === d.chosen ? " ← chosen" : ""}
                      </td>
                      {row ? row.map((v, k) => <td key={k}>{score(v)}</td>) : <td colSpan={run.file.scorers.length}>filtered out</td>}
                      <td>{d.totals[pod] === null ? "–" : score(d.totals[pod]!)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="lv-note">This router configuration has no scoring plugin: pods tie and the picker rotates.</p>
          )}
        </>
      )}
      <Rich text={replayText("inspector.router")} className="lv-note" />
    </>
  );
}

function PodView({ run, id }: { run: ReplayRun; id: number }) {
  const pod = run.world.pods[id];
  if (!pod) return null;
  const c = run.podCounts(id);
  const routed = run.decisions.filter((d) => d.chosen === id).length;
  const running = pod.running.map((rid) => run.world.reqs.get(rid)).filter(Boolean);
  return (
    <>
      <Row k="KV pool in use" v={`${(c.kv * 100).toFixed(0)}% · ${fmtInt(pod.usedBlocks)} / ${fmtInt(pod.budget.poolBlocks)} blocks`} />
      <Row k="running (BLIS series)" v={c.running.toFixed(1)} />
      <Row k="waiting (BLIS series)" v={c.waiting.toFixed(1)} />
      <Row k="requests routed here so far" v={fmtInt(routed)} />
      <Row k="preemptions, whole run" v={run.file.totals.preemptions} />
      <div className="lv-seqs">
        {running.slice(0, 16).map((r) => (
          <div key={r!.id} title={`session ${r!.sid}`}>
            <i className="lv-sw" style={{ background: sessionColor(r!.sid) }} />
            <span>{r!.stage === "prefill" ? `prefill ${fmtInt(r!.prefillDone)}/${fmtInt(r!.prefillTarget)}` : `decode ${r!.out}/${r!.lOut}`}</span>
            <b>session {r!.sid}</b>
          </div>
        ))}
      </div>
      <Rich text={replayText("inspector.pod", { interval: run.file.series.intervalS })} className="lv-note" />
    </>
  );
}

function SessionView({ run, id }: { run: ReplayRun; id: number }) {
  const t = run.world.t;
  const rounds = run.sessionRequests(id).filter((r) => r.arrival <= t);
  return (
    <>
      <div className="lv-table-wrap">
        <table className="lv-table" data-testid="session-table">
          <thead>
            <tr>
              <th>round</th>
              <th>pod</th>
              <th>prompt</th>
              <th>cached</th>
              <th>first token</th>
              <th>fate</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((r) => (
              <tr key={r.id}>
                <td>{r.round + 1}</td>
                <td>{r.pod === null ? "–" : `pod-${r.pod}`}</td>
                <td>{fmtInt(r.inputTokens)}</td>
                <td>{fmtInt(r.cachedTokens)}</td>
                <td>{r.firstToken === null || r.firstToken > t ? "–" : ms(r.firstToken - r.arrival)}</td>
                <td>{r.fate === "completed" ? (r.lastToken! > t ? "running" : "done") : r.droppedAt! > t ? "waiting" : r.fate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Rich text={replayText("inspector.session")} className="lv-note" />
    </>
  );
}

export function ReplayInspector({ run, target, onClose }: { run: ReplayRun; target: Target; onClose: () => void }) {
  const title = target.type === "session" ? `Session ${target.id}` : target.type === "tokenizer" ? "Gateway" : target.type === "gateway" ? "Router" : target.type === "pod" ? `pod-${target.id}` : "Output stream";
  return (
    <section className="lv-panel lv-inspector" data-testid="inspector">
      <header>
        <h2>{title}</h2>
        <button className="lv-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {target.type === "session" && <SessionView run={run} id={target.id} />}
      {target.type === "tokenizer" && <Rich text={replayText("inspector.front")} className="lv-note" />}
      {target.type === "gateway" && <RouterView run={run} />}
      {target.type === "pod" && <PodView run={run} id={target.id} />}
      {(target.type === "store" || target.type === "remote" || target.type === "stream") && <Rich text={replayText("omits")} className="lv-note" />}
    </section>
  );
}
