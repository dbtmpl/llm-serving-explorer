import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { STEP_KINDS, calloutFor, type Callout } from "./callouts.js";
import { GATE_TIMEOUT_S, end, newScript, stepsFor, type Script } from "./walkthrough.js";
import { TOUR, TourArt } from "./Tutorial.js";
import { Inspector } from "./Inspector.js";
import { Rich } from "./Rich.js";
import { architectureText, panelFields, panelText } from "../content/index.js";
import { fmtGB, fmtInt, fmtMs } from "./format.js";
import { C, Scene, TONE, type Free, type GpuPart, type Target } from "./render.js";
import { ARCHITECTURES, DEFAULT_ARCH, DEFAULT_PARAMS, GPUS, MODELS, advance, costPerMTok, createWorld, elapsed, evictIdleNow, kvFill, livePods, median, setParam, spawnBurst, tokensPerSecond, type Params, type World } from "../sim/index.js";
import "./live.css";

const EMPTY_TEXT = panelFields("empty", { title: "title", text: "text", hint: "hint" });
const SPEEDS = [0.02, 0.05, 0.1, 0.25, 0.5, 1];
const CALLOUT_TTL = 9;

interface Shown extends Callout {
  id: number;
  born: number;
}

/** Everything needed to show a step again: the world, the picture and the step-through bookkeeping. */
interface Snap {
  world: World;
  scene: ReturnType<Scene["snapshot"]>;
  queue: Callout[];
  focus: number | null;
  focusDone: boolean;
  script: Script;
}
/** One step of the step-through; `snap` is null when it was not stored (very large world, or too old). */
interface StepRec {
  shown: Shown;
  snap: Snap | null;
}
/** Snapshots kept (the oldest are dropped; Back to one of those shows its text only). */
const MAX_SNAPS = 60;
/** Worlds with more sessions than this are not cloned: too slow and too big to keep 60 of. */
const MAX_SNAP_SESSIONS = 2000;

/**
 * A rewound step being shown again. Instead of jumping to the world stored with it, the clock runs
 * again from the previous step's snapshot to the time of this one, so every animation that led to
 * the step (weights filling, tokens flying, cells appearing) plays from its start. When the world
 * has reached that time, and the step's own condition holds, the stored snapshot is put back so the
 * end state is exactly the one that was held the first time.
 */
interface Replay {
  /** index in the history of the step being shown again */
  to: number;
  /** simulated time the world must reach */
  t: number;
  /** simulated seconds per animation second */
  rate: number;
  /** animation seconds spent so far; the replay ends after REPLAY_MAX_S whatever the world does */
  spent: number;
}
/** Longest a replay may take, in animation seconds. */
const REPLAY_MAX_S = 5;

interface StepBook {
  queue: Callout[];
  focus: number | null;
  focusDone: boolean;
  script: Script;
  hist: StepRec[];
  hi: number;
  dirty: boolean;
}

function takeSnap(world: World, scene: Scene, st: StepBook): Snap | null {
  if (world.sessions.size > MAX_SNAP_SESSIONS) return null;
  try {
    return { world: structuredClone(world), scene: scene.snapshot(), queue: [...st.queue], focus: st.focus, focusDone: st.focusDone, script: structuredClone(st.script) };
  } catch {
    return null;
  }
}

/** Record a step the box has just started to hold (the world has no undelivered events at this point). */
function pushStep(st: StepBook, shown: Shown, world: World, scene: Scene): void {
  st.hist.push({ shown, snap: takeSnap(world, scene, st) });
  st.hi = st.hist.length - 1;
  st.dirty = false;
  const old = st.hist[st.hist.length - 1 - MAX_SNAPS];
  if (old) old.snap = null;
}

/** [index of the step shown, number of steps, whether the graph could not be rewound to it] */
const posOf = (st: StepBook): [number, number, boolean] => [st.hi, st.hist.length, st.hi < st.hist.length - 1 && !st.hist[st.hi]?.snap];

interface Preset {
  id: string;
  label: string;
  hint: string;
  params: Partial<Params>;
  speed: number;
  burst: [number, number];
}

