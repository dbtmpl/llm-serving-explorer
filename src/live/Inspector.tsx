/** "Dive in" panel: the selected component explained with its live numbers. */
import type { ReactNode } from "react";
import { BLOCK_TOKENS, attnFlops, decodeCurve, flopsPerToken, kvBytesPerToken, livePods, maxBatch, recomputeRatio, replicaSpec, ridge, seqLoad, tierBw, tierCapBlocks, weightBytes, type Pod, type World } from "../sim/index.js";
import { fmtGB, fmtInt, fmtMs } from "./format.js";
import { C, PROMPTS, pieces, sessionColor, sessionStatus, type Target } from "./render.js";

const Row = ({ k, v }: { k: ReactNode; v: ReactNode }) => (
  <div className="lv-row">
    <span>{k}</span>
    <b>{v}</b>
  </div>
);
const Note = ({ children }: { children: ReactNode }) => <p className="lv-note">{children}</p>;
const sci = (x: number) => (x >= 1e15 ? `${(x / 1e15).toFixed(2)} PFLOP` : x >= 1e12 ? `${(x / 1e12).toFixed(1)} TFLOP` : `${(x / 1e9).toFixed(1)} GFLOP`);

function Stack({ parts }: { parts: { label: string; value: number; color: string; text: string }[] }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0) || 1;
  return (
    <div>
      <div className="lv-stack">
        {parts.map((p) => (
          <div key={p.label} title={`${p.label}: ${p.text}`} style={{ flex: Math.max(0.004, Math.max(0, p.value) / total), background: p.color }} />
        ))}
      </div>
      {parts.map((p) => (
        <div className="lv-row" key={p.label}>
          <span>
            <i className="lv-sw" style={{ background: p.color }} />
            {p.label}
          </span>
          <b>{p.text}</b>
        </div>
      ))}
    </div>
  );
}

