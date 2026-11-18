import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { STEP_KINDS, calloutFor, type Callout } from "./callouts.js";
import { GATE_TIMEOUT_S, end, newScript, stepsFor, type Script } from "./walkthrough.js";
import { TOUR, TourArt } from "./Tutorial.js";
import { Inspector } from "./Inspector.js";
import { Rich } from "./Rich.js";
import { architectureText, panelFields, panelText, replayFields, replayText } from "../content/index.js";
import { fmtGB, fmtInt, fmtMs } from "./format.js";
import { C, Scene, TONE, type Free, type GpuPart, type Target } from "./render.js";
import { ReplayRun } from "../replay/adapter.js";
import { blankRun } from "../replay/blank.js";
import { loadReplay } from "../replay/load.js";
import { BlisBadge, ReadOnlySettings, ScenarioPanel, type Mode } from "../replay/ReplayPanels.js";
import { LogButton, LogPanel, flyToLog, logAppend, type LogEntry } from "./Log.js";
import { ReplayInspector } from "../replay/ReplayInspector.js";
import { DEFAULT_REPLAY, type ReplayId } from "../replay/scenarios.js";
import type { ReplayFile } from "../replay/schema.js";
import { exploreRun, type Run, type RunWorld } from "./run.js";
import { ARCHITECTURES, DEFAULT_ARCH, DEFAULT_PARAMS, GPUS, MODELS, advance, costPerMTok, createWorld, elapsed, evictIdleNow, fitOf, fitsWith, fixesFor, kvFill, livePods, median, replicaSpec, setParam, spawnBurst, tokensPerSecond, type Fix, type Params, type World } from "../sim/index.js";
import "./live.css";

const EMPTY_TEXT = panelFields("empty", { title: "title", text: "text", hint: "hint" });
/** What the router says on its node while requests wait and no pod can start (src/content/panels.md). */
const GATEWAY_NOTE = panelText("fit.gateway");
const SPEEDS = [0.02, 0.05, 0.1, 0.25, 0.5, 1];
/** A replay runs at BLIS's own pace at 1×; its scenarios last from under a minute to a few, so it also offers faster. */
const REPLAY_SPEEDS = [0.5, 1, 2, 5, 10];
const EXPLORE_SPEED = 0.1;
const REPLAY_SPEED = 1;
/** The text drawn on each pod where a replay has no per-step detail (src/content/replay.md). */
const AGGREGATE_NOTE = (() => {
  const l = replayFields("pod.aggregate", { a: "line-1", b: "line-2", c: "line-3", d: "line-4" });
  return [l.a, l.b, l.c, l.d].join("\n");
})();

interface Calibrated {
  id: ReplayId;
  status: "loading" | "ready" | "failed";
  file: ReplayFile | null;
  error: string;
}
/**
 * Seconds of animation every explanation box stays before it flies into the history, at the default speed. A
 * slower speed stretches it (and the pace between boxes) in proportion, so slowing down slows the notes as well
 * as the graph; a faster one shortens it, but only so far, so a note stays readable.
 */
const CALLOUT_TTL = 6;
/** Most explanation boxes on screen or waiting at once; past it the oldest leaves early. */
const MAX_CALLOUTS = 12;
/** Seconds between two boxes appearing, at the default speed: they come one at a time, so they also leave one at a time. */
const PACE_S = 2.2;
/** How much longer the notes stay, and the longer they wait for each other, at `speed` than at the default speed. */
function noteStretch(speed: number): number {
  return Math.max(0.5, Math.min(5, EXPLORE_SPEED / speed));
}
/**
 * While a box waits for its turn the whole simulation runs at this share of the chosen speed, so the picture keeps
 * pace with the text. It slows everything alike, so every duration keeps its proportion to the others.
 */
const READING_SHARE = 0.15;
/** A repeated notice (not a first explanation) that has waited this long for its turn is not shown late; it goes straight to the history. */
const STALE_S = 3;
/** How fast the clock eases into and out of a slow-down or fast-forward, per second. */
const WARP_EASE = 2.5;
/** Space between stacked boxes and between a stack and the graph, px. */
const STACK_GAP = 8;
/** Seconds the restart note keeps the router's node to itself before other notes may take it. */
const RESTART_HOLD_S = 6;

interface Shown extends Callout {
  id: number;
  born: number;
  /** simulated seconds when it was shown, for the history log */
  simT?: number;
  /** waiting, hidden, for room beside the graph; `born` counts from when it is shown */
  waiting?: boolean;
  /** animation seconds when it was created */
  created?: number;
  /** its number in the current run of boxes, given when it appears */
  no?: number;
}

/** The floating notes button's size plus its gap, px: boxes keep clear of the corner it sits in. */
const NOTES_BTN_PX = 56;
/** Below this width the screen is a phone: menus start closed, explanation boxes dock under the metrics. */
const NARROW_PX = 900;
/**
 * A pod's cold start (container, then weights) plays this many times faster than the chosen speed while there is
 * nothing else to watch: in the step-through, and in the live view while no pod is ready yet and no box is
 * waiting. A factor on the speed, so a slower speed slows the cold start too. The model's cold start
 * (`coldStartS`, 2 s) is already shortened from the minutes a real one takes; this only fast-forwards the wait.
 */
const COLD_START_WARP = 2.5;

/** What the clock is doing besides the chosen speed: slowed so a box can be read, or fast-forwarding a cold start. */
function warpLabel(warp: number, narrow: boolean): string {
  if (warp < 0.9) return narrow ? "slowed" : "slowed to read";
  if (warp > 1.1) return narrow ? "⏩ start" : "⏩ cold start";
  return "simulated";
}

/** A speech bubble with lines of text; struck through when the notes are off. */
function NotesIcon({ off }: { off: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" />
      {off ? <path d="M3 3l18 18" /> : <path d="M7.5 9.5h9M7.5 13h6" />}
    </svg>
  );
}