const PRESETS: Preset[] = [
  { id: "evict", label: "Idle sessions → eviction", hint: panelText("scenario.evict"), params: { promptTokens: 10000, outputTokens: 60, maxPods: 1, gpuMemUtil: 0.5, dramGB: 4, ssdGB: 8, returnProb: 0.6, thinkTimeS: 5, scaleDownIdleS: 120 }, speed: 0.25, burst: [40, 8] },
  { id: "preempt", label: "Outputs outgrow the pool → preemption", hint: panelText("scenario.preempt"), params: { promptTokens: 4000, outputTokens: 1500, maxPods: 1, gpuMemUtil: 0.3, returnProb: 0 }, speed: 0.5, burst: [12, 0] },
  { id: "70b", label: "70B on 4 × H100", hint: panelText("scenario.70b"), params: { model: "llama-3-70b", tp: 4, maxPods: 4 }, speed: 0.1, burst: [20, 0] },
  { id: "churn", label: "Conversations with churn", hint: panelText("scenario.churn"), params: { arrivalRate: 2, returnProb: 0.8, thinkTimeS: 3, maxTurns: 8, maxPods: 12 }, speed: 0.25, burst: [100, 2] }
];

/** Hover text of the four parts of a GPU's memory box (src/content/panels.md). */
const GPU_TIP: Record<GpuPart, { title: string; text: string }> = {
  weights: panelFields("gpu.weights", { title: "title", text: "text" }),
  work: panelFields("gpu.work", { title: "title", text: "text" }),
  kv: panelFields("gpu.kv", { title: "title", text: "text" }),
  headroom: panelFields("gpu.headroom", { title: "title", text: "text" })
};

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

