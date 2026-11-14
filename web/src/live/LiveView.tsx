import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { STEP_KINDS, calloutFor, type Callout } from "./callouts.js";
import { TOUR, TourArt } from "./Tutorial.js";
import { ARCHITECTURES, DEFAULT_ARCH } from "./architectures.js";
import { Inspector } from "./Inspector.js";
import { GPUS, MODELS, fmtInt, fmtMs } from "./model.js";
import { C, Scene, type Target } from "./render.js";
import { DEFAULT_PARAMS, advance, costPerMTok, createWorld, kvFill, livePods, median, setParam, spawnBurst, tokensPerSecond, type Params, type World } from "./sim.js";
import "./live.css";

const SPEEDS = [0.02, 0.05, 0.1, 0.25, 0.5, 1];
const CALLOUT_TTL = 9;

interface Shown extends Callout {
  id: number;
  born: number;
}

interface Preset {
  id: string;
  label: string;
  hint: string;
  params: Partial<Params>;
  speed: number;
  burst: [number, number];
}

const PRESETS: Preset[] = [
  { id: "evict", label: "Idle sessions → eviction", hint: "40 sessions with 10k-token prompts on one pod. Finished sessions stay cached until HBM fills, then move to DRAM, to SSD, and out. gpu_memory_utilization is lowered to 0.5 so the pool fills sooner.", params: { promptTokens: 10000, outputTokens: 60, maxPods: 1, gpuMemUtil: 0.5, dramGB: 4, ssdGB: 8, returnProb: 0.6, thinkTimeS: 5, scaleDownIdleS: 120 }, speed: 0.25, burst: [40, 8] },
  { id: "preempt", label: "Outputs outgrow the pool → preemption", hint: "12 prompts fit in a small KV pool (gpu_memory_utilization 0.3), but their long outputs keep growing. With nothing idle to evict, the newest sequence gives its blocks back and recomputes.", params: { promptTokens: 4000, outputTokens: 1500, maxPods: 1, gpuMemUtil: 0.3, returnProb: 0 }, speed: 0.5, burst: [12, 0] },
  { id: "70b", label: "70B on 4 × H100", hint: "Tensor parallelism is bought for memory: four GPUs each hold a quarter of the weights and a slice of every KV block.", params: { model: "llama-3-70b", tp: 4, maxPods: 4 }, speed: 0.1, burst: [20, 0] },
  { id: "churn", label: "Conversations with churn", hint: "100 sessions that keep replying, plus two new sessions every second while others go idle. Follow-up turns are short prefills on cached history; new sessions are long ones. Watch the two kinds of work share each step.", params: { arrivalRate: 2, returnProb: 0.8, thinkTimeS: 3, maxTurns: 8, maxPods: 12 }, speed: 0.25, burst: [100, 2] }
];