/** The speed picker on a phone: one row tall; scroll it, or tap a neighbour, to change the speed. */
function SpeedWheel({ speeds, value, onChange }: { speeds: number[]; value: number; onChange: (s: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const ROW = 14;
  useEffect(() => {
    const el = ref.current;
    const i = speeds.indexOf(value);
    if (el && i >= 0 && Math.abs(el.scrollTop - i * ROW) > 1) el.scrollTo({ top: i * ROW });
  }, [value, speeds]);
  const onScroll = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const s = speeds[Math.max(0, Math.min(speeds.length - 1, Math.round(el.scrollTop / ROW)))]!;
      if (s !== value) onChange(s);
    }, 120);
  };
  return (
    <div className="lv-wheel" ref={ref} onScroll={onScroll} role="listbox" aria-label="Playback speed" data-testid="speed-wheel">
      <i />
      {speeds.map((s) => (
        <button key={s} role="option" aria-selected={s === value} className={s === value ? "on" : ""} data-testid={`speed-${s}`} onClick={() => onChange(s)}>
          {s}×
        </button>
      ))}
      <i />
    </div>
  );
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
  { id: "preempt", label: "Outputs outgrow the pool → preemption", hint: panelText("scenario.preempt"), params: { promptTokens: 4000, outputTokens: 1500, maxPods: 1, gpuMemUtil: 0.28, returnProb: 0 }, speed: 0.5, burst: [12, 0] },
  { id: "70b", label: "70B on 4 × H100", hint: panelText("scenario.70b"), params: { model: "llama-3.1-70b", tp: 4, maxPods: 4 }, speed: 0.1, burst: [20, 0] },
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

/** Hover text and note for the menu options that would not fit (src/content/panels.md). */
const FIT_OPTION = panelFields("fit.option", { title: "title", note: "note" });