/** Log-log roofline (2.5) of the replica with the current step's operating point. */
function Roofline({ pod }: { pod: Pod }) {
  const W = 276;
  const H = 150;
  const m = { l: 34, r: 10, t: 12, b: 26 };
  const g = pod.spec.gpu;
  const k = pod.spec.tp;
  const x0 = Math.log10(0.5);
  const x1 = Math.log10(5000);
  const y1 = Math.log10(k * g.peak * 2);
  const y0 = y1 - 4.4;
  const X = (i: number) => m.l + ((Math.log10(i) - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (f: number) => H - m.b - ((Math.log10(Math.max(f, 10 ** y0)) - y0) / (y1 - y0)) * (H - m.t - m.b);
  const rg = ridge(g);
  const last = pod.last;
  const attained = last ? last.flops / last.tGpu : 0;
  return (
    <svg width={W} height={H} className="lv-chart" role="img" aria-label="Roofline with the current engine step">
      {[1, 10, 100, 1000].map((v) => (
        <g key={v}>
          <line x1={X(v)} x2={X(v)} y1={m.t} y2={H - m.b} stroke={C.soft} />
          <text x={X(v)} y={H - m.b + 12} textAnchor="middle">
            {v}
          </text>
        </g>
      ))}
      <text x={W - m.r} y={H - 2} textAnchor="end">
        arithmetic intensity, FLOP/byte
      </text>
      <text x={m.l - 4} y={Y(k * g.peak) + 3} textAnchor="end">
        peak
      </text>
      <polyline fill="none" stroke={C.ink} strokeWidth={2} strokeLinejoin="round" points={`${X(0.5)},${Y(k * g.bw * 0.5)} ${X(rg)},${Y(k * g.peak)} ${X(5000)},${Y(k * g.peak)}`} />
      <line x1={X(rg)} x2={X(rg)} y1={Y(k * g.peak)} y2={H - m.b} stroke={C.mute} strokeDasharray="3 3" />
      <text x={X(rg)} y={Y(k * g.peak) - 5} textAnchor="middle">
        ridge {rg.toFixed(0)}
      </text>
      {last && (
        <g>
          <line x1={X(last.intensity)} x2={X(last.intensity)} y1={Y(attained)} y2={Y(Math.min(k * g.peak, k * g.bw * last.intensity))} stroke={C.mute} />
          <circle cx={X(last.intensity)} cy={Y(attained)} r={6} fill="#fff" />
          <circle cx={X(last.intensity)} cy={Y(attained)} r={4.5} fill={last.bound === "memory" ? C.decode : C.prefill}>
            <title>{`this step: ${last.intensity.toFixed(1)} FLOP/byte, ${sci(attained)}/s attained`}</title>
          </circle>
        </g>
      )}
    </svg>
  );
}

/** Saturating decode throughput against the batch (2.12), with the pod's current batch marked. */
function Throughput({ pod, w, L }: { pod: Pod; w: World; L: number }) {
  const W = 276;
  const H = 110;
  const m = { l: 34, r: 10, t: 10, b: 24 };
  const c = decodeCurve(pod.spec, L, w.params.mbu);
  const bMax = Math.max(8, Math.min(256, maxBatch(pod.spec, L)));
  const X = (b: number) => m.l + (b / bMax) * (W - m.l - m.r);
  const top = c.at(bMax) * 1.15;
  const Y = (x: number) => H - m.b - (x / top) * (H - m.t - m.b);
  const pts = Array.from({ length: 41 }, (_, i) => `${X((i * bMax) / 40)},${Y(c.at((i * bMax) / 40))}`).join(" ");
  const B = Math.min(bMax, pod.running.length);
  return (
    <svg width={W} height={H} className="lv-chart" role="img" aria-label="Decode throughput against batch size">
      <line x1={m.l} x2={W - m.r} y1={H - m.b} y2={H - m.b} stroke={C.line} />
      <polyline fill="none" stroke={C.decode} strokeWidth={2} points={pts} />
      <text x={m.l} y={H - m.b + 12}>
        0
      </text>
      <text x={W - m.r} y={H - m.b + 12} textAnchor="end">
        batch {bMax} (memory cap)
      </text>
      <text x={m.l - 4} y={Y(c.at(bMax)) + 3} textAnchor="end">
        {(c.at(bMax) / 1e3).toFixed(1)}k
      </text>
      <text x={m.l - 4} y={m.t + 2} textAnchor="end">
        tok/s
      </text>
      {B > 0 && (
        <g>
          <circle cx={X(B)} cy={Y(c.at(B))} r={6} fill="#fff" />
          <circle cx={X(B)} cy={Y(c.at(B))} r={4.5} fill={C.decode}>
            <title>{`batch ${B}: ceiling ${fmtInt(c.at(B))} tok/s`}</title>
          </circle>
          <text x={X(B) + 8} y={Y(c.at(B)) + 12}>
            now: B = {B}
          </text>
        </g>
      )}
    </svg>
  );
}

function BlockAnatomy({ pod }: { pod: Pod }) {
  const m = pod.spec.model;
  const cols = Math.min(m.nL, 40);
  return (
    <svg width={276} height={46} className="lv-chart" role="img" aria-label="One KV block: keys and values for every layer">
      {Array.from({ length: cols }, (_, i) => (
        <g key={i}>
          <rect x={30 + i * 6} y={6} width={5} height={12} rx={1} fill={C.decode} opacity={0.85} />
          <rect x={30 + i * 6} y={21} width={5} height={12} rx={1} fill={C.dram} opacity={0.85} />
        </g>
      ))}
      <text x={0} y={16}>
        keys
      </text>
      <text x={0} y={31}>
        values
      </text>
      <text x={30} y={44}>
        {m.nL} layers × {m.nKv} KV heads × {m.dH} dims × {BLOCK_TOKENS} tokens
      </text>
    </svg>
  );
}

function SessionView({ w, id }: { w: World; id: number }) {
  const s = w.sessions.get(id);
  if (!s) return <Note>This session has been pruned.</Note>;
  const r = s.reqId != null ? w.reqs.get(s.reqId) : undefined;
  const spec = replicaSpec(w.params);
  const mkv = kvBytesPerToken(spec.model);
  const states = ["waiting", "prefilling", "decoding", "finished"];
  const cur = !r ? 3 : r.stage === "decode" ? 2 : r.stage === "prefill" ? 1 : 0;
  const ctx = r ? r.lIn + r.out : s.ctxTokens;
  return (
    <>
      <div className="lv-states">
        {states.map((st, i) => (
          <span key={st} className={i === cur && (r || s.turn > 0) ? "on" : ""}>
            {st}
          </span>
        ))}
      </div>
      <Row k="status" v={sessionStatus(s, r)} />
      <Row k="turn" v={s.turn + (r ? 1 : 0)} />
      {r && <Row k="prompt tokens L_in" v={fmtInt(r.lIn)} />}
      {r && <Row k="reused from cache" v={`${fmtInt(r.cached)} tok`} />}
      {r && <Row k="output so far / length" v={`${r.out} / ${r.lOut}`} />}
      {r && r.preemptions > 0 && <Row k="preempted" v={`${r.preemptions}×`} />}
      <Row k="KV cache held" v={`${fmtGB(ctx * mkv, 2)} (${fmtInt(ctx)} tok)`} />
      {s.lastTtft > 0 && <Row k="last TTFT / TPOT" v={`${fmtMs(s.lastTtft)} / ${fmtMs(s.lastTpot)}`} />}
      {r && <Row k="without a KV cache" v={`≈ ${fmtInt(recomputeRatio(r.lIn, r.lOut))}× the arithmetic`} />}
      <Note>
        Token i cannot be computed before token i−1, so a call is a chain of dependent steps. The cache keeps {(mkv / 1024).toFixed(0)} KiB per token for the life of the request and turns a quadratic loop into a linear one. The output length limit
        (max_tokens) is the only bound on how much memory a request can take.
      </Note>
    </>
  );
}

function TokenizerView({ w }: { w: World }) {
  const spec = replicaSpec(w.params);
  const L = w.params.promptTokens;
  const full = seqLoad(spec.model, 0, L).flops;
  const share = 1 - (L * flopsPerToken(spec.model)) / full;
  const ps = pieces(PROMPTS[2]!);
  return (
    <>
      <div className="lv-chips">
        {ps.slice(0, 16).map((p, i) => (
          <span key={i} style={{ background: `hsl(${210 + (i % 4) * 22} 75% ${92 - (i % 2) * 4}%)` }}>
            {p}
          </span>
        ))}
      </div>
      <Row k="typical prompt" v={`${fmtInt(L)} tokens`} />
      <Row k="FLOPs per token (2N)" v={sci(flopsPerToken(spec.model))} />
      <Row k="prefill of that prompt" v={sci(full)} />
      <Row k="of which attention" v={`${(share * 100).toFixed(1)}%`} />
      <Row k="prefill floor on this replica" v={fmtMs(full / (spec.tp * spec.gpu.peak * w.params.mfu))} />
      <Note>
        Hop 1: the gateway authenticates the caller, applies rate limits counted in tokens, and attaches a request id and a deadline. Hop 2: the prompt assembler reads the history from the conversation store and builds system prompt + history + new
        message; their order decides what the prefix cache can reuse. The engine's front end on the replica applies the chat template and tokenises on the host CPU. From here on the unit of work is the token. Prefill cost is 2N per token plus an attention term that grows with the square of the prompt, which
        equals 2N at {fmtInt((2 * spec.model.N) / attnFlops(spec.model, 1))} tokens of context for this model.
      </Note>
    </>
  );
}

function GatewayView({ w }: { w: World }) {
  const p = w.params;
  const lr = w.lastRoute;
  const live = livePods(w).length;
  const desired = Math.max(p.minPods, Math.min(p.maxPods, Math.ceil(w.reqs.size / p.maxNumSeqs)));
  return (
    <>
      <Row k="queued at gateway" v={w.gatewayQueue.length} />
      <Row k="in flight" v={w.reqs.size} />
      <Row k="autoscaler target" v={`⌈${w.reqs.size} ÷ ${p.maxNumSeqs}⌉ = ${desired} pods`} />
      <Row k="pods live" v={live} />
      {lr && (
        <table className="lv-table">
          <thead>
            <tr>
              <th>last decision · session {lr.sid}</th>
              <th>load</th>
              <th>cache</th>
              <th>score</th>
            </tr>
          </thead>
          <tbody>
            {lr.candidates.slice(0, 8).map((c) => (
              <tr key={c.podId} className={c.podId === lr.chosen ? "on" : ""}>
                <td>
                  pod-{c.podId}
                  {c.podId === lr.chosen ? " ← chosen" : ""}
                </td>
                <td>{c.load}</td>
                <td>{c.tier ? `${(c.cache * 100).toFixed(0)}% ${c.tier}` : "–"}</td>
                <td>{lr.policy === "round-robin" ? "–" : c.score.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Note>
        A request is pinned to its replica from admission until it finishes, because its state lives in that replica's memory. The prefix-aware score here follows llm-d's recommended profile (prefix-cache match weighted 3, KV-cache utilisation 2, queue 2); how much a
        copy in DRAM, SSD or the remote pool counts is this model's own choice. Prefix-aware routing scores each pod by how much of the session's cache it holds (HBM counts most, then DRAM, then SSD) plus
        its free capacity. Round-robin ignores both, so returning sessions land on cold pods and prefill again.
      </Note>
    </>
  );
}

function PodView({ w, pod, part }: { w: World; pod: Pod; part: string }) {
  const p = w.params;
  const b = pod.budget;
  const m = pod.spec.model;
  const last = pod.last;
  const mkv = kvBytesPerToken(m);
  const running = pod.running.map((id) => w.reqs.get(id)!).filter(Boolean);
  const meanL = running.length ? running.reduce((s, r) => s + r.lIn + r.out, 0) / running.length : p.promptTokens;
  if (part === "gpu") {
    return (
      <>
        <Stack
          parts={[
            { label: `weights ÷ ${pod.spec.tp} GPU`, value: b.weights, color: C.weights, text: fmtGB(b.weights) },
            { label: "activations, workspace", value: b.activations, color: "#94a3b8", text: fmtGB(b.activations, 2) },
            { label: "KV cache pool", value: b.kv, color: C.decode, text: fmtGB(b.kv) },
            { label: `headroom ${((1 - pod.spec.gpuMemUtil) * 100).toFixed(0)}%`, value: b.headroom, color: "#dbe2ea", text: fmtGB(b.headroom) }
          ]}
        />
        <Row k="per GPU HBM" v={fmtGB(b.hbm, 0)} />
        <Row k="replica pool" v={`${fmtInt(b.poolBlocks)} blocks`} />
        <Row k="in use" v={`${fmtInt(pod.usedBlocks)} blocks · ${((100 * pod.usedBlocks) / Math.max(1, b.poolBlocks)).toFixed(0)}%`} />
        <Row k="max seqs at 4k/32k/128k" v={[4096, 32768, 131072].map((L) => maxBatch(pod.spec, L)).join(" / ")} />
        <BlockAnatomy pod={pod} />
        <Row k="KV per token" v={`${(mkv / 1024).toFixed(0)} KiB`} />
        <Row k="one block (16 tokens)" v={`${((BLOCK_TOKENS * mkv) / 2 ** 20).toFixed(1)} MiB`} />
        <Note>
          The KV pool is what is left after the other three. It is split into fixed blocks that need not be contiguous; a per-sequence block table maps logical to physical blocks, so a sequence holds what it uses and waste is confined to its last
          block. Each coloured cell in the graph stands for {fmtInt(b.poolBlocks / 200)} blocks; pale cells are cached but idle.
          {pod.spec.tp > 1 ? ` With tensor parallelism every GPU holds a slice of every sequence's KV heads, so the ${pod.spec.tp} grids fill together.` : ""}
        </Note>
      </>
    );
  }
  if (part === "roofline") {
    const c = decodeCurve(pod.spec, meanL, p.mbu);
    return (
      <>
        <Roofline pod={pod} />
        {last && (
          <>
            <Row k="FLOPs this step" v={sci(last.flops)} />
            <Row k="bytes moved" v={fmtGB(last.bytes)} />
            <Row k="arithmetic intensity" v={`${last.intensity.toFixed(1)} FLOP/byte`} />
            <Row k="time: memory / compute" v={`${fmtMs(last.tMem)} / ${fmtMs(last.tCompute)}`} />
            <Row k="binding" v={last.bound === "memory" ? "memory bandwidth" : "compute"} />
          </>
        )}
        <Row k="decode limit 2N ÷ (L·M_kv)" v={`${((2 * m.N) / (meanL * mkv)).toFixed(0)} FLOP/byte at L = ${fmtInt(meanL)}`} />
        <Throughput pod={pod} w={w} L={meanL} />
        <Row k="asymptote X∞" v={`${fmtInt(c.xInf)} tok/s`} />
        <Row k="half-saturation batch" v={c.bHalf.toFixed(1)} />
        <Note>
          A step cannot run faster than its arithmetic allows or than its data can arrive. Decode reads {fmtGB(weightBytes(m, pod.spec.precision), 0)} of weights to make one token per sequence, so it sits left of the ridge at any batch: throughput is
          set by bandwidth and context length, not FLOPs. Prefill does thousands of FLOPs per byte and runs at the flat roof.
        </Note>
      </>
    );
  }
  if (part === "tiers") {
    const count = (t: string) => [...pod.entries.values()].filter((e) => e.tier === t).length;
    const typical = Math.round(meanL);
    const bytes = typical * mkv;
    const rows: [string, number, number, string][] = [
      ["HBM", pod.usedBlocks, b.poolBlocks, `${(pod.spec.gpu.bw / 1e12).toFixed(2)} TB/s`],
      ["DRAM", pod.dramBlocks, tierCapBlocks(pod, p.dramGB), `${p.dramGBs} GB/s`],
      ["SSD", pod.ssdBlocks, tierCapBlocks(pod, p.ssdGB), `${p.ssdGBs} GB/s`]
    ];
    return (
      <>
        <table className="lv-table">
          <thead>
            <tr>
              <th>tier</th>
              <th>used / size</th>
              <th>seqs</th>
              <th>rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, used, cap, rate]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>
                  {fmtGB(used * b.blockBytes)} / {fmtGB(cap * b.blockBytes, 0)}
                </td>
                <td>{count(name.toLowerCase())}</td>
                <td>{rate}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Row k={`a ${fmtInt(typical)}-token sequence`} v={fmtGB(bytes, 2)} />
        <Row k="reload from DRAM / SSD" v={`${fmtMs(bytes / tierBw(p).dram)} / ${fmtMs(bytes / tierBw(p).ssd)}`} />
        <Row k="recompute by prefill" v={fmtMs(seqLoad(m, 0, typical).flops / (pod.spec.tp * pod.spec.gpu.peak * p.mfu))} />
        <Note>
          When a new block is needed and HBM is full, the least recently used idle sequence leaves first: to DRAM, which pushes its own oldest down to SSD, which drops its oldest. The cache is derived state, so a drop loses nothing but time. If no idle
          sequence is left, a running one is preempted and recomputed. Below SSD a shared remote pool can take the overflow, and below that only the conversation's text remains. Loading back is adaptive: it is used only when the copy is faster than a
          fresh prefill, which favours long contexts and large models. NVIDIA Dynamo names these tiers G1 (GPU memory), G2 (host memory), G3 (local or pooled SSD) and G4 (remote storage). vLLM recomputes a preempted sequence, and since release 0.11 can
          offload idle prefix blocks through its OffloadingConnector (host memory, optional filesystem tier) or through LMCache, Mooncake or Dynamo's block manager. Those systems copy blocks down asynchronously while the request runs, overlap loads with
          compute layer by layer, and prefetch at routing time; this model moves a session only when room is needed and leaves the rest out. The copy rates are sliders under Memory tiers; their defaults sit inside measured ranges (host memory over PCIe: about 11 to 49 GB/s; SSD: 1.6 to 12 GB/s; network: 32 to 128 Gbps). 
        </Note>
      </>
    );
  }
  const used = last ? last.decodeTok + last.prefillTok : 0;
  return (
    <>
      <div className="lv-loop">
        {["schedule", "forward pass", "sample", "stop check", "detokenise, stream"].map((s, i) => (
          <span key={s} className={i === 1 ? "gpu" : ""}>
            {s}
          </span>
        ))}
      </div>
      {last && (
        <>
          <Stack
            parts={[
              { label: "host (CPU) per step", value: last.tCpu, color: "#94a3b8", text: fmtMs(last.tCpu) },
              { label: "GPU forward pass", value: last.tGpu, color: last.bound === "memory" ? C.decode : C.prefill, text: fmtMs(last.tGpu) }
            ]}
          />
          <Row k={p.overlap ? "step = max(host, GPU)" : "step = host + GPU"} v={fmtMs(last.dur)} />
          <Row k="tokens this step / budget" v={`${fmtInt(used)} / ${fmtInt(p.tokenBudget)}`} />
          <Row k="decode + prefill" v={`${last.decodeTok} + ${fmtInt(last.prefillTok)}`} />
        </>
      )}
      <Row k="running / max_num_seqs" v={`${pod.running.length} / ${p.maxNumSeqs}`} />
      <Row k="waiting" v={pod.waiting.length} />
      <Row k="engine steps" v={fmtInt(pod.steps)} />
      <div className="lv-seqs">
        {running.slice(0, 16).map((r) => (
          <div key={r.id} title={`session ${r.sid}`}>
            <i className="lv-sw" style={{ background: sessionColor(r.sid) }} />
            <span>{r.stage === "prefill" ? `prefill ${fmtInt(r.prefillDone)}/${fmtInt(r.prefillTarget)}` : r.stage === "reload" ? "reloading cache" : `decode ${r.out}/${r.lOut}`}</span>
            <b>{fmtGB((r.lIn + r.out) * mkv, 2)}</b>
          </div>
        ))}
      </div>
      <Note>
        The engine is one loop that advances every admitted request by one step, sharing each forward pass. Decodes go first (one token each); the rest of the token budget is filled with prefill chunks, which bounds how long a big prompt can stall
everyone else. A request is admitted when the KV it needs under the admission rule fits: its next chunk (vLLM, which then preempts the newest sequence if the pool runs out), its whole prompt, or prompt plus max_tokens (never preempts, admits
        far fewer). Everything but the forward pass is host code on the critical path of every token: every sequence's TPOT is the step time.
      </Note>
    </>
  );
}

const TITLES: Record<string, string> = { engine: "Engine loop", gpu: "GPU memory and KV blocks", roofline: "Roofline and throughput", tiers: "Memory tiers and eviction" };

export function Inspector({ w, target, onClose }: { w: World; target: Target; onClose: () => void }) {
  const pod = target.type === "pod" ? w.pods.find((x) => x.id === target.id) : undefined;
  const title =
    target.type === "session" ? `Session ${target.id}` : target.type === "tokenizer" ? "Gateway · prompt assembly" : target.type === "gateway" ? "Router" : target.type === "store" ? "Conversation store" : target.type === "remote" ? "Remote KV pool" : target.type === "stream" ? "Output stream" : `pod-${target.id}`;
  return (
    <section className="lv-panel lv-inspector" data-testid="inspector">
      <header>
        <h2>{title}</h2>
        <button className="lv-x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {target.type === "session" && <SessionView w={w} id={target.id} />}
      {target.type === "tokenizer" && <TokenizerView w={w} />}
      {target.type === "gateway" && <GatewayView w={w} />}
      {target.type === "store" && (
        <>
          <Row k="turns stored" v={fmtInt(w.store.turns)} />
          <Row k="tokens of text" v={fmtInt(w.store.tokens)} />
          <Row k="as text (≈ 4 bytes per token)" v={fmtGB(w.store.tokens * 4, 3)} />
          <Row k="same tokens as KV cache" v={fmtGB(w.store.tokens * kvBytesPerToken(replicaSpec(w.params).model), 1)} />
          <Note>
            Each model call is stateless, so the product keeps the conversation: an append-only log of turns, replayed in full on every call. It is the system of record. The KV cache in HBM, DRAM, SSD or a remote pool is derived from it and is valid only
            for the exact token sequence and model version it was computed with. Losing a KV tier costs a prefill and nothing else; editing or truncating stored history invalidates every cached prefix after the edit.
          </Note>
        </>
      )}
      {target.type === "remote" && (
        <>
          <Row k="sequences held" v={w.remote.size} />
          <Row k="used / size" v={`${fmtGB(w.remoteBytes)} / ${w.params.remoteGB} GB`} />
          <Row k="link" v={`${w.params.remoteGbps} Gbps`} />
          <Note>
            A KV pool on other machines' DRAM and SSD, reachable from every pod over the network (Mooncake, SGLang HiCache's third level and LMCache's remote stores work this way). It is the only tier that survives a pod being scaled down and the only
            one a different pod can load from. Loading is adaptive: over a 32 to 128 Gbps link it beats a prefill only for long contexts or large models, so short sessions are recomputed instead.
          </Note>
        </>
      )}
      {target.type === "stream" && (
        <Note>
          Hop 6. Every engine step produces one token for each decoding sequence. The token is detokenised on the host, checked against stop conditions, and sent to the client as a streaming event. A person reads about 5 tokens per second, so tokens
          delivered faster than that build a buffer; what a reader feels is the wait for the first token and any stall longer than that buffer.
        </Note>
      )}
      {target.type === "pod" && !pod && <Note>This pod has been terminated.</Note>}
      {target.type === "pod" &&
        pod &&
        (["engine", "gpu", "roofline", "tiers"] as const).map((part) => (
          <details className="lv-group" key={`${target.id}-${part}-${target.part}`} open={target.part === part}>
            <summary>{TITLES[part]}</summary>
            <div>
              <PodView w={w} pod={pod} part={part} />
            </div>
          </details>
        ))}
    </section>
  );
}