function Slider({ label, value, min, max, step, fmt, onChange, id }: { label: string; value: number; min: number; max: number; step: number; fmt?: (v: number) => string; onChange: (v: number) => void; id?: string }) {
  return (
    <label className="lv-slider">
      <span>
        {label}
        <b>{fmt ? fmt(value) : value}</b>
      </span>
      <input data-testid={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Choice<T extends string | number | boolean>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="lv-choice">
      <span>{label}</span>
      <div className="lv-seg">
        {options.map(([v, l]) => (
          <button key={String(v)} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

const Group = ({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) => (
  <details className="lv-group" open={open}>
    <summary>{title}</summary>
    <div>{children}</div>
  </details>
);

export function LiveView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(createWorld({ ...DEFAULT_PARAMS }));
  const sceneRef = useRef(new Scene());
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(0.1);
  const [explain, setExplain] = useState(true);
  const [selected, setSelected] = useState<Target | null>(null);
  const [callouts, setCallouts] = useState<Shown[]>([]);
  const [preset, setPreset] = useState<string | null>(null);
  const [stepMode, setStepMode] = useState(false);
  const [held, setHeld] = useState<Shown | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [tour, setTour] = useState<number | null>(null);
  const [arch, setArch] = useState(DEFAULT_ARCH);
  const [histPos, setHistPos] = useState<[number, number]>([0, 0]);
  const [, refresh] = useReducer((x: number) => x + 1, 0);
  const live = useRef({ playing, speed, explain, callouts, seen: new Set<string>(), lastShown: new Map<string, number>(), nextId: 1, stepMode: false, held: null as Shown | null, focus: null as number | null, focusDone: false, queue: [] as Callout[], tour: null as number | null, hist: [] as Shown[], hi: -1 });
  live.current.tour = tour;
  const heldEl = useRef<HTMLDivElement>(null);
  const tourEl = useRef<HTMLDivElement>(null);
  const tourDot = useRef<HTMLDivElement>(null);
  const tourLine = useRef<SVGLineElement>(null);
  live.current.playing = playing;
  live.current.speed = speed;
  live.current.explain = explain;
  live.current.callouts = callouts;
  const calloutEls = useRef(new Map<number, HTMLDivElement>());
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [panels, setPanels] = useState(true);
  const w = worldRef.current;
  const p = w.params;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const scene = sceneRef.current;
    let raf = 0;
    let last = performance.now();
    let lastRefresh = 0;
    (window as unknown as { __live: unknown }).__live = { world: () => worldRef.current, scene };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const world = worldRef.current;
      const st = live.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const dpr = window.devicePixelRatio || 1;
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      if (now - lastRefresh > 200) {
        const box = (el: HTMLDivElement | null) => {
          const last = el?.lastElementChild?.getBoundingClientRect();
          return last && cw >= 900 ? { w: last.width + 16, h: last.bottom } : { w: 0, h: 0 };
        };
        const l = box(leftRef.current);
        const r = box(rightRef.current);
        const leftTop = leftRef.current?.firstElementChild?.getBoundingClientRect().top;
        scene.panels = { lw: l.w, lh: l.h, rw: r.w, rh: r.h, bottom: cw < 900 && leftTop ? ch - leftTop + 12 : 96 };
      }
      const running = st.playing && !st.held;
      if (running) advance(world, dt * st.speed);
      const events = world.events.splice(0);
      scene.focusSid = st.stepMode ? st.focus : null;
      const tourTarget = st.tour !== null ? TOUR[st.tour]!.target : undefined;
      scene.topPad = tourEl.current && tourTarget && !("el" in tourTarget) ? tourEl.current.offsetHeight + 28 : 0;
      scene.update(world, events, dt, running, cw, ch);
      scene.draw(ctx, world, dpr);

      // step-through: follow one session and stop the clock at each thing that happens to it
      if (st.stepMode) {
        for (const e of events) {
          if (st.focus === null && e.kind === "req.new") {
            st.focus = e.sid!;
            setFocus(st.focus);
          }
          const req = st.focus !== null ? world.reqs.get(world.sessions.get(st.focus)?.reqId ?? -1) : undefined;
          const waitingForPod = req && (req.stage === "queued" || req.stage === "toGateway" || req.stage === "tokenize" || req.stage === "send");
          const mine = e.sid === st.focus && STEP_KINDS.has(e.kind);
          const fleet = waitingForPod && (e.kind === "pod.loading" || e.kind === "pod.ready" || e.kind === "scale.up");
          if (!mine && !fleet) continue;
          const c = calloutFor(e, world)[0];
          if (c) st.queue.push(c);
          if (mine && (e.kind === "session.idle" || e.kind === "req.failed")) st.focusDone = true;
        }
        if (!st.held && st.queue.length) {
          st.held = { ...st.queue.shift()!, id: st.nextId++, born: world.t };
          st.hist.push(st.held);
          st.hi = st.hist.length - 1;
          setHeld(st.held);
          setHistPos([st.hi, st.hist.length]);
        }
      }

      // callouts: new ones from this frame's events, then keep every box glued to its node
      if (st.explain && !st.stepMode && st.tour === null && events.length) {
        let next: Shown[] | null = null;
        for (const c of events.flatMap((e) => calloutFor(e, world))) {
          // one box per kind of event at a time, however many pods it happens on
          const family = c.key.replace(/\d+$/, "");
          if (c.once && st.seen.has(c.key)) continue;
          if (!c.once && scene.vt - (st.lastShown.get(family) ?? -99) < (c.every ?? 2.5)) continue;
          st.seen.add(c.key);
          st.lastShown.set(family, scene.vt);
          const slotOf = (t: Target) => (t.type === "pod" ? `pod${t.id}` : t.type === "session" ? "session" : t.type);
          next = (next ?? st.callouts).filter((x) => slotOf(x.target) !== slotOf(c.target));
          next.push({ ...c, id: st.nextId++, born: scene.vt });
        }
        if (next) {
          st.callouts = next.slice(-3);
          setCallouts(st.callouts);
        }
      }
      if (st.callouts.some((c) => scene.vt - c.born > CALLOUT_TTL)) {
        st.callouts = st.callouts.filter((c) => scene.vt - c.born <= CALLOUT_TTL);
        setCallouts(st.callouts);
      }
      for (const c of st.callouts) {
        const el = calloutEls.current.get(c.id);
        const a = scene.anchor(world, c.target);
        if (!el) continue;
        if (!a) {
          el.style.opacity = "0";
          continue;
        }
        const s = scene.toScreen(a);
        const below = c.target.type === "tokenizer" || c.target.type === "stream";
        const age = scene.vt - c.born;
        el.style.opacity = String(Math.min(1, age * 3, (CALLOUT_TTL - age) * 2));
        // keep the box on screen and clear of the metrics strip
        const hw = el.offsetWidth / 2 + 8;
        const y = below ? s.y + 12 : Math.max(s.y - 12, el.offsetHeight + 84);
        // stay out from under the corner panels
        const top = below ? y : y - el.offsetHeight;
        const minX = top < scene.panels.lh ? scene.panels.lw + hw : hw;
        const maxX = top < scene.panels.rh ? cw - scene.panels.rw - hw : cw - hw;
        const x = Math.max(minX, Math.min(maxX, s.x));
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, ${below ? "0" : "-100%"})`;
      }
      const place = (el: HTMLElement | null, t: Target | undefined, fallbackY: number) => {
        if (!el) return null;
        const a = t ? scene.anchor(world, t) : null;
        const hw = el.offsetWidth / 2 + 8;
        if (!a) {
          el.style.transform = `translate(${Math.round(cw / 2)}px, ${Math.round(fallbackY)}px) translate(-50%, -50%)`;
          return null;
        }
        const s = scene.toScreen(a);
        const below = t!.type === "tokenizer" || t!.type === "stream";
        const x = Math.max(hw, Math.min(cw - hw, s.x));
        const y = below ? Math.min(s.y + 14, ch - el.offsetHeight - 90) : Math.max(s.y - 14, el.offsetHeight + 84);
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, ${below ? "0" : "-100%"})`;
        return s;
      };
      if (st.held) place(heldEl.current, st.held.target, ch - 220);
      if (st.tour !== null) {
        const step = TOUR[st.tour]!;
        let t = step.target;
        const dot = tourDot.current;
        if (t && "el" in t) {
          const r = document.querySelector(`[data-tour="${t.el}"]`)?.getBoundingClientRect();
          const el = tourEl.current;
          if (el && r) {
            const x = t.el === "right" ? r.left - el.offsetWidth / 2 - 18 : r.left + r.width / 2;
            const y = t.el === "right" ? 88 + el.offsetHeight / 2 : r.top - el.offsetHeight / 2 - 16;
            el.style.transform = `translate(${Math.round(Math.max(el.offsetWidth / 2 + 8, x))}px, ${Math.round(y)}px) translate(-50%, -50%)`;
          }
          if (dot) dot.style.opacity = "0";
          if (tourLine.current) tourLine.current.style.opacity = "0";
        } else {
          if (t?.type === "session" && t.id < 0) t = { type: "session", id: world.sessions.keys().next().value ?? 0 };
          if (t?.type === "pod" && t.id < 0) t = { ...t, id: (world.pods.find((x) => x.state === "ready") ?? world.pods[0])?.id ?? 0 };
          // the card sits under the metrics strip, clear of the graph; a line and a dot point at the component
          const el = tourEl.current;
          const a = t ? scene.anchorPart(world, t) : null;
          const s = a ? scene.toScreen(a) : null;
          if (el) el.style.transform = t ? `translate(${Math.round(cw / 2)}px, 88px) translate(-50%, 0)` : `translate(${Math.round(cw / 2)}px, ${Math.round(ch / 2)}px) translate(-50%, -50%)`;
          const line = tourLine.current;
          if (dot) {
            dot.style.opacity = s ? "1" : "0";
            if (s) dot.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px) translate(-50%, -50%)`;
          }
          if (line && el) {
            line.style.opacity = s ? "1" : "0";
            if (s) {
              line.setAttribute("x1", String(cw / 2));
              line.setAttribute("y1", String(88 + el.offsetHeight));
              line.setAttribute("x2", String(s.x));
              line.setAttribute("y2", String(s.y));
            }
          }
        }
      }
      if (now - lastRefresh > 200) {
        lastRefresh = now;
        refresh();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // pan, zoom, click-to-inspect
  useEffect(() => {
    const canvas = canvasRef.current!;
    const scene = sceneRef.current;
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) {
        canvas.style.cursor = scene.hit(worldRef.current, e.offsetX, e.offsetY) ? "pointer" : "grab";
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      scene.auto = false;
      scene.cam.x -= dx / scene.cam.s;
      scene.cam.y -= dy / scene.cam.s;
      drag.x = e.clientX;
      drag.y = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (drag && !drag.moved) {
        const t = scene.hit(worldRef.current, e.offsetX, e.offsetY);
        scene.selected = t;
        setSelected(t);
      }
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const before = scene.toWorld(e.offsetX, e.offsetY);
      scene.auto = false;
      scene.cam.s = Math.max(0.1, Math.min(3, scene.cam.s * Math.exp(-e.deltaY * 0.0015)));
      const after = scene.toWorld(e.offsetX, e.offsetY);
      scene.cam.x += before.x - after.x;
      scene.cam.y += before.y - after.y;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("wheel", wheel);
    };
  }, []);

  const set = useCallback(<K extends keyof Params>(key: K, value: Params[K]) => {
    setParam(worldRef.current, key, value);
    refresh();
  }, []);

  const reset = useCallback((params: Partial<Params> = {}) => {
    worldRef.current = createWorld({ ...DEFAULT_PARAMS, ...params });
    const st = live.current;
    st.seen.clear();
    st.lastShown.clear();
    st.callouts = [];
    setCallouts([]);
    sceneRef.current.selected = null;
    sceneRef.current.auto = true;
    setSelected(null);
    setPreset(null);
    setArch(params.disagg ? "disagg" : DEFAULT_ARCH);
    st.queue = [];
    st.held = null;
    st.focus = null;
    st.focusDone = false;
    st.hist = [];
    st.hi = -1;
    setHeld(null);
    setFocus(null);
    refresh();
  }, []);

  const toggleStep = () => {
    const st = live.current;
    st.stepMode = !st.stepMode;
    st.queue = [];
    st.held = null;
    st.focusDone = false;
    // follow the selected session, else the newest one still waiting on a model call, else the next to arrive
    let f: number | null = selected?.type === "session" ? selected.id : null;
    if (f === null) for (const s of worldRef.current.sessions.values()) if (s.reqId !== null) f = s.id;
    st.focus = st.stepMode ? f : null;
    st.callouts = [];
    st.hist = [];
    st.hi = -1;
    setCallouts([]);
    setHeld(null);
    setFocus(st.focus);
    setStepMode(st.stepMode);
    if (st.stepMode) setPlaying(true);
  };

  // Next walks forward through steps already seen, then lets the clock run to the next event.
  // Back re-reads earlier steps; the graph itself stays where it is.
  const nextStep = () => {
    const st = live.current;
    if (st.hi < st.hist.length - 1) {
      st.held = st.hist[++st.hi]!;
    } else {
      const next = st.queue.shift();
      st.held = next ? { ...next, id: st.nextId++, born: worldRef.current.t } : null;
      if (st.held) {
        st.hist.push(st.held);
        st.hi = st.hist.length - 1;
      }
      if (!st.held && st.focusDone) {
        st.focus = null;
        st.focusDone = false;
        setFocus(null);
      }
    }
    setHeld(st.held);
    setHistPos([st.hi, st.hist.length]);
  };
  const prevStep = () => {
    const st = live.current;
    if (st.hi <= 0) return;
    st.held = st.hist[--st.hi]!;
    setHeld(st.held);
    setHistPos([st.hi, st.hist.length]);
  };

  const trace = () => {
    if (!live.current.stepMode) toggleStep();
    send(1);
  };

  const applyArch = (id: string) => {
    const a = ARCHITECTURES.find((x) => x.id === id)!;
    setArch(id);
    for (const [k, v] of Object.entries(a.params)) setParam(worldRef.current, k as keyof Params, v as never);
    refresh();
  };

  const startTour = () => {
    if (live.current.stepMode) toggleStep();
    reset({ returnProb: 0.9, thinkTimeS: 3, maxTurns: 20 });
    spawnBurst(worldRef.current, 14, 3);
    setSpeed(0.25);
    setPlaying(true);
    setTour(0);
  };
  const endTour = () => {
    setTour(null);
    try {
      localStorage.setItem("lv-tour-seen", "1");
    } catch {
      /* private mode: the tour simply shows again next visit */
    }
  };
  useEffect(() => {
    let seen = false;
    try {
      seen = localStorage.getItem("lv-tour-seen") === "1";
    } catch {
      seen = false;
    }
    if (!seen) startTour();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = (n: number) => {
    spawnBurst(worldRef.current, n);
    setPlaying(true);
  };

  const runPreset = (ps: Preset) => {
    reset(ps.params);
    setPreset(ps.id);
    setSpeed(ps.speed);
    if (ps.burst[0]) spawnBurst(worldRef.current, ps.burst[0], ps.burst[1]);
    setPlaying(true);
  };

  const select = (t: Target | null) => {
    sceneRef.current.selected = t;
    setSelected(t);
  };

  const live_ = livePods(w);
  const hit = w.m.promptTokens ? w.m.cachedTokens / w.m.promptTokens : 0;
  const empty = w.sessions.size === 0 && w.pods.length === 0 && w.pending.length === 0;
  const activePreset = PRESETS.find((x) => x.id === preset);
  const tiles: [string, string, string?][] = [
    ["in flight", String(w.reqs.size), w.gatewayQueue.length ? `${w.gatewayQueue.length} queued` : undefined],
    ["pods", String(live_.length), `${live_.length * p.tp} GPU${live_.length * p.tp === 1 ? "" : "s"}`],
    ["output", `${fmtInt(tokensPerSecond(w))} tok/s`],
    ["TTFT p50", w.m.ttft.length ? fmtMs(median(w.m.ttft)) : "–"],
    ["TPOT p50", w.m.tpot.length ? fmtMs(median(w.m.tpot)) : "–"],
    ["KV pool", `${(kvFill(w) * 100).toFixed(0)}%`, w.m.evictions ? `${w.m.evictions} evicted` : undefined],
    ["prefix hits", `${(hit * 100).toFixed(0)}%`, w.m.preemptions ? `${w.m.preemptions} preempted` : undefined],
    ["cost", w.m.tokensOut ? `$${costPerMTok(w).toFixed(2)}/M` : "–", "output tokens"]
  ];

  return (
    <div className="lv-root">
      <canvas ref={canvasRef} className="lv-canvas" data-testid="live-canvas" />

      {empty && tour === null && (
        <div className="lv-empty">
          <h1>How an LLM serves a request</h1>
          <p>The stack starts empty. Send a request and watch it build: text, tokens, a route, a pod, weights, KV cache, a stream of output tokens.</p>
          <button className="lv-primary" data-testid="send-first" onClick={() => send(1)}>
            Send one request
          </button>
          <button className="lv-secondary" data-testid="trace-first" onClick={trace}>
            Trace one request, step by step
          </button>
          <small>The trace stops the clock at each stage and explains it until you press Next.</small>
        </div>
      )}

      <div className="lv-callouts">
        {callouts.map((c) => (
          <div
            key={c.id}
            className={`lv-callout tone-${c.tone}`}
            data-testid="callout"
            ref={(el) => {
              if (el) calloutEls.current.set(c.id, el);
              else calloutEls.current.delete(c.id);
            }}
            onClick={() => select(c.target)}
          >
            <b>{c.title}</b>
            <span>{c.body}</span>
          </div>
        ))}
      </div>

      {held && (
        <div className={`lv-callout lv-step tone-${held.tone}`} ref={heldEl} data-testid="step-box">
          <em>
            Step {histPos[0] + 1} of {histPos[1]} · {focus !== null ? `session ${focus}` : "fleet"} · {histPos[0] < histPos[1] - 1 ? `earlier step, at ${held.born.toFixed(2)} s` : `clock stopped at ${w.t.toFixed(2)} s`}
          </em>
          <b>{held.title}</b>
          <span>{held.body}</span>
          {held.detail && <span>{held.detail}</span>}
          <div className="lv-step-actions">
            <button className="lv-ghost" onClick={toggleStep}>
              exit
            </button>
            <button className="lv-ghost" data-testid="step-back" disabled={histPos[0] <= 0} onClick={prevStep}>
              ◂ Back
            </button>
            <button className="lv-next" data-testid="step-next" onClick={nextStep}>
              Next ▸
            </button>
          </div>
        </div>
      )}

      {tour !== null && (
        <>
          <svg className="lv-tour-line">
            <line ref={tourLine} />
          </svg>
          <div className="lv-tour-dot" ref={tourDot} />
          <div className="lv-tour" ref={tourEl} data-testid="tour">
            <TourArt id={TOUR[tour]!.id} key={TOUR[tour]!.id} />
            <b>{TOUR[tour]!.title}</b>
            <p>{TOUR[tour]!.text}</p>
            <div className="lv-step-actions">
              <span>
                {tour + 1} / {TOUR.length}
              </span>
              <button className="lv-ghost" data-testid="tour-skip" onClick={endTour}>
                {tour === TOUR.length - 1 ? "" : "dismiss"}
              </button>
              {tour > 0 && (
                <button className="lv-ghost" onClick={() => setTour(tour - 1)}>
                  back
                </button>
              )}
              <button className="lv-next" data-testid="tour-next" onClick={() => (tour === TOUR.length - 1 ? endTour() : setTour(tour + 1))}>
                {tour === TOUR.length - 1 ? "Done" : "Next ▸"}
              </button>
            </div>
          </div>
        </>
      )}

      <div className="lv-hud" data-testid="hud">
        {tiles.map(([k, v, sub]) => (
          <div key={k}>
            <span>{k}</span>
            <b>{v}</b>
            {sub && <i>{sub}</i>}
          </div>
        ))}
      </div>

      <div className="lv-col lv-left" ref={leftRef} hidden={!panels}>
        <section className="lv-panel">
          <header>
            <h2>Serving architecture</h2>
          </header>
          <select className="lv-select" data-testid="arch" value={arch} onChange={(e) => applyArch(e.target.value)} aria-label="Serving architecture">
            {ARCHITECTURES.map((a, i) => (
              <option key={a.id} value={a.id}>
                {i + 1}. {a.year} · {a.short}
              </option>
            ))}
          </select>
          {(() => {
            const a = ARCHITECTURES.find((x) => x.id === arch)!;
            return (
              <details className="lv-arch" open>
                <summary>What this step adds</summary>
                <p className="lv-note">
                  <b>{a.name}.</b> {a.adds}
                </p>
                <p className="lv-note lv-src">{a.source}</p>
              </details>
            );
          })()}
        </section>
        <section className="lv-panel">
          <header>
            <h2>Requests</h2>
          </header>
          <div className="lv-burst">
            {[1, 10, 20, 100, 1000, 10000].map((n) => (
              <button key={n} data-testid={`send-${n}`} onClick={() => send(n)}>
                <b>{n >= 1000 ? `${n / 1000}k` : n}</b>
                <span>{n === 1 ? "session" : "at once"}</span>
              </button>
            ))}
          </div>
          <Group title="Scenarios">
            {PRESETS.map((ps) => (
              <button key={ps.id} className={`lv-preset ${preset === ps.id ? "on" : ""}`} data-testid={`preset-${ps.id}`} onClick={() => runPreset(ps)}>
                {ps.label}
              </button>
            ))}
            {activePreset && <p className="lv-note">{activePreset.hint}</p>}
          </Group>
          <Group title="Session behaviour">
            <Slider id="prompt-tokens" label="first prompt, mean length" value={p.promptTokens} min={200} max={64000} step={200} fmt={(v) => `${fmtInt(v)} tok`} onChange={(v) => set("promptTokens", v)} />
            <Slider label="follow-up prompt, mean length" value={p.followTokens} min={10} max={8000} step={10} fmt={(v) => `${fmtInt(v)} tok`} onChange={(v) => set("followTokens", v)} />
            <Slider label="answer, mean length" value={p.outputTokens} min={10} max={2000} step={10} fmt={(v) => `${fmtInt(v)} tok`} onChange={(v) => set("outputTokens", v)} />
            <Slider label="time between follow-ups" value={p.thinkTimeS} min={0.5} max={60} step={0.5} fmt={(v) => `${v} s`} onChange={(v) => set("thinkTimeS", v)} />
            <Slider label="sessions that reply again after a turn" value={p.returnProb} min={0} max={1} step={0.05} fmt={(v) => `${(v * 100).toFixed(0)}%`} onChange={(v) => set("returnProb", v)} />
            <Slider label="turns before a session ends" value={p.maxTurns} min={1} max={40} step={1} onChange={(v) => set("maxTurns", v)} />
            <Slider label="new sessions per second" value={p.arrivalRate} min={0} max={50} step={0.5} onChange={(v) => set("arrivalRate", v)} />
            <p className="lv-note">
              After each answer {(p.returnProb * 100).toFixed(0)}% of sessions reply again about {p.thinkTimeS} s later; the other {((1 - p.returnProb) * 100).toFixed(0)}% go idle and leave their KV cache behind. Lengths vary ±40% around the mean. Times are
              simulated seconds.
            </p>
          </Group>
        </section>
        {selected && (
          <Inspector
            w={w}
            target={selected}
            onClose={() => select(null)}
          />
        )}
      </div>

      <div className="lv-col lv-right" ref={rightRef} hidden={!panels} data-tour="right">
        <section className="lv-panel">
          <header>
            <h2>Infrastructure</h2>
            <span className="lv-live">changes apply live</span>
          </header>
          <Group title="Model and GPU">
            <Choice label="model" value={p.model} options={Object.values(MODELS).map((m) => [m.id, m.label])} onChange={(v) => set("model", v)} />
            <Choice label="precision" value={p.precision} options={[["bf16", "BF16"], ["fp8", "FP8"]]} onChange={(v) => set("precision", v)} />
            <Choice label="GPU" value={p.gpu} options={Object.values(GPUS).map((g) => [g.id, g.label.replace(" SXM", "")])} onChange={(v) => set("gpu", v)} />
            <Choice label="GPUs per pod (tensor parallel)" value={p.tp} options={[[1, "1"], [2, "2"], [4, "4"], [8, "8"]]} onChange={(v) => set("tp", v)} />
            <Slider label="gpu_memory_utilization" value={p.gpuMemUtil} min={0.3} max={0.98} step={0.01} fmt={(v) => v.toFixed(2)} onChange={(v) => set("gpuMemUtil", v)} />
            <p className="lv-note">These size the weights and the KV pool at start-up, so changing one restarts every pod. vLLM's gpu_memory_utilization was 0.9 by default for years; current releases default to 1.0 on CUDA and measure what is free.</p>
          </Group>
          <Group title="Engine">
            <Slider id="max-num-seqs" label="max_num_seqs (batch slots)" value={p.maxNumSeqs} min={1} max={64} step={1} onChange={(v) => set("maxNumSeqs", v)} />
            <Slider label="token budget per step" value={p.tokenBudget} min={256} max={32768} step={256} fmt={fmtInt} onChange={(v) => set("tokenBudget", v)} />
            <Choice label="batching" value={p.batching} options={[["static", "static"], ["continuous", "continuous"]]} onChange={(v) => set("batching", v)} />
            <Choice label="KV needed to admit a request" value={p.admission} options={[["on-demand", "next chunk"], ["prompt", "whole prompt"], ["reserve", "prompt + max_tokens"]]} onChange={(v) => set("admission", v)} />
            {p.admission === "reserve" && <Slider label="max_tokens clients send" value={p.maxTokensCap} min={256} max={16384} step={256} fmt={fmtInt} onChange={(v) => set("maxTokensCap", v)} />}
            <Choice label="speculative decoding" value={p.specDecode} options={[[false, "off"], [true, `draft ${p.specK} tokens`]]} onChange={(v) => set("specDecode", v)} />
            {p.specDecode && <Slider label="draft length γ" value={p.specK} min={1} max={10} step={1} onChange={(v) => set("specK", v)} />}
            {p.specDecode && <Slider label="acceptance rate α" value={p.specAccept} min={0.3} max={0.95} step={0.01} fmt={(v) => v.toFixed(2)} onChange={(v) => set("specAccept", v)} />}
            {p.specDecode && <Slider label="draft cost c (draft run ÷ target run)" value={p.specCost} min={0.01} max={0.3} step={0.01} fmt={(v) => v.toFixed(2)} onChange={(v) => set("specCost", v)} />}
            {p.specDecode && (
              <p className="lv-note">
                Expected {((1 - p.specAccept ** (p.specK + 1)) / (1 - p.specAccept)).toFixed(2)} tokens per step and a {((1 - p.specAccept ** (p.specK + 1)) / ((1 - p.specAccept) * (p.specK * p.specCost + 1))).toFixed(2)}× speed-up (Leviathan et al. 2023,
                eq. 1 and theorem 3.8). The paper measured α 0.53 to 0.89 and c 0.02 to 0.11, at batch 1.
              </p>
            )}
            <Choice label="prefix caching" value={p.prefixCaching} options={[[true, "on"], [false, "off"]]} onChange={(v) => set("prefixCaching", v)} />
            <Choice label="CPU / GPU overlap" value={p.overlap} options={[[false, "host + GPU"], [true, "max(host, GPU)"]]} onChange={(v) => set("overlap", v)} />
            <Slider label="host time per step" value={p.hostMsBase} min={0} max={20} step={0.5} fmt={(v) => `${v} ms`} onChange={(v) => set("hostMsBase", v)} />
          </Group>
          <Group title="Routing and autoscaling">
            <Choice label="routing policy" value={p.routing} options={[["prefix-aware", "prefix-aware"], ["least-loaded", "least-loaded"], ["round-robin", "round-robin"]]} onChange={(v) => set("routing", v)} />
            <Choice label="prefill / decode pools" value={p.disagg} options={[[false, "one pool"], [true, "disaggregated"]]} onChange={(v) => set("disagg", v)} />
            {p.disagg && <Slider label="skip prefill pool below (uncached tokens)" value={p.pdThreshold} min={0} max={8192} step={64} fmt={fmtInt} onChange={(v) => set("pdThreshold", v)} />}
            {p.disagg && <Slider label="KV transfer link" value={p.linkGbps} min={10} max={400} step={10} fmt={(v) => `${v} Gbps`} onChange={(v) => set("linkGbps", v)} />}
            <Slider label="shed requests waiting longer than" value={p.shedAfterS} min={0} max={120} step={1} fmt={(v) => (v ? `${v} s` : "never")} onChange={(v) => set("shedAfterS", v)} />
            <Slider label="min pods" value={p.minPods} min={0} max={8} step={1} onChange={(v) => set("minPods", v)} />
            <Slider label="max pods" value={p.maxPods} min={1} max={100} step={1} onChange={(v) => set("maxPods", v)} />
            <Slider label="cold start" value={p.coldStartS} min={0.5} max={60} step={0.5} fmt={(v) => `${v} s`} onChange={(v) => set("coldStartS", v)} />
            <Slider label="scale down after idle" value={p.scaleDownIdleS} min={2} max={120} step={1} fmt={(v) => `${v} s`} onChange={(v) => set("scaleDownIdleS", v)} />
            <p className="lv-note">Real cold starts take tens of seconds to minutes; the default is short so the animation keeps moving.</p>
          </Group>
          <Group title="Memory tiers">
            <Slider label="host DRAM for KV" value={p.dramGB} min={0} max={256} step={4} fmt={(v) => (v ? `${v} GB` : "off")} onChange={(v) => set("dramGB", v)} />
            <Slider label="local SSD for KV" value={p.ssdGB} min={0} max={1024} step={8} fmt={(v) => (v ? `${v} GB` : "off")} onChange={(v) => set("ssdGB", v)} />
            <Slider label="remote pool, shared by all pods" value={p.remoteGB} min={0} max={4096} step={32} fmt={(v) => (v ? `${v} GB` : "off")} onChange={(v) => set("remoteGB", v)} />
            <Slider label="DRAM ↔ HBM copy rate" value={p.dramGBs} min={5} max={64} step={1} fmt={(v) => `${v} GB/s`} onChange={(v) => set("dramGBs", v)} />
            <Slider label="SSD read rate" value={p.ssdGBs} min={0.5} max={14} step={0.5} fmt={(v) => `${v} GB/s`} onChange={(v) => set("ssdGBs", v)} />
            <Slider label="remote pool link" value={p.remoteGbps} min={10} max={400} step={2} fmt={(v) => `${v} Gbps`} onChange={(v) => set("remoteGbps", v)} />
            <p className="lv-note">Measured: host memory to GPU 11 to 49 GB/s depending on copy size (64 is the PCIe 5 ceiling); SSD 1.6 to 12 GB/s; LMCache studies 32 to 128 Gbps networks.</p>            <p className="lv-note">Idle sessions fall HBM → DRAM → SSD → remote pool, whole sessions at a time, least recently used first. Below that only the text in the conversation store remains.</p>
          </Group>
          <Group title="Efficiency and price">
            <Slider label="MBU (bandwidth achieved)" value={p.mbu} min={0.1} max={1} step={0.01} fmt={(v) => v.toFixed(2)} onChange={(v) => set("mbu", v)} />
            <Slider label="MFU (FLOPs achieved)" value={p.mfu} min={0.1} max={1} step={0.01} fmt={(v) => v.toFixed(2)} onChange={(v) => set("mfu", v)} />
            <Slider label="price per GPU-hour" value={p.pricePerGpuHour} min={0.5} max={10} step={0.1} fmt={(v) => `$${v.toFixed(2)}`} onChange={(v) => set("pricePerGpuHour", v)} />
          </Group>
        </section>
        <section className="lv-panel">
          <Group title="Legend">
            <div className="lv-legend">
              {(
                [
                  [C.prefill, "prefill (compute-bound)"],
                  [C.decode, "decode, output tokens (memory-bound)"],
                  [C.weights, "weights in HBM"],
                  ["hsl(200 66% 60%)", "KV blocks of a running sequence"],
                  ["hsl(200 38% 84%)", "KV blocks cached, session idle"],
                  [C.dram, "KV in host DRAM"],
                  [C.ssd, "KV on SSD"],
                  [C.remote, "KV in the shared remote pool"],
                  [C.sub, "conversation text read or saved"],
                  [C.evict, "dropped or preempted"]
                ] as const
              ).map(([c, l]) => (
                <div key={l}>
                  <i className="lv-sw" style={{ background: c }} />
                  {l}
                </div>
              ))}
              <p className="lv-note">Each session has its own hue. Click any node to dive in; drag to pan, scroll to zoom.</p>
            </div>
          </Group>
        </section>
      </div>

      <div className="lv-transport" data-tour="transport">
        <button className="lv-play" data-testid="play-toggle" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="lv-clock" data-testid="clock">
          <b>{w.t.toFixed(2)} s</b>
          <span>simulated</span>
        </div>
        <div className="lv-speed">
          <span>slow motion</span>
          <div className="lv-seg">
            {SPEEDS.map((s) => (
              <button key={s} className={s === speed ? "on" : ""} data-testid={`speed-${s}`} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
        </div>
        <button className={`lv-ghost ${stepMode ? "on" : ""}`} data-testid="step-toggle" onClick={toggleStep} title="Follow one session and stop at each thing that happens to it">
          step-through{stepMode ? (focus !== null ? ` · session ${focus}` : " · waiting for a request") : ""}
        </button>
        <button className={`lv-ghost ${explain ? "on" : ""}`} onClick={() => setExplain(!explain)}>
          explain
        </button>
        <button className="lv-ghost" data-testid="tour-start" onClick={startTour}>
          tutorial
        </button>
        <button className={`lv-ghost ${panels ? "on" : ""}`} data-testid="toggle-panels" onClick={() => setPanels(!panels)}>
          menus
        </button>
        <button
          className="lv-ghost"
          onClick={() => {
            sceneRef.current.auto = true;
          }}
        >
          fit
        </button>
        <button className="lv-ghost" data-testid="reset" onClick={() => reset()}>
          reset
        </button>
        <a className="lv-ghost" href="classic.html" title="Replay of BLIS simulator event files">
          BLIS replay
        </a>
      </div>
    </div>
  );
}