/** Whether a queued step may be held now: it has no condition, the condition holds, or it has waited too long. */
function gateOpen(c: Callout, w: World, scene: Scene): boolean {
  if (!c.until || c.until(w, scene)) return true;
  return !!c.queuedAt && (w.t - c.queuedAt.t > GATE_TIMEOUT_S || scene.vt - c.queuedAt.vt > GATE_TIMEOUT_S);
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
  const [tip, setTip] = useState<{ x: number; y: number; part: GpuPart; bytes: number } | null>(null);
  const [callouts, setCallouts] = useState<Shown[]>([]);
  const [preset, setPreset] = useState<string | null>(null);
  const [stepMode, setStepMode] = useState(false);
  const [held, setHeld] = useState<Shown | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [tour, setTour] = useState<number | null>(null);
  const [arch, setArch] = useState(DEFAULT_ARCH);
  const [histPos, setHistPos] = useState<[number, number, boolean]>([0, 0, false]);
  const [, refresh] = useReducer((x: number) => x + 1, 0);
  const live = useRef({ playing, speed, explain, callouts, seen: new Set<string>(), lastShown: new Map<string, number>(), nextId: 1, stepMode: false, held: null as Shown | null, focus: null as number | null, focusDone: false, script: newScript(), freeze: false, queue: [] as Callout[], tour: null as number | null, hist: [] as StepRec[], hi: -1, dirty: false, replay: null as Replay | null, finish: () => {} });
  live.current.tour = tour;
  const heldEl = useRef<HTMLDivElement>(null);
  const tourEl = useRef<HTMLDivElement>(null);
  const ringEl = useRef<HTMLDivElement>(null);
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
    /**
     * Guided stretch (tutorial card or held step-through box): dock the card, work out the screen area
     * it leaves free and ask the scene to frame and highlight what the step is about. Wide screens put
     * the tutorial card at the left and the step box at the bottom, between the menus; narrow screens
     * put both above the transport bar. Does nothing, and costs nothing, when no guided mode is on.
     */
    const guideScene = (scene: Scene, st: typeof live.current, cw: number, ch: number) => {
      const tourStep = st.tour !== null ? TOUR[st.tour]! : null;
      const dock = tourStep ? tourEl.current : st.held ? heldEl.current : null;
      if (!dock) {
        scene.reserve = { l: 0, t: 0, r: 0, b: 0 };
        scene.setGuide(null);
        scene.highlight = null;
        return;
      }
      const narrow = cw < 900;
      const free: Free = { l: 16, t: narrow ? 68 : 80, r: cw - 16, b: ch - (narrow ? 78 : 90) };
      const reserve = { l: 0, t: 0, r: 0, b: 0 };
      const bh = dock.offsetHeight;
      let x: number;
      let y: number;
      if (tourStep && !narrow) {
        x = 16;
        y = Math.max(free.t, (ch - bh) / 2);
        free.l = x + dock.offsetWidth + 24;
        reserve.l = dock.offsetWidth + 24;
      } else {
        if (narrow) {
          dock.style.width = "";
          x = (cw - dock.offsetWidth) / 2;
        } else {
          // the step box sits between the menus, so it never hides them
          const lr = leftRef.current && !leftRef.current.hidden ? leftRef.current.getBoundingClientRect().right + 12 : 16;
          const rl = rightRef.current && !rightRef.current.hidden ? rightRef.current.getBoundingClientRect().left - 12 : cw - 16;
          const bw = Math.max(300, Math.min(520, rl - lr));
          dock.style.width = `${bw}px`;
          x = rl - lr < 300 ? lr : lr + (rl - lr - bw) / 2;
          free.l = lr;
          free.r = rl;
        }
        y = free.b - dock.offsetHeight;
        free.b = y - 12;
        reserve.b = dock.offsetHeight + 12;
      }
      dock.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      const target: Target | undefined = tourStep ? (tourStep.target && !("el" in tourStep.target) ? tourStep.target : undefined) : (st.held!.focus ?? st.held!.target);
      scene.reserve = reserve;
      scene.setGuide(target ? { target, free, key: tourStep ? `tour:${st.tour}` : `step:${st.held!.id}` } : null);
      scene.highlight = target ? { target, tone: tourStep ? TONE.info : TONE[st.held!.tone] } : null;
    };

    /** The tutorial steps that point at a menu or the transport bar outline that element instead of part of the graph. */
    const placeRing = (ring: HTMLDivElement | null, target: (typeof TOUR)[number]["target"]) => {
      if (!ring) return;
      const el = target && "el" in target ? document.querySelector<HTMLElement>(`[data-tour="${target.el}"]`) : null;
      let r: { l: number; t: number; r: number; b: number } | null = null;
      if (el) {
        // a menu column is as tall as the screen; outline the panels it holds
        const kids = el.classList.contains("lv-col") ? [...el.children] : [el];
        for (const k of kids) {
          const b = k.getBoundingClientRect();
          if (b.width === 0) continue;
          r = r ? { l: Math.min(r.l, b.left), t: Math.min(r.t, b.top), r: Math.max(r.r, b.right), b: Math.max(r.b, b.bottom) } : { l: b.left, t: b.top, r: b.right, b: b.bottom };
        }
      }
      ring.style.opacity = r ? "1" : "0";
      if (!r) return;
      ring.style.width = `${r.r - r.l + 12}px`;
      ring.style.height = `${r.b - r.t + 12}px`;
      ring.style.transform = `translate(${Math.round(r.l - 6)}px, ${Math.round(r.t - 6)}px)`;
    };

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
      // Step-through: a step may wait for the picture (`until`). Meanwhile the clock runs, or, for a
      // step that must not let the world move on, only the animation does. A held step may keep the
      // animation playing (`animate`) while the clock stays stopped.
      const head = st.stepMode && !st.held ? st.queue[0] : undefined;
      const waiting = !!head?.until && !gateOpen(head, world, scene);
      const frozen = st.freeze || (waiting && !!head!.hold);
      const replay = st.replay;
      const running = st.playing && !st.held && !frozen;
      const animating = st.playing && (!st.held || !!st.held.animate || !!replay);
      if (running) advance(world, dt * st.speed);
      else if (replay && st.playing && world.t < replay.t) advance(world, Math.min(dt * replay.rate, replay.t - world.t));
      const events = world.events.splice(0);
      scene.focusSid = st.stepMode ? st.focus : null;
      guideScene(scene, st, cw, ch);
      scene.update(world, events, dt, animating, cw, ch);
      scene.draw(ctx, world, dpr);

      // step-through: follow one session and stop the clock at each thing that happens to it
      if (replay) {
        // a step shown again: the animation leads up to a step that is already in the history
        replay.spent += dt;
        const shown = st.hist[replay.to]?.shown;
        if (!st.playing || replay.spent > REPLAY_MAX_S || (world.t >= replay.t - 1e-6 && (!shown?.until || shown.until(world, scene)))) st.finish();
      } else if (st.stepMode) {
        const queueSteps = (e: (typeof events)[number]) => {
          for (const c of stepsFor(e, world, st.script)) {
            st.queue.push({ ...c, queuedAt: { t: world.t, vt: scene.vt } });
            if (c.last) st.focusDone = true;
          }
        };
        const later: typeof events = [];
        for (const raw of events) {
          // one engine step reports the sessions it served in a list; the walkthrough follows one of them
          const e = raw.kind === "step.tokens" && st.focus !== null && (raw.sids as number[]).includes(st.focus) ? { ...raw, sid: st.focus } : raw;
          if (st.focus === null && e.kind === "req.new") {
            st.focus = e.sid!;
            st.script = newScript();
            setFocus(st.focus);
          }
          const req = st.focus !== null ? world.reqs.get(world.sessions.get(st.focus)?.reqId ?? -1) : undefined;
          const mine = STEP_KINDS.has(e.kind) && e.sid === st.focus;
          const fleet = !!req && (e.kind === "pod.loading" || e.kind === "pod.ready" || e.kind === "scale.up" || e.kind === "pod.failed");
          if (!mine && !fleet) continue;
          // the engine saves the turn and notes that the session is idle just before it reports the request done; the walkthrough tells it the other way round
          if (mine && (e.kind === "store.append" || e.kind === "session.idle")) later.push(e);
          else queueSteps(e);
        }
        for (const e of later) queueSteps(e);
        if (st.freeze && (events.length || st.held)) st.freeze = false;
        const next = !st.held ? st.queue[0] : undefined;
        if (next && gateOpen(next, world, scene)) {
          st.queue.shift();
          st.held = { ...next, id: st.nextId++, born: elapsed(world) };
          pushStep(st, st.held, world, scene);
          setHeld(st.held);
          setHistPos(posOf(st));
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
      if (st.tour !== null) placeRing(ringEl.current, TOUR[st.tour]!.target);
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
        const seg = scene.segmentAt(worldRef.current, e.offsetX, e.offsetY);
        setTip((cur) => (seg ? { x: e.offsetX, y: e.offsetY, part: seg.part, bytes: seg.bytes } : cur ? null : cur));
        canvas.style.cursor = scene.hit(worldRef.current, e.offsetX, e.offsetY) ? "pointer" : "grab";
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      scene.takeOver();
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
      scene.takeOver();
      scene.cam.s = Math.max(0.1, Math.min(3, scene.cam.s * Math.exp(-e.deltaY * 0.0015)));
      const after = scene.toWorld(e.offsetX, e.offsetY);
      scene.cam.x += before.x - after.x;
      scene.cam.y += before.y - after.y;
    };
    const leave = () => setTip(null);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("wheel", wheel);
    };
  }, []);

  /**
   * Called before the visitor alters the world (a parameter, a burst of requests, an architecture).
   * If a rewound step is showing, the steps after it describe a future that no longer happens, so
   * they are discarded and the simulation continues live from here. If the latest step is showing,
   * its stored snapshot is now out of date; it is taken again before the visitor leaves the step.
   */
  const touchWorld = useCallback(() => {
    const st = live.current;
    st.finish();
    if (!st.stepMode || !st.held) return;
    if (st.hi < st.hist.length - 1) {
      st.hist.length = st.hi + 1;
      setHistPos(posOf(st));
    }
    st.dirty = true;
  }, []);

  const set = useCallback(
    <K extends keyof Params>(key: K, value: Params[K]) => {
      touchWorld();
      setParam(worldRef.current, key, value);
      refresh();
    },
    [touchWorld]
  );

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
    st.script = newScript();
    st.freeze = false;
    st.hist = [];
    st.replay = null;
    st.hi = -1;
    st.dirty = false;
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
    st.script = newScript();
    st.freeze = false;
    // follow the selected session, else the newest one still waiting on a model call, else the next to arrive
    let f: number | null = selected?.type === "session" ? selected.id : null;
    if (f === null) for (const s of worldRef.current.sessions.values()) if (s.reqId !== null) f = s.id;
    st.focus = st.stepMode ? f : null;
    st.callouts = [];
    st.hist = [];
    st.replay = null;
    st.hi = -1;
    st.dirty = false;
    setCallouts([]);
    setHeld(null);
    setFocus(st.focus);
    setStepMode(st.stepMode);
    if (st.stepMode) setPlaying(true);
  };

  /** Put back the world, the picture and the bookkeeping stored with a step. */
  const restoreSnap = (snap: Snap) => {
    const st = live.current;
    worldRef.current = structuredClone(snap.world);
    sceneRef.current.restore(snap.scene);
    st.queue = [...snap.queue];
    st.focus = snap.focus;
    st.focusDone = snap.focusDone;
    st.script = structuredClone(snap.script);
    st.freeze = false;
    setFocus(st.focus);
  };
  /** End a replay: the stored snapshot of the step replaces what the replay produced. */
  live.current.finish = () => {
    const st = live.current;
    const r = st.replay;
    if (!r) return;
    st.replay = null;
    const snap = st.hist[r.to]?.snap;
    if (snap) restoreSnap(snap);
    refresh();
  };
  /**
   * Show step `i` again. With the previous step's snapshot at hand the animation of the step plays
   * again from its start (see Replay); otherwise, or when paused, the stored snapshot is put back.
   */
  const showStep = (i: number) => {
    const st = live.current;
    st.replay = null;
    const rec = st.hist[i]!;
    const from = i > 0 ? st.hist[i - 1]!.snap : null;
    st.hi = i;
    if (rec.snap && from && st.playing && rec.snap.world.t > from.world.t) {
      restoreSnap(from);
      // the forced eviction happens when Next is pressed on the step that announces it
      const evict = st.hist[i - 1]!.shown.evict;
      if (evict) evictIdleNow(worldRef.current, evict.sid, evict.podId);
      // the stored snapshot supplies what the step-through itself knows once the replay ends
      st.queue = [...rec.snap.queue];
      st.focus = rec.snap.focus;
      st.focusDone = rec.snap.focusDone;
      st.script = structuredClone(rec.snap.script);
      const span = rec.snap.world.t - from.world.t;
      st.replay = { to: i, t: rec.snap.world.t, rate: Math.max(st.speed, span / (REPLAY_MAX_S - 1)), spent: 0 };
    } else if (rec.snap) restoreSnap(rec.snap);
    st.held = rec.shown;
    setHeld(st.held);
    setHistPos(posOf(st));
    refresh();
  };
  /** The latest step's snapshot is stale if the visitor changed the world while it was showing. */
  const refreshLatest = () => {
    const st = live.current;
    const rec = st.hist[st.hist.length - 1];
    if (st.dirty && rec && st.hi === st.hist.length - 1) rec.snap = takeSnap(worldRef.current, sceneRef.current, st);
    st.dirty = false;
  };

  // Back and Next move between stored steps by restoring their snapshots, so the graph shows
  // exactly the situation of that step. Next from the latest step runs the clock to the next event.
  const nextStep = () => {
    const st = live.current;
    st.finish();
    if (st.hi < st.hist.length - 1) {
      showStep(st.hi + 1);
      return;
    }
    refreshLatest();
    const leaving = st.held;
    if (leaving?.evict) {
      // the walkthrough's forced eviction: the simulation's own tier code moves the session's KV; the events it emits become the next steps
      if (evictIdleNow(worldRef.current, leaving.evict.sid, leaving.evict.podId)) {
        st.script.forcing = true;
        st.freeze = true;
      } else st.queue.push(end(leaving.evict.sid, "body-evicted"));
    }
    // a step that waits for the picture is held by the frame loop once it is ready
    const head = st.queue[0];
    const next = head && gateOpen(head, worldRef.current, sceneRef.current) ? st.queue.shift() : undefined;
    st.held = next ? { ...next, id: st.nextId++, born: elapsed(worldRef.current) } : null;
    if (st.held) pushStep(st, st.held, worldRef.current, sceneRef.current);
    else if (st.focusDone && !head && !st.freeze) {
      st.focus = null;
      st.focusDone = false;
      st.script = newScript();
      setFocus(null);
    }
    setHeld(st.held);
    setHistPos(posOf(st));
  };
  const prevStep = () => {
    const st = live.current;
    st.finish();
    if (st.hi <= 0) return;
    refreshLatest();
    showStep(st.hi - 1);
  };

  const trace = () => {
    if (!live.current.stepMode) toggleStep();
    send(1);
  };

  const applyArch = (id: string) => {
    const a = ARCHITECTURES.find((x) => x.id === id)!;
    touchWorld();
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
    touchWorld();
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

  // The tutorial hides the menus except on the step that is about them; on a narrow screen the
  // step-through box takes the place of the left menu, which is a sheet at the bottom there.
  const tourTarget = tour !== null ? TOUR[tour]!.target : undefined;
  const narrow = window.innerWidth < 900;
  const showLeft = panels && tour === null && !(stepMode && narrow);
  const showRight = tour !== null ? !!tourTarget && "el" in tourTarget && tourTarget.el === "right" : panels;

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
          <h1>{EMPTY_TEXT.title}</h1>
          <p>
            <Rich inline text={EMPTY_TEXT.text} />
          </p>
          <button className="lv-primary" data-testid="send-first" onClick={() => send(1)}>
            Send one request
          </button>
          <button className="lv-secondary" data-testid="trace-first" onClick={trace}>
            Trace one request, step by step
          </button>
          <small>
            <Rich inline text={EMPTY_TEXT.hint} />
          </small>
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
            <b>
              <Rich inline text={c.title} />
            </b>
            <span>
              <Rich inline text={c.body} />
            </span>
          </div>
        ))}
      </div>

      {tip && (
        <div className="lv-tip" data-testid="gpu-tip" style={{ left: tip.x + 14, top: tip.y + 16 }}>
          <b>{GPU_TIP[tip.part].title}</b>
          <i>{fmtGB(tip.bytes, 2)} per GPU</i>
          <span>
            <Rich inline text={GPU_TIP[tip.part].text} />
          </span>
        </div>
      )}

      {held && (
        <div className={`lv-callout lv-step tone-${held.tone}`} ref={heldEl} data-testid="step-box">
          <div className="lv-step-scroll" data-testid="step-scroll">
          {held.at && (
              <strong className="lv-step-at" data-testid="step-at">
                <Rich inline text={held.at} />
              </strong>
            )}
            <em data-testid="step-where">
              {panelFields("step.header", { text: [focus !== null ? "text-session" : "text-fleet", histPos[2] && "no-rewind"] }, { n: histPos[0] + 1, total: histPos[1], time: held.born.toFixed(2), ...(focus !== null ? { sid: focus } : {}) }).text}
            </em>
            <b>
              <Rich inline text={held.title} />
            </b>
            <div className="lv-step-text">
              <Rich text={held.body} />
              {held.detail && <Rich text={held.detail} />}
            </div>
            {held.dive.length > 0 && (
              <section className="lv-dive" data-testid="dive" aria-label="Dive deeper">
                <h4>Dive deeper</h4>
                {held.dive.map((d) => (
                  // keyed by step: the items are closed again whenever the step changes
                  <details key={`${held.id}:${d.id}`} className="lv-dive-item" data-testid="dive-item">
                    <summary>
                      <Rich inline text={d.title} />
                    </summary>
                    <div className="lv-dive-body">
                      <Rich text={d.body} />
                      {d.formula && <Rich text={d.formula} />}
                    </div>
                  </details>
                ))}
              </section>
            )}
          </div>
          <div className="lv-step-actions">
            <button className="lv-ghost" onClick={toggleStep}>
              exit
            </button>
            <button className="lv-ghost" data-testid="step-back" disabled={histPos[0] <= 0} onClick={prevStep}>
              ◂ Back
            </button>
            <button className="lv-next" data-testid="step-next" onClick={nextStep}>
              {held.last ? "Follow another session ▸" : "Next ▸"}
            </button>
          </div>
        </div>
      )}

      {tour !== null && (
        <>
          <div className="lv-ring" ref={ringEl} />
          <div className="lv-tour" ref={tourEl} data-testid="tour">
            <TourArt id={TOUR[tour]!.id} key={TOUR[tour]!.id} />
            <b>
              <Rich inline text={TOUR[tour]!.title} />
            </b>
            <Rich text={TOUR[tour]!.text} />
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

      <div className="lv-col lv-left" ref={leftRef} hidden={!showLeft}>
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
            const a = architectureText(arch);
            return (
              <details className="lv-arch" open>
                <summary>What this step adds</summary>
                <p className="lv-note">
                  <b>
                    <Rich inline text={a.name} />.
                  </b>{" "}
                  <Rich inline text={a.adds} />
                </p>
                <Rich text={a.source} className="lv-note lv-src" />
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
            {activePreset && <Rich text={activePreset.hint} className="lv-note" />}
          </Group>
          <Group title="Session behaviour">
            <Slider id="prompt-tokens" label="first prompt, mean length" value={p.promptTokens} min={200} max={64000} step={200} fmt={(v) => `${fmtInt(v)} tok`} onChange={(v) => set("promptTokens", v)} />
            <Slider label="follow-up prompt, mean length" value={p.followTokens} min={10} max={8000} step={10} fmt={(v) => `${fmtInt(v)} tok`} onChange={(v) => set("followTokens", v)} />
            <Slider label="answer, mean length" value={p.outputTokens} min={10} max={2000} step={10} fmt={(v) => `${fmtInt(v)} tok`} onChange={(v) => set("outputTokens", v)} />
            <Slider label="time between follow-ups" value={p.thinkTimeS} min={0.5} max={60} step={0.5} fmt={(v) => `${v} s`} onChange={(v) => set("thinkTimeS", v)} />
            <Slider label="sessions that reply again after a turn" value={p.returnProb} min={0} max={1} step={0.05} fmt={(v) => `${(v * 100).toFixed(0)}%`} onChange={(v) => set("returnProb", v)} />
            <Slider label="turns before a session ends" value={p.maxTurns} min={1} max={40} step={1} onChange={(v) => set("maxTurns", v)} />
            <Slider label="new sessions per second" value={p.arrivalRate} min={0} max={50} step={0.5} onChange={(v) => set("arrivalRate", v)} />
            <Rich text={panelText("sessions.note", { returnPct: (p.returnProb * 100).toFixed(0), thinkTime: p.thinkTimeS, leavePct: ((1 - p.returnProb) * 100).toFixed(0) })} className="lv-note" />
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

      <div className="lv-col lv-right" ref={rightRef} hidden={!showRight} data-tour="right">
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
            <Rich text={panelText("model.note")} className="lv-note" />
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
              <Rich
                text={panelText("spec.note", {
                  tokensPerStep: ((1 - p.specAccept ** (p.specK + 1)) / (1 - p.specAccept)).toFixed(2),
                  speedup: ((1 - p.specAccept ** (p.specK + 1)) / ((1 - p.specAccept) * (p.specK * p.specCost + 1))).toFixed(2)
                })}
                className="lv-note"
              />
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
            <Rich text={panelText("scaling.note")} className="lv-note" />
          </Group>
          <Group title="Memory tiers">
            <Slider label="host DRAM for KV" value={p.dramGB} min={0} max={256} step={4} fmt={(v) => (v ? `${v} GB` : "off")} onChange={(v) => set("dramGB", v)} />
            <Slider label="local SSD for KV" value={p.ssdGB} min={0} max={1024} step={8} fmt={(v) => (v ? `${v} GB` : "off")} onChange={(v) => set("ssdGB", v)} />
            <Slider label="remote pool, shared by all pods" value={p.remoteGB} min={0} max={4096} step={32} fmt={(v) => (v ? `${v} GB` : "off")} onChange={(v) => set("remoteGB", v)} />
            <Slider label="DRAM ↔ HBM copy rate" value={p.dramGBs} min={5} max={64} step={1} fmt={(v) => `${v} GB/s`} onChange={(v) => set("dramGBs", v)} />
            <Slider label="SSD read rate" value={p.ssdGBs} min={0.5} max={14} step={0.5} fmt={(v) => `${v} GB/s`} onChange={(v) => set("ssdGBs", v)} />
            <Slider label="remote pool link" value={p.remoteGbps} min={10} max={400} step={2} fmt={(v) => `${v} Gbps`} onChange={(v) => set("remoteGbps", v)} />
            <Rich text={panelText("tiers.measured")} className="lv-note" />
            <Rich text={panelText("tiers.flow")} className="lv-note" />
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
              <Rich text={panelText("legend.note")} className="lv-note" />
            </div>
          </Group>
        </section>
      </div>

      <div className="lv-transport" data-tour="transport">
        <button className="lv-play" data-testid="play-toggle" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="lv-clock" data-testid="clock">
          <b>{elapsed(w).toFixed(2)} s</b>
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
          onClick={() => sceneRef.current.fitNow()}
        >
          fit
        </button>
        <button className="lv-ghost" data-testid="reset" onClick={() => reset()}>
          reset
        </button>
      </div>
    </div>
  );
}