function Choice<T extends string | number | boolean>({ label, value, options, onChange, nofit }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void; nofit?: (v: T) => boolean }) {
  return (
    <div className="lv-choice">
      <span>{label}</span>
      <div className="lv-seg">
        {options.map(([v, l]) => {
          const bad = !!nofit?.(v);
          return (
            <button key={String(v)} className={`${v === value ? "on" : ""}${bad ? " nofit" : ""}`} data-fit={bad ? "no" : undefined} title={bad ? FIT_OPTION.title : undefined} onClick={() => onChange(v)}>
              {l}
              {bad && <i aria-hidden="true">⊘</i>}
            </button>
          );
        })}
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

/** The label and small print of a fix button (src/content/panels.md, `fit.fix`). */
function fixText(f: Fix): { label: string; pool: string } {
  const label = panelFields("fit.fix", { label: f.kind }, f.kind === "precision" ? {} : { value: f.value }).label;
  const pool = panelFields("fit.fix", { pool: "pool" }, { tokens: fmtInt(Math.round(f.poolTokens / 100) * 100) }).pool;
  return { label, pool };
}

export function LiveView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World>(createWorld({ ...DEFAULT_PARAMS }));
  const sceneRef = useRef(new Scene());
  // what drives the canvas: the TypeScript model, or (Calibrated mode) a BLIS replay
  const exploreRef = useRef<Run>(exploreRun(() => worldRef.current));
  const runRef = useRef<Run>(exploreRef.current);
  const loadToken = useRef(0);
  const [mode, setMode] = useState<Mode>("explore");
  const [cal, setCal] = useState<Calibrated>({ id: DEFAULT_REPLAY, status: "loading", file: null, error: "" });
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
  const live = useRef({ playing, speed, explain, callouts, seen: new Set<string>(), lastShown: new Map<string, number>(), nextId: 1, stepMode: false, held: null as Shown | null, focus: null as number | null, focusDone: false, script: newScript(), freeze: false, queue: [] as Callout[], tour: null as number | null, hist: [] as StepRec[], hi: -1, dirty: false, replay: null as Replay | null, warp: 1, finish: () => {}, toLog: (() => {}) as (c: Shown, kind: LogEntry["kind"], fly: boolean) => void });
  live.current.tour = tour;
  const heldEl = useRef<HTMLDivElement>(null);
  const tourEl = useRef<HTMLDivElement>(null);
  const fitEl = useRef<HTMLDivElement>(null);
  const ringEl = useRef<HTMLDivElement>(null);
  live.current.playing = playing;
  live.current.speed = speed;
  live.current.explain = explain;
  live.current.callouts = callouts;
  const calloutEls = useRef(new Map<number, HTMLDivElement>());
  const leaderSvg = useRef<SVGSVGElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const [panels, setPanels] = useState(() => window.innerWidth >= NARROW_PX);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [logUnread, setLogUnread] = useState(false);
  const logOpenRef = useRef(false);
  logOpenRef.current = logOpen;
  const logBtn = useRef<HTMLButtonElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState<{ left: number; bottom: number } | null>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  /** Put an explanation in the history; `fly` animates its box into the history button first. */
  const toLog = useCallback((c: Shown, kind: LogEntry["kind"], fly: boolean) => {
    const el = kind === "callout" ? calloutEls.current.get(c.id) : null;
    if (fly && el) flyToLog(el, logBtn.current);
    setLog((l) => logAppend(l, { id: c.id, kind, t: c.simT ?? c.born, tone: c.tone, title: c.title, body: c.body, target: c.focus ?? c.target, ...(c.no ? { no: c.no } : {}) }));
    if (!logOpenRef.current) setLogUnread(true);
  }, []);
  live.current.toLog = toLog;
  const calibrated = mode === "calibrated";
  const w: RunWorld = runRef.current.world;
  const p = w.params;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const scene = sceneRef.current;
    let raf = 0;
    let last = performance.now();
    let lastRefresh = 0;
    (window as unknown as { __live: unknown }).__live = { world: () => worldRef.current, run: () => runRef.current, scene };
    /**
     * Guided stretch (tutorial card or held step-through box): dock the card, work out the screen area
     * it leaves free and ask the scene to frame and highlight what the step is about. Wide screens put
     * the tutorial card at the left and the step box at the bottom, between the menus; narrow screens
     * put both above the transport bar. Does nothing, and costs nothing, when no guided mode is on.
     */
    const guideScene = (scene: Scene, st: typeof live.current, cw: number, ch: number, bannerH: number) => {
      const tourStep = st.tour !== null ? TOUR[st.tour]! : null;
      const dock = tourStep ? tourEl.current : st.held ? heldEl.current : null;
      if (!dock) {
        scene.reserve = { l: 0, t: bannerH, r: 0, b: 0 };
        scene.setGuide(null);
        scene.highlight = null;
        return;
      }
      const narrow = cw < 900;
      const free: Free = { l: 16, t: (narrow ? 68 : 80) + bannerH, r: cw - 16, b: ch - (narrow ? 78 : 90) };
      const reserve = { l: 0, t: bannerH, r: 0, b: 0 };
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

    /** Where each explanation box is drawn now; boxes glide to their places instead of jumping when pushed. */
    const placed = new Map<number, { x: number; y: number }>();
    /** The side each box was given when it first appeared: above its node or the graph, or below the graph. It keeps it. */
    const sides = new Map<number, "above" | "below">();
    /** When the last box appeared, and the number it got; numbers start again at 1 once the screen is empty. */
    let lastReveal = -99;
    let lastNo = 0;
    /** The line from each box to the part of the graph it explains, with the box's number at that end. */
    const leaders = new Map<number, SVGGElement>();
    const SVG = "http://www.w3.org/2000/svg";
    const leaderOf = (c: Shown): SVGGElement | null => {
      const svg = leaderSvg.current;
      if (!svg) return null;
      let g = leaders.get(c.id);
      if (!g) {
        g = document.createElementNS(SVG, "g");
        g.setAttribute("class", `lv-leader tone-${c.tone}`);
        g.appendChild(document.createElementNS(SVG, "line"));
        g.appendChild(document.createElementNS(SVG, "circle")).setAttribute("r", "8");
        const t = g.appendChild(document.createElementNS(SVG, "text"));
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "central");
        svg.appendChild(g);
        leaders.set(c.id, g);
      }
      return g;
    };
    /**
     * Lay out the explanation boxes. Newest first, each box sits nearest to what it explains and pushes the older
     * ones on its side away from it. A new box goes above when there is room there, else below the graph; with
     * room on neither side it waits, hidden, until an older box leaves, so every box gets its full time. On a
     * phone the two stacks are one above and one below the whole graph; on a wide screen each node has its own,
     * above the node (the tokenizer's and the stream's below it) or below the graph, kept clear of the metrics
     * strip, the corner menus and the transport bar. Returns the oldest box of a side that has run out of room,
     * which then leaves early, or null.
     */
    const placeCallouts = (list: Shown[], world: World, cw: number, ch: number, bannerH: number, stretch: number): Shown | null => {
      const scene = sceneRef.current;
      const want = new Map<number, { x: number; y: number }>();
      const items = [...list].reverse().flatMap((c) => {
        const el = calloutEls.current.get(c.id);
        return el ? [{ c, el, h: el.offsetHeight, w: el.offsetWidth }] : [];
      });
      const g = scene.contentOnScreen() ?? { l: 0, t: ch / 2, r: cw, b: ch / 2 };
      // on a phone the notes button floats in the corner above the transport bar; boxes stop above it
      const bottom = ch - (scene.panels.bottom || 96) - (cw < NARROW_PX ? NOTES_BTN_PX : 0);
      // stacks: a key, the room each side has, and what is already in it; older boxes keep their side
      type Stack = { room: { above: number; below: number }; used: { above: number; below: number }; boxes: { above: typeof items; below: typeof items } };
      const stacks = new Map<string, Stack>();
      const stackOf = (key: string, room: Stack["room"]) => {
        let s = stacks.get(key);
        if (!s) stacks.set(key, (s = { room, used: { above: 0, below: 0 }, boxes: { above: [], below: [] } }));
        return s;
      };
      const top = (hudRef.current?.getBoundingClientRect().bottom ?? 70) + STACK_GAP + bannerH;
      const anchors = new Map<number, { x: number; y: number }>();
      const keyOf = (it: (typeof items)[number]): string | null => {
        if (cw < NARROW_PX) {
          stackOf("all", { above: g.t - STACK_GAP - top, below: bottom - (g.b + STACK_GAP) });
          return "all";
        }
        const a = scene.anchor(world, it.c.target);
        if (!a) return null;
        const p = scene.toScreen(a);
        anchors.set(it.c.id, p);
        const under = it.c.target.type === "tokenizer" || it.c.target.type === "stream";
        const key = `${it.c.target.type}:${"id" in it.c.target ? it.c.target.id : ""}`;
        // the tokenizer and the stream sit low in the graph: their only side is just under their node
        stackOf(key, under ? { above: 0, below: bottom - (p.y + 12) } : { above: p.y - 12 - 84, below: bottom - (g.b + STACK_GAP) });
        return key;
      };
      // boxes already shown first, then waiting ones oldest first, so a new box sees the room its elders take
      const order = [...items].reverse();
      // a stack where a box is waiting takes no newer box before it: first come, first shown
      const blocked = new Set<string>();
      // and one box at a time appears, PACE_S apart, so they leave one at a time too
      let turn = scene.vt - lastReveal >= PACE_S * stretch;
      if (!list.length) lastNo = 0;
      for (const it of [...order.filter((x) => !x.c.waiting), ...order.filter((x) => x.c.waiting)]) {
        const key = keyOf(it);
        if (key === null) continue;
        const st = stacks.get(key)!;
        const h = it.h + STACK_GAP;
        let side = sides.get(it.c.id);
        if (!side) {
          const fits = blocked.has(key) ? null : st.used.above + h <= st.room.above ? "above" : st.used.below + h <= st.room.below ? "below" : null;
          // not its turn yet, or no room on either side: wait (with no room, unless nothing else is there; then it overlaps rather than never shows)
          if (!turn || (!fits && (blocked.has(key) || st.boxes.above.length + st.boxes.below.length > 0))) {
            it.c.born = scene.vt;
            blocked.add(key);
            continue;
          }
          side = fits ?? (st.room.above - st.used.above >= st.room.below - st.used.below ? "above" : "below");
          sides.set(it.c.id, side);
          if (it.c.waiting) {
            it.c.waiting = false;
            it.c.born = scene.vt;
            it.c.no = ++lastNo;
            const badge = it.el.querySelector(".lv-callout-no");
            if (badge) badge.textContent = String(it.c.no);
            lastReveal = scene.vt;
            turn = false;
          }
        }
        st.used[side] += h;
        st.boxes[side].unshift(it);
      }
      // newest nearest the graph (or the node), older ones further out
      let evict: Shown | null = null;
      for (const [key, st] of stacks) {
        for (const side of ["above", "below"] as const) {
          const list = st.boxes[side];
          if (!list.length) continue;
          const total = st.used[side];
          // out of room: the oldest of this side leaves early, unless it is the only box there
          if (total > st.room[side] + STACK_GAP && list.length > 1) {
            const oldest = list[list.length - 1]!.c;
            if (!evict || oldest.born < evict.born) evict = oldest;
          }
          if (key === "all") {
            let y = side === "above" ? Math.max(g.t - STACK_GAP, top + total) : Math.min(g.b + STACK_GAP, bottom - total);
            for (const it of list) {
              if (side === "above") {
                y -= it.h;
                want.set(it.c.id, { x: cw / 2, y });
                y -= STACK_GAP;
              } else {
                want.set(it.c.id, { x: cw / 2, y });
                y += it.h + STACK_GAP;
              }
            }
            continue;
          }
          const under = st.room.above === 0;
          let used = 0;
          for (const it of list) {
            const s = anchors.get(it.c.id)!;
            let y = side === "above" ? s.y - 12 - used - it.h : (under ? s.y + 12 : g.b + STACK_GAP) + used;
            used += it.h + STACK_GAP;
            if (side === "above") y = Math.max(y, 84);
            // never under the transport bar
            y = Math.min(y, bottom - it.h);
            const hw = it.w / 2 + 8;
            const minX = y < scene.panels.lh ? scene.panels.lw + hw : hw;
            // clear of the menus at the top right and of the notes button at the bottom right
            const maxX = y < scene.panels.rh ? cw - scene.panels.rw - hw : y + it.h > bottom - NOTES_BTN_PX ? cw - NOTES_BTN_PX - hw : cw - hw;
            want.set(it.c.id, { x: Math.max(minX, Math.min(maxX, s.x)), y });
          }
        }
      }
      for (const it of items) {
        const t = want.get(it.c.id);
        const g = leaderOf(it.c);
        if (!t) {
          it.el.style.opacity = "0";
          if (g) g.style.opacity = "0";
          continue;
        }
        const cur = placed.get(it.c.id) ?? t;
        const p = { x: cur.x + (t.x - cur.x) * 0.25, y: cur.y + (t.y - cur.y) * 0.25 };
        placed.set(it.c.id, p);
        const op = Math.min(1, (scene.vt - it.c.born) * 3);
        it.el.style.opacity = String(op);
        it.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, 0)`;
        // the leader: from the box's nearest edge to the part it explains
        const a = scene.anchor(world, it.c.target);
        if (!g) continue;
        if (!a) {
          g.style.opacity = "0";
          continue;
        }
        const end = scene.toScreen(a);
        const l = p.x - it.w / 2;
        const r = p.x + it.w / 2;
        const bx = Math.max(l + 10, Math.min(r - 10, end.x));
        const by = end.y > p.y + it.h ? p.y + it.h : end.y < p.y ? p.y : NaN;
        const inside = Number.isNaN(by) && end.x >= l && end.x <= r;
        const from = Number.isNaN(by) ? { x: end.x < l ? l : r, y: Math.max(p.y + 10, Math.min(p.y + it.h - 10, end.y)) } : { x: bx, y: by };
        g.style.opacity = inside ? "0" : String(op);
        const [line, dot, label] = g.children as unknown as [SVGLineElement, SVGCircleElement, SVGTextElement];
        line.setAttribute("x1", String(Math.round(from.x)));
        line.setAttribute("y1", String(Math.round(from.y)));
        line.setAttribute("x2", String(Math.round(end.x)));
        line.setAttribute("y2", String(Math.round(end.y)));
        dot.setAttribute("cx", String(Math.round(end.x)));
        dot.setAttribute("cy", String(Math.round(end.y)));
        label.setAttribute("x", String(Math.round(end.x)));
        label.setAttribute("y", String(Math.round(end.y)));
        label.textContent = it.c.no ? String(it.c.no) : "";
      }
      for (const [id, g] of leaders) {
        if (list.some((c) => c.id === id && !c.waiting)) continue;
        if (!list.some((c) => c.id === id)) {
          g.remove();
          leaders.delete(id);
        } else g.style.opacity = "0";
      }
      for (const id of placed.keys()) if (!list.some((c) => c.id === id)) placed.delete(id);
      for (const id of sides.keys()) if (!list.some((c) => c.id === id)) sides.delete(id);
      return evict;
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const run = runRef.current;
      const calibrated = run.kind === "calibrated";
      // the TypeScript model's own world: the step-through and the callouts read it, and they are off in Calibrated mode
      const world = worldRef.current;
      const shown = run.world;
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
      // The clock's warp, a factor on the chosen speed that applies to the whole simulation at once, so every
      // duration keeps its proportion to the others: slowed while a box waits for its turn, fast-forwarded through
      // a cold start with nothing else to watch. It eases in and out instead of jumping.
      // only a first explanation slows the clock; a busy run's repeated notices never hold it back
      const reading = !st.stepMode && st.callouts.some((c) => c.waiting && c.once && scene.vt - (c.created ?? scene.vt) > 0.1);
      const starting = world.pods.some((p) => p.state === "creating" || p.state === "loading");
      const cold = starting && (st.stepMode || !world.pods.some((p) => p.state === "ready"));
      const target = reading ? READING_SHARE : cold ? COLD_START_WARP : 1;
      st.warp += (target - st.warp) * Math.min(1, dt * WARP_EASE);
      if (Math.abs(st.warp - target) < 0.01) st.warp = target;
      if (calibrated) {
        if (st.playing) run.advance(dt * st.speed);
      } else if (running) {
        advance(world, dt * st.speed * st.warp);
      }
      else if (replay && st.playing && world.t < replay.t) advance(world, Math.min(dt * replay.rate, replay.t - world.t));
      const events = shown.events.splice(0);
      scene.focusSid = st.stepMode ? st.focus : null;
      // the "does not fit" box at the top of the graph keeps the picture out from under it
      const bannerH = fitEl.current ? fitEl.current.offsetHeight + 8 : 0;
      scene.gatewayNote = fitEl.current && fitEl.current.dataset.state === "blocked" ? GATEWAY_NOTE : "";
      guideScene(scene, st, cw, ch, bannerH);
      scene.update(shown, events, dt, animating, cw, ch);
      scene.draw(ctx, shown, dpr);

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
      if (!calibrated && st.explain && !st.stepMode && st.tour === null && events.length) {
        let next: Shown[] | null = null;
        // a restart and the scale-up it causes happen in the same frame and share the router's node; the restart note is the one that explains, so it is not replaced
        const restarted = events.some((e) => e.kind === "fleet.restart");
        for (const c of events.flatMap((e) => calloutFor(e, world))) {
          if (c.target.type === "gateway" && c.key !== "restart" && (restarted || st.callouts.some((x) => x.key === "restart" && scene.vt - x.born < RESTART_HOLD_S))) continue;
          // one box per kind of event at a time, however many pods it happens on
          const family = c.key.replace(/\d+$/, "");
          if (c.once && st.seen.has(c.key)) continue;
          if (!c.once && scene.vt - (st.lastShown.get(family) ?? -99) < (c.every ?? 2.5)) continue;
          st.seen.add(c.key);
          st.lastShown.set(family, scene.vt);
          // a new box joins the stack and pushes the older ones away; only a newer version of the same note replaces it
          next = (next ?? [...st.callouts]).filter((x) => x.key !== c.key);
          next.push({ ...c, id: st.nextId++, born: scene.vt, created: scene.vt, waiting: true, simT: elapsed(world) });
        }
        if (next) {
          // past the most the screen holds, the oldest leaves early
          const kept = next.slice(-MAX_CALLOUTS);
          for (const c of st.callouts) if (!kept.includes(c)) st.toLog(c, "callout", true);
          st.callouts = kept;
          setCallouts(st.callouts);
        }
      }
      const stretch = noteStretch(st.speed);
      const ttl = CALLOUT_TTL * stretch;
      if (st.callouts.some((c) => scene.vt - c.born > ttl)) {
        for (const c of st.callouts) if (scene.vt - c.born > ttl) st.toLog(c, "callout", true);
        st.callouts = st.callouts.filter((c) => scene.vt - c.born <= ttl);
        setCallouts(st.callouts);
      }
      const stale = st.callouts.filter((c) => c.waiting && !c.once && scene.vt - (c.created ?? scene.vt) > STALE_S * stretch);
      if (stale.length) {
        for (const c of stale) st.toLog(c, "callout", false);
        st.callouts = st.callouts.filter((c) => !stale.includes(c));
        setCallouts(st.callouts);
      }
      const squeezed = placeCallouts(st.callouts, world, cw, ch, bannerH, stretch);
      if (squeezed) {
        st.toLog(squeezed, "callout", true);
        st.callouts = st.callouts.filter((c) => c !== squeezed);
        setCallouts(st.callouts);
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
    // two fingers on a touch screen: pinch to zoom around their midpoint, move them together to pan
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { d0: number; s0: number; anchor: { x: number; y: number } } | null = null;
    const local = (x: number, y: number) => {
      const r = canvas.getBoundingClientRect();
      return { x: x - r.left, y: y - r.top };
    };
    const pinchState = () => {
      const [a, b] = [...touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
      return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: local((a.x + b.x) / 2, (a.y + b.y) / 2) };
    };
    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      if (e.pointerType === "touch") {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          const { d, mid } = pinchState();
          scene.takeOver();
          pinch = { d0: d, s0: scene.cam.s, anchor: scene.toWorld(mid.x, mid.y) };
          drag = null;
          return;
        }
        if (touches.size > 2) return;
      }
      drag = { x: e.clientX, y: e.clientY, moved: false };
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === "touch" && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size >= 2) {
        const { d, mid } = pinchState();
        scene.cam.s = Math.max(0.1, Math.min(3, (pinch.s0 * d) / pinch.d0));
        const now = scene.toWorld(mid.x, mid.y);
        scene.cam.x += pinch.anchor.x - now.x;
        scene.cam.y += pinch.anchor.y - now.y;
        return;
      }
      if (!drag) {
        if (e.pointerType === "touch") return;
        const seg = scene.segmentAt(runRef.current.world, e.offsetX, e.offsetY);
        setTip((cur) => (seg ? { x: e.offsetX, y: e.offsetY, part: seg.part, bytes: seg.bytes } : cur ? null : cur));
        canvas.style.cursor = scene.hit(runRef.current.world, e.offsetX, e.offsetY) ? "pointer" : "grab";
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
      touches.delete(e.pointerId);
      if (pinch) {
        // the gesture ends when a finger lifts; the other finger does not start a drag or a click
        if (touches.size < 2) pinch = null;
        drag = null;
        return;
      }
      if (drag && !drag.moved) {
        const t = scene.hit(runRef.current.world, e.offsetX, e.offsetY);
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
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
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
    // follow a request from its first step: the next one to arrive, never one already on its way, whose earlier
    // steps the walkthrough would have missed
    st.focus = null;
    st.callouts = [];
    st.hist = [];
    st.replay = null;
    st.hi = -1;
    st.dirty = false;
    setCallouts([]);
    setHeld(null);
    setFocus(st.focus);
    setStepMode(st.stepMode);
    if (st.stepMode) {
      setPlaying(true);
      sendIfNone();
    }
  };
  /** The walkthrough waits for the next request; if none is on its way, it sends one. */
  const sendIfNone = () => {
    const w = worldRef.current;
    if (!w.pending.length) spawnBurst(w, 1);
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
      sendIfNone();
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
    if (live.current.stepMode) send(1);
    else toggleStep();
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
    // the tour runs faster to have something to show; the visitor's own exploring starts at the default speed
    setSpeed(EXPLORE_SPEED);
    try {
      localStorage.setItem("lv-tour-seen", "1");
    } catch {
      /* private mode: the tour simply shows again next visit */
    }
  };
  /** Start (or restart) a BLIS replay: the graph is cleared at once and the file is fetched; the clock starts when it has arrived. */
  const startReplay = (id: ReplayId) => {
    const token = ++loadToken.current;
    const scene = sceneRef.current;
    runRef.current = blankRun();
    scene.reset("aggregate");
    scene.aggregateNote = AGGREGATE_NOTE;
    scene.selected = null;
    setSelected(null);
    setCal({ id, status: "loading", file: null, error: "" });
    loadReplay(id)
      .then((file) => {
        if (token !== loadToken.current) return;
        runRef.current = new ReplayRun(file);
        scene.reset("aggregate");
        scene.aggregateNote = AGGREGATE_NOTE;
        setCal({ id, status: "ready", file, error: "" });
        setPlaying(true);
      })
      .catch((e: unknown) => {
        if (token === loadToken.current) setCal({ id, status: "failed", file: null, error: e instanceof Error ? e.message : String(e) });
      });
  };

  /** Switching mode restarts the animation: a fresh model for Explore, the scenario from its first second for Calibrated. */
  const switchMode = (m: Mode) => {
    const st = live.current;
    if (m === mode) return;
    if (st.stepMode) toggleStep();
    st.finish();
    setTour(null);
    st.callouts = [];
    setCallouts([]);
    setMode(m);
    if (m === "calibrated") {
      setSpeed(REPLAY_SPEED);
      startReplay(cal.id);
    } else {
      loadToken.current++;
      sceneRef.current.reset("blocks");
      runRef.current = exploreRef.current;
      reset();
      setSpeed(EXPLORE_SPEED);
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

  const toggleLog = (open: boolean) => {
    setLogOpen(open);
    if (open) setLogUnread(false);
  };
  const openMore = () => {
    if (more) return setMore(null);
    const r = moreBtn.current!.getBoundingClientRect();
    setMore({ left: Math.max(8, Math.min(window.innerWidth - 248, r.right - 240)), bottom: window.innerHeight - r.top + 8 });
  };
  /** Run a menu item and close the menu. */
  const pick = (f: () => void) => {
    setMore(null);
    f();
  };
  // a click outside the menu closes it
  useEffect(() => {
    if (!more) return;
    const close = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest(".lv-more-menu") && !moreBtn.current?.contains(t)) setMore(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [more]);
  // each step of the step-through goes into the history when it is first shown
  useEffect(() => {
    if (held) toLog({ ...held, no: histPos[0] + 1 }, "step", false);
  }, [held, histPos, toLog]);

  const select = (t: Target | null) => {
    sceneRef.current.selected = t;
    setSelected(t);
  };

  // The tutorial hides the menus except on the step that is about them; on a narrow screen the
  // step-through box takes the place of the left menu, which is a sheet at the bottom there.
  const tourTarget = tour !== null ? TOUR[tour]!.target : undefined;
  const narrow = window.innerWidth < NARROW_PX;
  const showLeft = panels && tour === null && !(stepMode && narrow);
  const showRight = tour !== null ? !!tourTarget && "el" in tourTarget && tourTarget.el === "right" : panels;

  const fit = calibrated ? null : fitOf(p as Params);
  const fixKey = `${p.model}|${p.gpu}|${p.precision}|${p.tp}|${p.gpuMemUtil}|${p.promptTokens}|${p.outputTokens}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fixes = useMemo(() => (calibrated || !fit || fit.fits && !fit.tight ? [] : fixesFor(p as Params)), [calibrated, fixKey]);
  const spec = calibrated ? null : replicaSpec(p as Params);
  const applyFix = (f: Fix) => {
    for (const [k, v] of Object.entries(f.changes)) set(k as keyof Params, v as never);
  };
  const nofit = (changes: Partial<Params>) => !calibrated && !fitsWith(p as Params, changes);
  const anyNoFit = [...Object.keys(MODELS).map((model) => ({ model })), ...Object.keys(GPUS).map((gpu) => ({ gpu })), ...(["bf16", "fp8"] as const).map((precision) => ({ precision })), ...[1, 2, 4, 8].map((tp) => ({ tp }))].some(nofit);
  const live_ = livePods(w);
  const hit = w.m.promptTokens ? w.m.cachedTokens / w.m.promptTokens : 0;
  const empty = !calibrated && w.sessions.size === 0 && w.pods.length === 0 && w.pending.length === 0;
  const replay = calibrated && runRef.current instanceof ReplayRun ? runRef.current : null;
  const activePreset = PRESETS.find((x) => x.id === preset);
  const tiles: [string, string, string?][] = [
    ["in flight", String(w.reqs.size), w.gatewayQueue.length ? `${w.gatewayQueue.length} queued` : undefined],
    ["pods", String(live_.length), `${live_.length * p.tp} GPU${live_.length * p.tp === 1 ? "" : "s"}`],
    ["output", `${fmtInt(tokensPerSecond(w))} tok/s`],
    ["TTFT p50", w.m.ttft.length ? fmtMs(median(w.m.ttft)) : "–"],
    ["TPOT p50", w.m.tpot.length ? fmtMs(median(w.m.tpot)) : "–"],
    ["KV pool", `${(kvFill(w) * 100).toFixed(0)}%`, w.m.evictions ? `${w.m.evictions} evicted` : undefined],
    ["prefix hits", `${(hit * 100).toFixed(0)}%`, w.m.preemptions ? `${w.m.preemptions} preempted` : undefined],
    calibrated ? ["shed", String(w.m.failed), "at the router"] : ["cost", w.m.tokensOut ? `$${costPerMTok(w).toFixed(2)}/M` : "–", "output tokens"]
  ];

  // the menus, composed differently on a phone (one sheet) and a wide screen (two columns)
  const workloadGroups = (
 <>
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
  </>
  );
  const archPanel = (
        <section className="lv-panel">
          {calibrated && (
            <>
              <button className="lv-back" data-testid="mode-explore" onClick={() => switchMode("explore")}>
                ◂ Back to the approximate model
              </button>
              <Rich text={replayText("mode.calibrated")} className="lv-note" />
            </>
          )}
          <header>
            <h2>{calibrated ? "BLIS scenario" : "Serving architecture"}</h2>
          </header>
          {calibrated && <ScenarioPanel id={cal.id} file={cal.file} status={cal.status} error={cal.error} onPick={startReplay} />}
          {!calibrated && (
            <>
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
              <details className="lv-arch">
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
            </>
          )}
        </section>
  );
  const requestsPanel = (
    <>
        {!calibrated && (
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
          {!narrow && workloadGroups}
        </section>
        )}
    </>
  );
  const infraPanel = (
    <>
        {calibrated && (
          <section className="lv-panel">
            <header>
              <h2>Scenario settings</h2>
              <span className="lv-fixed">read-only</span>
            </header>
            {cal.file && <ReadOnlySettings file={cal.file} />}
          </section>
        )}
        {!calibrated && (
        <section className="lv-panel">
          <header>
            <h2>Infrastructure</h2>
            <span className="lv-live">changes apply live</span>
          </header>
          <Group title="Model and GPU">
            <Choice label="model" value={p.model} options={Object.values(MODELS).map((m) => [m.id, m.label])} nofit={(v) => nofit({ model: v })} onChange={(v) => set("model", v)} />
            <Choice label="precision" value={p.precision} options={[["bf16", "BF16"], ["fp8", "FP8"]]} nofit={(v) => nofit({ precision: v })} onChange={(v) => set("precision", v)} />
            <Choice label="GPU" value={p.gpu} options={Object.values(GPUS).map((g) => [g.id, g.label.replace(" SXM", "")])} nofit={(v) => nofit({ gpu: v })} onChange={(v) => set("gpu", v)} />
            <Choice label="GPUs per pod (tensor parallel)" value={p.tp} options={[[1, "1"], [2, "2"], [4, "4"], [8, "8"]]} nofit={(v) => nofit({ tp: v })} onChange={(v) => set("tp", v)} />
            <Slider label="gpu_memory_utilization" value={p.gpuMemUtil} min={0.3} max={0.98} step={0.01} fmt={(v) => v.toFixed(2)} onChange={(v) => set("gpuMemUtil", v)} />
            {anyNoFit && <Rich text={FIT_OPTION.note} className="lv-note" />}
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
        )}
    </>
  );
  const legendPanel = (
        <section className="lv-panel">
          <Group title="Legend">
            <div className="lv-legend">
              {(calibrated
                ? ([
                    [C.prefill, "prefill"],
                    [C.decode, "decode, output tokens"],
                    [C.weights, "weights in HBM"],
                    ["hsl(205 62% 60%)", "share of the KV pool in use"],
                    [C.evict, "preemption"]
                  ] as const)
                : ([
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
                  ] as const)
              ).map(([c, l]) => (
                <div key={l}>
                  <i className="lv-sw" style={{ background: c }} />
                  {l}
                </div>
              ))}
              <Rich text={calibrated ? replayText("legend") : panelText("legend.note")} className="lv-note" />
            </div>
          </Group>
        </section>
  );

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

      {fit && spec && (!fit.fits || fit.tight) && (
        <div ref={fitEl} className={`lv-fit ${fit.fits ? "tight" : "blocked"}`} data-testid="fit-banner" data-state={fit.fits ? "tight" : "blocked"} role={fit.fits ? "status" : "alert"}>
          <b>{panelFields(fit.fits ? "fit.tight" : "fit.blocked", { title: "title" }).title}</b>
          <span>
            <Rich
              inline
              text={
                fit.fits
                  ? panelFields("fit.tight", { body: "body" }, { tokens: fmtInt(Math.round(fit.poolTokens / 100) * 100), requests: fit.poolRequests.toFixed(1) }).body
                  : panelFields("fit.blocked", { body: "body" }, { model: spec.model.label, precision: spec.precision === "fp8" ? "FP8" : "BF16", need: fmtGB(fit.needBytes), usable: fmtGB(fit.usableBytes), gpu: spec.gpu.label, util: p.gpuMemUtil.toFixed(2) }).body
              }
            />
          </span>
          <div className="lv-fit-fixes">
            {fixes.map((f) => {
              const t = fixText(f);
              return (
                <button key={f.kind} data-testid={`fit-fix-${f.kind}`} onClick={() => applyFix(f)}>
                  {t.label}
                  <small>{t.pool}</small>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <svg className="lv-leaders" ref={leaderSvg} aria-hidden="true" />
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
              <i className="lv-callout-no" aria-hidden="true" />
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

      {calibrated && cal.file && <BlisBadge commit={cal.file.blis.commit} />}

      <div className="lv-hud" data-testid="hud" ref={hudRef}>
        {tiles.map(([k, v, sub]) => (
          <div key={k}>
            <span>{k}</span>
            <b>{v}</b>
            {sub && <i>{sub}</i>}
          </div>
        ))}
      </div>

      <div className="lv-col lv-left" ref={leftRef} hidden={!showLeft}>
        {narrow ? (
          // a phone has one sheet: what to run, then what it runs on, then requests; scenarios, sessions and the legend last
          <>
            {archPanel}
            {infraPanel}
            {requestsPanel}
            {!calibrated && <section className="lv-panel">{workloadGroups}</section>}
            {legendPanel}
          </>
        ) : (
          <>
            {archPanel}
            {requestsPanel}
          </>
        )}

        {selected && !calibrated && (
          <Inspector
            w={w}
            target={selected}
            onClose={() => select(null)}
          />
        )}
        {selected && replay && <ReplayInspector run={replay} target={selected} onClose={() => select(null)} />}
      </div>

      <div className="lv-col lv-right" ref={rightRef} hidden={!showRight} data-tour="right">
        {!narrow && infraPanel}
        {!narrow && legendPanel}
      </div>

      {!calibrated && !stepMode && tour === null && !(narrow && showLeft) && (
        <button
          className={`lv-notes-btn ${explain ? "on" : ""}`}
          data-testid="notes-toggle"
          aria-pressed={explain}
          aria-label={explain ? "Notes on: short notes next to what just happened. Turn off" : "Notes off. Turn on short notes next to what just happened"}
          title={explain ? "Notes on: short notes next to what just happened. Click to turn them off" : "Notes off. Click to show short notes next to what just happened"}
          onClick={() => setExplain(!explain)}
        >
          <NotesIcon off={!explain} />
          {!narrow && <span>{explain ? "Notes on" : "Notes off"}</span>}
        </button>
      )}

      <div className="lv-transport" data-tour="transport">
        <button className="lv-play" data-testid="play-toggle" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="lv-clock" data-testid="clock" title={replay?.finished ? replayText("finished") : undefined}>
          <b>{elapsed(w).toFixed(2)} s</b>
          <span data-testid="clock-mode" title="The clock slows while an explanation waits its turn, and fast-forwards a cold start with nothing else to watch. Both change the whole simulation alike.">{replay?.finished ? "replay finished" : calibrated ? "BLIS clock" : warpLabel(live.current.warp, narrow)}</span>
        </div>
        <button
          className={`lv-menus-btn ${panels ? "on" : ""}`}
          data-testid="toggle-panels"
          aria-pressed={panels}
          title={panels ? "Hide the menus" : "Open the menus: architectures, scenarios, models, GPUs and every engine setting"}
          onClick={() => setPanels(!panels)}
        >
          <span aria-hidden="true">{panels ? "✕" : "☰"}</span>
          {panels && !narrow ? "Hide menus" : "Menus"}
        </button>
        <div className="lv-speed">
          <span>slow motion</span>
          {narrow ? (
            <SpeedWheel speeds={calibrated ? REPLAY_SPEEDS : SPEEDS} value={speed} onChange={setSpeed} />
          ) : (
            <div className="lv-seg">
              {(calibrated ? REPLAY_SPEEDS : SPEEDS).map((s) => (
                <button key={s} className={s === speed ? "on" : ""} data-testid={`speed-${s}`} onClick={() => setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </div>
          )}
        </div>
        {!calibrated && (
          <>
        <button className={`lv-ghost ${stepMode ? "on" : ""}`} data-testid="step-toggle" onClick={toggleStep} title="Follow the next request from its first step and stop at each thing that happens to it; sends one if none is on its way">
          {narrow ? "steps" : "step-through"}
          {stepMode && !narrow ? (focus !== null ? ` · session ${focus}` : " · waiting for a request") : ""}
        </button>
          </>
        )}
        {!calibrated && <LogButton count={log.length} open={logOpen} unread={logUnread} buttonRef={logBtn} compact={narrow} onToggle={() => toggleLog(!logOpen)} />}
        {!narrow && (
          <button className="lv-ghost" data-testid="reset" onClick={() => (calibrated ? startReplay(cal.id) : reset())}>
            reset
          </button>
        )}
        <button ref={moreBtn} className={`lv-ghost ${more ? "on" : ""}`} data-testid="more" aria-haspopup="menu" aria-expanded={!!more} aria-label="More" onClick={openMore}>
          ⋯
        </button>
      </div>

      {more && (
        <div className="lv-more-menu" role="menu" data-testid="more-menu" style={{ left: more.left, bottom: more.bottom }}>
          {!calibrated && (
            <button role="menuitem" data-testid="tour-start" onClick={() => pick(startTour)}>
              Tutorial
              <small>a guided tour of the graph</small>
            </button>
          )}
          <button role="menuitem" onClick={() => pick(() => sceneRef.current.fitNow())}>
            Fit the graph to the screen
          </button>
          {narrow && (
            <button role="menuitem" data-testid="reset" onClick={() => pick(() => (calibrated ? startReplay(cal.id) : reset()))}>
              Reset
              <small>{calibrated ? "replay the scenario from the start" : "an empty graph with the default settings"}</small>
            </button>
          )}
          <hr />
          {calibrated ? (
            <button role="menuitem" data-testid="menu-explore" onClick={() => pick(() => switchMode("explore"))}>
              Back to the approximate model
              <small>change any setting while requests run</small>
            </button>
          ) : (
            <button role="menuitem" data-testid="mode-calibrated" onClick={() => pick(() => switchMode("calibrated"))}>
              Calibrated replay (BLIS)
              <small>recorded BLIS runs of fixed scenarios, read-only</small>
            </button>
          )}
        </div>
      )}

      {logOpen && !calibrated && (
        <LogPanel
          entries={log}
          onPick={(e) => e.target && select(e.target)}
          onClose={() => toggleLog(false)}
          onClear={() => {
            setLog([]);
            setLogUnread(false);
          }}
        />
      )}
    </div>
  );
}
