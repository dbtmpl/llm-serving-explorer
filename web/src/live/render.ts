/**
 * Canvas scene for the live view: one graph (sessions -> tokenizer -> router -> pods) that grows as
 * requests reach each stage. It only reads the World; it never changes simulation state.
 */
import { GPUS, ridge, fmtInt, weightBytes } from "./model.js";
import { CELLS, tierCapBlocks, type Pod, type Req, type Session, type SimEvent, type World } from "./sim.js";

export const C = {
  ink: "#0f172a",
  sub: "#475569",
  mute: "#94a3b8",
  line: "#e2e8f0",
  soft: "#f1f5f9",
  card: "#ffffff",
  prefill: "#eb6834",
  decode: "#2a78d6",
  dram: "#1baf7a",
  ssd: "#6250d6",
  remote: "#eda100",
  evict: "#e34948",
  weights: "#334155",
  ok: "#1baf7a"
};

export const PROMPTS = [
  "Summarise the attached incident report and list the three actions we should take first.",
  "Refactor this function so the retry loop uses exponential backoff with jitter.",
  "Why does decode stay memory-bound even when I double the batch size?",
  "Draft a polite reply declining the meeting and propose two other slots next week.",
  "Explain the difference between prefill and decode to a new engineer on the team.",
  "Given the schema above, write the SQL for monthly active users by region."
];

/** Display-only split into word pieces; the token count shown is the request's real L_in. */
export function pieces(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(" ")) {
    for (let i = 0; i < word.length; i += 5) out.push((i === 0 ? " " : "") + word.slice(i, i + 5));
  }
  return out;
}

export const hueOf = (sid: number) => (sid * 137.508) % 360;
export const sessionColor = (sid: number, l = 58, s = 68) => `hsl(${hueOf(sid).toFixed(0)} ${s}% ${l}%)`;

export type Target =
  | { type: "session"; id: number }
  | { type: "tokenizer" }
  | { type: "gateway" }
  | { type: "store" }
  | { type: "remote" }
  | { type: "stream" }
  | { type: "pod"; id: number; part: "engine" | "gpu" | "roofline" | "tiers" };

interface P {
  x: number;
  y: number;
}
interface Particle {
  pts: P[];
  t0: number;
  dur: number;
  color: string;
  size: number;
  fade?: boolean;
}

const TOK = { x: 70, y: -70, w: 230, h: 140 };
const GW = { x: 360, y: -58, w: 180, h: 116 };
const PODS_X = 610;
const STORE = { x: 90, y: -214, w: 190, h: 70 };
const REMOTE_H = 62;
export const PW = 360;
const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function bez(a: P, b: P, u: number, bend = 0): P {
  const dx = (b.x - a.x) * 0.5;
  const c1 = { x: a.x + dx, y: a.y + bend };
  const c2 = { x: b.x - dx, y: b.y + bend };
  const v = 1 - u;
  return {
    x: v * v * v * a.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * b.x,
    y: v * v * v * a.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * b.y
  };
}

interface PodGeom {
  h: number;
  gpus: { x: number; y: number; w: number; h: number }[];
  lanesY: number;
  stripY: number;
  gaugeY: number;
  tiersY: number;
}

export function podGeom(tp: number): PodGeom {
  const cols = tp >= 8 ? 4 : tp >= 2 ? 2 : 1;
  const rows = Math.ceil(tp / cols);
  const gh = rows > 1 ? 84 : 112;
  const gw = (PW - 28 - (cols - 1) * 8) / cols;
  const gy = 96;
  const gpus = Array.from({ length: tp }, (_, i) => ({ x: 14 + (i % cols) * (gw + 8), y: gy + Math.floor(i / cols) * (gh + 8), w: gw, h: gh }));
  const stripY = gy + rows * gh + (rows - 1) * 8 + 12;
  return { h: stripY + 110, gpus, lanesY: 40, stripY, gaugeY: stripY + 20, tiersY: stripY + 58 };
}

/** Horizontal split of one GPU's HBM into weights | activations | KV | headroom. */
function hbmSplit(pod: Pod, g: { x: number; y: number; w: number; h: number }) {
  const b = pod.budget;
  const x0 = g.x + 7;
  const w = g.w - 14;
  const y = g.y + 22;
  const h = g.h - 30;
  const kv = Math.max(0, b.kv);
  const total = b.weights + b.activations + kv + b.headroom;
  const ww = (w * b.weights) / total;
  const aw = Math.max(2, (w * b.activations) / total);
  const hw = (w * b.headroom) / total;
  const kw = Math.max(0, w - ww - aw - hw);
  const rows = Math.max(1, Math.round(Math.sqrt((CELLS * h) / Math.max(1, kw))));
  const cols = Math.ceil(CELLS / rows);
  return { x0, y, h, ww, aw, kw, hw, kx: x0 + ww + aw, rows, cols, cw: kw / cols, ch: h / rows };
}

export class Scene {
  cam = { x: 150, y: 0, s: 1 };
  auto = true;
  /** screen-space boxes of the floating panels (top-left and top-right), so the graph can avoid them */
  panels = { lw: 300, lh: 200, rw: 316, rh: 300, bottom: 96 };
  /** extra room kept free above the graph (the tutorial card sits there) */
  topPad = 0;
  vt = 0;
  selected: Target | null = null;
  private w = 1;
  private h = 1;
  private podPos = new Map<number, { x: number; y: number; a: number; i: number }>();
  private sessPos = new Map<number, P & { a: number }>();
  private cellA = new Map<number, { a: Float32Array; owner: Int32Array }>();
  private parts: Particle[] = [];
  private reveal = { tok: 0, gw: 0, tokA: 0, gwA: 0 };
  private lastTok: { text: string; lIn: number; fresh: number; sid: number } | null = null;
  private cardMode = true;
  private flashes: { podId: number; cells: number[]; t0: number }[] = [];
  /** step-through mode: everything not about this session is dimmed */
  focusSid: number | null = null;
  private dotR = 9;
  private remote = { x: PODS_X, y: 260, a: 0, seen: false };
  private storeA = 0;

  /* ---------------------------------------------------------------- geometry */

  toScreen(p: P): P {
    return { x: (p.x - this.cam.x) * this.cam.s + this.w / 2, y: (p.y - this.cam.y) * this.cam.s + this.h / 2 };
  }
  toWorld(x: number, y: number): P {
    return { x: (x - this.w / 2) / this.cam.s + this.cam.x, y: (y - this.h / 2) / this.cam.s + this.cam.y };
  }
  private podRect(pod: Pod) {
    const p = this.podPos.get(pod.id);
    return p ? { x: p.x, y: p.y, w: PW, h: podGeom(pod.spec.tp).h } : null;
  }
  private sessAnchor(sid: number): P {
    const p = this.sessPos.get(sid);
    return p ? { x: p.x + (this.cardMode ? 0 : this.dotR + 3), y: p.y } : { x: 0, y: 0 };
  }
  private cellPos(pod: Pod, cell: number, gpu = 0): P {
    const r = this.podRect(pod)!;
    const g = podGeom(pod.spec.tp).gpus[gpu]!;
    const s = hbmSplit(pod, g);
    return { x: r.x + s.kx + (Math.floor(cell / s.rows) + 0.5) * s.cw, y: r.y + s.y + ((cell % s.rows) + 0.5) * s.ch };
  }
  private tierPos(pod: Pod | undefined, tier: "dram" | "ssd" | "remote", frac = 0.5): P {
    if (tier === "remote" || !pod) return { x: this.remote.x + 62 + (PW - 150) * frac, y: this.remote.y + 40 };
    const r = this.podRect(pod)!;
    const g = podGeom(pod.spec.tp);
    return { x: r.x + 62 + (PW - 150) * frac, y: r.y + g.tiersY + (tier === "dram" ? 8 : 30) };
  }

  /** World point a callout or the inspector should point at. */
  anchor(w: World, t: Target): P | null {
    if (t.type === "tokenizer") return this.reveal.tokA > 0.5 ? { x: TOK.x + TOK.w / 2, y: TOK.y + TOK.h } : null;
    if (t.type === "gateway") return this.reveal.gwA > 0.5 ? { x: GW.x + GW.w / 2, y: GW.y - 30 } : null;
    if (t.type === "store") return this.storeA > 0.5 ? { x: STORE.x + STORE.w / 2, y: STORE.y } : null;
    if (t.type === "remote") return this.remote.a > 0.5 ? { x: this.remote.x + PW / 2, y: this.remote.y } : null;
    if (t.type === "stream") return this.reveal.gwA > 0.5 ? { x: GW.x + GW.w / 2 - 60, y: GW.y + GW.h + 60 } : null;
    if (t.type === "session") {
      const p = this.sessPos.get(t.id);
      if (!p) return null;
      if (this.cardMode) return { x: p.x - 85, y: p.y - 20 };
      if (this.sessPos.size > 400) return { x: p.x, y: p.y - this.dotR - 6 };
      let top = p.y;
      for (const q of this.sessPos.values()) top = Math.min(top, q.y);
      return { x: p.x, y: top - 40 };
    }
    const pod = w.pods.find((x) => x.id === t.id);
    const r = pod && this.podRect(pod);
    if (!pod || !r) return null;
    return { x: r.x + PW / 2, y: r.y };
  }

  /** Like anchor(), but for a pod it points at the named part instead of the pod's top edge (used by the tutorial). */
  anchorPart(w: World, t: Target): P | null {
    const top = this.anchor(w, t);
    if (!top || t.type !== "pod") return top;
    const pod = w.pods.find((x) => x.id === t.id)!;
    const g = podGeom(pod.spec.tp);
    const dy = t.part === "tiers" ? g.tiersY + 20 : t.part === "roofline" ? g.gaugeY + 17 : t.part === "gpu" ? g.gpus[0]!.y + g.gpus[0]!.h / 2 : g.lanesY + 28;
    return { x: top.x - (t.part === "gpu" ? 0 : PW / 2 - 30), y: top.y + dy };
  }

  hit(w: World, sx: number, sy: number): Target | null {
    const p = this.toWorld(sx, sy);
    const inside = (r: { x: number; y: number; w: number; h: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    for (const pod of w.pods) {
      const r = this.podRect(pod);
      if (!r || !inside(r)) continue;
      const g = podGeom(pod.spec.tp);
      const ly = p.y - r.y;
      const part = ly > g.tiersY - 6 ? "tiers" : ly > g.stripY - 6 ? "roofline" : ly > 90 ? "gpu" : "engine";
      return { type: "pod", id: pod.id, part };
    }
    if (this.reveal.tokA > 0.5 && inside(TOK)) return { type: "tokenizer" };
    if (this.reveal.gwA > 0.5 && inside(GW)) return { type: "gateway" };
    if (this.storeA > 0.5 && inside(STORE)) return { type: "store" };
    if (this.remote.a > 0.5 && inside({ x: this.remote.x, y: this.remote.y, w: PW, h: REMOTE_H })) return { type: "remote" };
    for (const [id, s] of this.sessPos) {
      const hit = this.cardMode ? p.x >= s.x - 170 && p.x <= s.x && Math.abs(p.y - s.y) < 18 : Math.hypot(p.x - s.x, p.y - s.y) < this.dotR + 4;
      if (hit) return { type: "session", id };
    }
    return null;
  }

  /* ---------------------------------------------------------------- update */

  private layout(w: World, k: number): void {
    const sessions = [...w.sessions.values()];
    const n = sessions.length;
    this.cardMode = n <= 8;
    const rows = this.cardMode ? n : Math.min(n, Math.max(8, Math.ceil(Math.sqrt(n * 1.6))));
    const pitch = this.cardMode ? 46 : n > 3000 ? 7 : n > 400 ? 13 : 30;
    this.dotR = n > 3000 ? 2.6 : n > 400 ? 5 : 9;
    sessions.forEach((s, i) => {
      const col = Math.floor(i / Math.max(1, rows));
      const inCol = Math.min(rows, n - col * rows);
      const tx = this.cardMode ? 0 : -this.dotR - 5 - col * pitch;
      const ty = ((i % Math.max(1, rows)) - (inCol - 1) / 2) * pitch;
      const cur = this.sessPos.get(s.id);
      if (!cur) this.sessPos.set(s.id, { x: tx, y: ty, a: 0 });
      else {
        cur.x += (tx - cur.x) * k;
        cur.y += (ty - cur.y) * k;
        cur.a += (1 - cur.a) * k;
      }
    });
    for (const id of this.sessPos.keys()) if (!w.sessions.has(id)) this.sessPos.delete(id);

    const slots = w.pods.reduce((m, p) => Math.max(m, p.slot + 1), 0);
    const cols = slots <= 2 ? 1 : Math.ceil(Math.sqrt(slots));
    const rowsP = Math.ceil(slots / cols);
    const ph = w.pods.reduce((m, p) => Math.max(m, podGeom(p.spec.tp).h), 0);
    for (const pod of w.pods) {
      const tx = PODS_X + (pod.slot % cols) * (PW + 44);
      const ty = (Math.floor(pod.slot / cols) - (rowsP - 1) / 2) * (ph + 80) - ph / 2;
      const cur = this.podPos.get(pod.id);
      const alive = pod.state !== "terminated" && pod.state !== "draining";
      if (!cur) this.podPos.set(pod.id, { x: tx, y: ty, a: 0, i: 1 });
      else {
        cur.x += (tx - cur.x) * k;
        cur.y += (ty - cur.y) * k;
        cur.a += ((alive ? 1 : 0.15) - cur.a) * k;
        const target = pod.last ? Math.log10(Math.max(0.5, pod.last.intensity)) : 0;
        cur.i += (target - cur.i) * k;
      }
      let ca = this.cellA.get(pod.id);
      if (!ca) this.cellA.set(pod.id, (ca = { a: new Float32Array(CELLS), owner: new Int32Array(CELLS) }));
      for (let c = 0; c < CELLS; c++) {
        const o = pod.cells[c]!;
        if (o) ca.owner[c] = o;
        ca.a[c]! += ((o ? 1 : 0) - ca.a[c]!) * Math.min(1, k * 1.6);
      }
    }
    let bottom = 200;
    for (const pod of w.pods) {
      const pp = this.podPos.get(pod.id)!;
      bottom = Math.max(bottom, pp.y + podGeom(pod.spec.tp).h + 50);
    }
    if (w.remote.size) this.remote.seen = true;
    if (!w.sessions.size && !w.pods.length) this.remote.seen = false;
    this.remote.y += (bottom - this.remote.y) * k;
    this.remote.a += ((this.remote.seen ? 1 : 0) - this.remote.a) * k;
    this.storeA += ((w.seen.tokenizer ? 1 : 0) - this.storeA) * k;
    for (const id of this.podPos.keys()) {
      if (!w.pods.some((p) => p.id === id)) {
        this.podPos.delete(id);
        this.cellA.delete(id);
      }
    }
  }

  private fit(w: World, k: number): void {
    if (!this.auto) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const add = (x: number, y: number, bw: number, bh: number) => {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + bw);
      y1 = Math.max(y1, y + bh);
    };
    for (const p of this.sessPos.values()) add(p.x - (this.cardMode ? 172 : this.dotR + 4), p.y - this.dotR - 10, this.cardMode ? 172 : 2 * this.dotR + 8, 2 * this.dotR + 20);
    if (w.sessions.size) add(TOK.x, TOK.y, TOK.w, TOK.h);
    if (w.seen.tokenizer) add(STORE.x, STORE.y - 30, STORE.w, STORE.h);
    if (this.remote.seen) add(this.remote.x, this.remote.y, PW, REMOTE_H);
    if (w.seen.tokenizer) add(GW.x, GW.y - 40, GW.w, GW.h + 40);
    for (const pod of w.pods) {
      const r = this.podRect(pod);
      if (r) add(r.x, r.y - 64, r.w, r.h + 64);
    }
    if (x0 === Infinity) add(-120, -80, 400, 160);
    // two ways to avoid the corner panels: sit between them, or sit below them; take the larger
    const pn = this.panels;
    const options = [
      { l: pn.lw + 24, r: pn.rw + 24, t: 84 + this.topPad, b: pn.bottom },
      { l: 24, r: 24, t: Math.max(84, pn.lh + 20, pn.rh + 20) + this.topPad, b: pn.bottom }
    ];
    const scaleOf = (o: (typeof options)[number]) => Math.min(Math.max(120, this.w - o.l - o.r) / (x1 - x0 + 60), Math.max(120, this.h - o.t - o.b) / (y1 - y0 + 60));
    const i = scaleOf(options[0]!) >= scaleOf(options[1]!) ? options[0]! : options[1]!;
    const s = clamp(scaleOf(i), 0.12, 1.25);
    const cx = (x0 + x1) / 2 - (i.l - i.r) / 2 / s;
    const cy = (y0 + y1) / 2 - (i.t - i.b) / 2 / s;
    const kk = k * 0.5;
    this.cam.s += (s - this.cam.s) * kk;
    this.cam.x += (cx - this.cam.x) * kk;
    this.cam.y += (cy - this.cam.y) * kk;
  }

  private spawn(a: P, b: P, color: string, o: { dur?: number; size?: number; bend?: number; delay?: number; fade?: boolean } = {}): void {
    if (this.parts.length > 900) return;
    const pts: P[] = [];
    for (let i = 0; i <= 12; i++) pts.push(bez(a, b, i / 12, o.bend ?? 0));
    this.parts.push({ pts, t0: this.vt + (o.delay ?? 0), dur: o.dur ?? 1, color, size: o.size ?? 4, fade: o.fade });
  }

  private consume(w: World, events: SimEvent[]): void {
    for (const e of events) {
      const pod = e.podId !== undefined ? w.pods.find((p) => p.id === e.podId) : undefined;
      const r = pod && this.podRect(pod);
      if (e.kind === "req.tokenized") {
        const req = w.reqs.get(e.reqId!);
        this.lastTok = { text: PROMPTS[(req?.promptIdx ?? 0) % PROMPTS.length]!, lIn: e.lIn as number, fresh: e.newTokens as number, sid: e.sid! };
      } else if (e.kind === "step.tokens" && pod && r) {
        const sids = this.focusSid ? (e.sids as number[]).filter((x) => x === this.focusSid) : (e.sids as number[]);
        const stride = Math.max(1, Math.ceil(sids.length / 6));
        for (let i = 0; i < sids.length; i += stride) {
          const sid = sids[i]!;
          const from = { x: r.x, y: r.y + 70 };
          const mid = { x: GW.x + GW.w / 2, y: GW.y + GW.h + 6 };
          this.spawn(from, mid, C.decode, { dur: 0.7, size: 3.5, bend: 30, delay: i * 0.02 });
          if (this.sessPos.has(sid)) this.spawn(mid, this.sessAnchor(sid), C.decode, { dur: 1.0, size: 3.5, bend: 110, delay: 0.7 + i * 0.02 });
        }
      } else if ((e.kind === "kv.move" || e.kind === "kv.drop" || e.kind === "req.preempted") && pod && r) {
        const cells = (e.cells as number[]) ?? [];
        const to = e.kind === "kv.move" ? (e.to as "dram" | "ssd" | "remote") : null;
        const color = e.kind === "kv.move" ? (to === "dram" ? C.dram : to === "ssd" ? C.ssd : C.remote) : C.evict;
        if (to === "remote") this.remote.seen = true;
        if (cells.length) {
          this.flashes.push({ podId: pod.id, cells, t0: this.vt });
          cells.slice(0, 14).forEach((c, i) => {
            const a = this.cellPos(pod, c);
            const b = to ? this.tierPos(pod, to, 0.1 + 0.8 * ((i * 0.37) % 1)) : e.kind === "req.preempted" ? { x: r.x + 20, y: r.y + 62 } : { x: a.x + 30, y: a.y + 90 };
            this.spawn(a, b, color, { dur: 1.3, size: 5, delay: i * 0.05, fade: !to });
          });
        } else if (e.from === "dram" || e.from === "ssd") {
          for (let i = 0; i < 6; i++) {
            const a = this.tierPos(pod, e.from, 0.15 + 0.12 * i);
            const b = to ? this.tierPos(pod, to, 0.15 + 0.12 * i) : { x: a.x, y: a.y + 60 };
            this.spawn(a, b, color, { dur: 1.1, size: 5, delay: i * 0.06, fade: !to });
          }
        }
      } else if (e.kind === "kv.reload" && pod) {
        const from = e.from as "dram" | "ssd" | "remote";
        (e.cells as number[]).slice(0, 14).forEach((c, i) => {
          this.spawn(this.tierPos(pod, from, 0.1 + 0.8 * ((i * 0.37) % 1)), this.cellPos(pod, c), from === "dram" ? C.dram : from === "ssd" ? C.ssd : C.remote, { dur: 1.3, size: 5, delay: i * 0.05 });
        });
      } else if (e.kind === "store.read" && this.parts.length < 300) {
        for (let i = 0; i < 3; i++) this.spawn({ x: STORE.x + STORE.w / 2, y: STORE.y + STORE.h }, { x: TOK.x + TOK.w / 2, y: TOK.y }, C.sub, { dur: 0.8, size: 4, delay: i * 0.08 });
      } else if (e.kind === "store.append" && this.parts.length < 300) {
        for (let i = 0; i < 2; i++) this.spawn({ x: GW.x + 20, y: GW.y }, { x: STORE.x + STORE.w, y: STORE.y + STORE.h / 2 }, C.sub, { dur: 1.0, size: 4, delay: 0.5 + i * 0.08, bend: -40 });
      }
    }
  }

  update(w: World, events: SimEvent[], dtWall: number, playing: boolean, width: number, height: number): void {
    this.w = width;
    this.h = height;
    if (playing) this.vt += dtWall;
    const k = 1 - Math.exp(-dtWall * 7);
    this.layout(w, k);
    this.consume(w, events);
    this.fit(w, 1 - Math.exp(-dtWall * 4));
    const up = (cur: number, on: boolean) => cur + ((on ? 1 : 0) - cur) * k;
    this.reveal.tokA = up(this.reveal.tokA, w.seen.tokenizer);
    this.reveal.gwA = up(this.reveal.gwA, w.seen.gateway);
    for (const r of w.reqs.values()) {
      const u = r.stageEnd > r.stageStart ? clamp((w.t - r.stageStart) / (r.stageEnd - r.stageStart), 0, 1) : 1;
      if (r.stage === "send") this.reveal.tok = Math.max(this.reveal.tok, u);
      else {
        this.reveal.tok = 1;
        if (r.stage === "toGateway") this.reveal.gw = Math.max(this.reveal.gw, u);
        else if (r.stage !== "tokenize") this.reveal.gw = 1;
      }
    }
    if (!w.sessions.size && !w.pods.length) this.reveal = { tok: 0, gw: 0, tokA: 0, gwA: 0 };
    this.parts = this.parts.filter((p) => this.vt < p.t0 + p.dur);
    this.flashes = this.flashes.filter((f) => this.vt < f.t0 + 1.2);
  }

  /* ---------------------------------------------------------------- draw */

  draw(ctx: CanvasRenderingContext2D, w: World, dpr: number): void {
    const { s } = this.cam;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.w, this.h);
    this.grid(ctx);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (this.w / 2 - this.cam.x * s), dpr * (this.h / 2 - this.cam.y * s));
    const lod = s > 0.5 ? 2 : s > 0.28 ? 1 : 0;

    this.edges(ctx, w);
    this.sessions(ctx, w, lod);
    if (this.reveal.tokA > 0.01) this.tokenizer(ctx, w);
    if (this.reveal.gwA > 0.01) this.gateway(ctx, w);
    if (this.storeA > 0.01) this.storeNode(ctx, w);
    if (this.remote.a > 0.01) this.remoteNode(ctx, w);
    for (const pod of w.pods) this.pod(ctx, w, pod, lod);
    this.transit(ctx, w, lod);
    this.particles(ctx);
    ctx.globalAlpha = 1;
  }

  private grid(ctx: CanvasRenderingContext2D): void {
    let step = 32;
    while (step * this.cam.s < 22) step *= 2;
    const a = this.toWorld(0, 0);
    const b = this.toWorld(this.w, this.h);
    ctx.lineWidth = 1;
    for (let gx = Math.floor(a.x / step) * step; gx < b.x; gx += step) {
      const x = Math.round(this.toScreen({ x: gx, y: 0 }).x) + 0.5;
      ctx.strokeStyle = Math.round(gx / step) % 4 === 0 ? "rgba(15,23,42,0.065)" : "rgba(15,23,42,0.032)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.h);
      ctx.stroke();
    }
    for (let gy = Math.floor(a.y / step) * step; gy < b.y; gy += step) {
      const y = Math.round(this.toScreen({ x: 0, y: gy }).y) + 0.5;
      ctx.strokeStyle = Math.round(gy / step) % 4 === 0 ? "rgba(15,23,42,0.065)" : "rgba(15,23,42,0.032)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.w, y);
      ctx.stroke();
    }
  }

  private curve(ctx: CanvasRenderingContext2D, a: P, b: P, upTo = 1, bend = 0): void {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    const n = 24;
    for (let i = 1; i <= Math.round(n * upTo); i++) {
      const p = bez(a, b, i / n, bend);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  private edges(ctx: CanvasRenderingContext2D, w: World): void {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#cbd5e1";
    ctx.lineCap = "round";
    const tokL = { x: TOK.x, y: TOK.y + TOK.h / 2 };
    const many = this.sessPos.size > 24;
    if (this.sessPos.size > 300) {
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const p of this.sessPos.values()) {
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
      }
      ctx.globalAlpha = 0.7;
      for (const y of [y0, (y0 + y1) / 2, y1]) this.curve(ctx, { x: 0, y }, tokL, this.reveal.tok);
    } else
    for (const [sid, p] of this.sessPos) {
      const sess = w.sessions.get(sid);
      const live = sess?.reqId != null;
      if (many && !live) continue;
      ctx.globalAlpha = p.a * (live ? 0.9 : 0.35);
      this.curve(ctx, this.sessAnchor(sid), tokL, this.reveal.tok);
    }
    ctx.globalAlpha = 1;
    if (this.reveal.gw > 0) this.curve(ctx, { x: TOK.x + TOK.w, y: 0 }, { x: GW.x, y: 0 }, this.reveal.gw);
    if (this.storeA > 0.01) {
      ctx.globalAlpha = this.storeA;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(STORE.x + STORE.w / 2, STORE.y + STORE.h);
      ctx.lineTo(TOK.x + TOK.w / 2, TOK.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    for (const pod of w.pods) {
      const r = this.podRect(pod);
      const pp = this.podPos.get(pod.id);
      if (!r || !pp) continue;
      ctx.globalAlpha = pp.a;
      if (pod.state !== "ready") ctx.setLineDash([4, 5]);
      this.curve(ctx, { x: GW.x + GW.w, y: 0 }, { x: r.x, y: r.y + 54 }, ease(pp.a * 1.2));
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  private box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 14, selected = false): void {
    ctx.save();
    ctx.shadowColor = "rgba(15,23,42,0.10)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = C.card;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? C.decode : C.line;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.stroke();
  }

  private text(ctx: CanvasRenderingContext2D, str: string, x: number, y: number, o: { size?: number; weight?: number; color?: string; align?: CanvasTextAlign; mono?: boolean } = {}): void {
    ctx.font = `${o.weight ?? 400} ${o.size ?? 11}px ${o.mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif"}`;
    ctx.fillStyle = o.color ?? C.sub;
    ctx.textAlign = o.align ?? "left";
    ctx.fillText(str, x, y);
  }

  private sessions(ctx: CanvasRenderingContext2D, w: World, lod: number): void {
    for (const [sid, p] of this.sessPos) {
      const sess = w.sessions.get(sid)!;
      const req = sess.reqId != null ? w.reqs.get(sess.reqId) : undefined;
      const sel = this.selected?.type === "session" && this.selected.id === sid;
      const dim = this.focusSid && this.focusSid !== sid ? 0.22 : 1;
      p.a = Math.min(p.a, 1) ;
      ctx.globalAlpha = p.a * dim;
      if (this.dotR < 4) {
        ctx.fillStyle = sess.state === "idle" ? sessionColor(sid, 88, 35) : sess.state === "thinking" ? sessionColor(sid, 80, 55) : sessionColor(sid);
        ctx.fillRect(p.x - this.dotR, p.y - this.dotR, 2 * this.dotR, 2 * this.dotR);
        continue;
      }
      const col = sessionColor(sid);
      if (this.cardMode) {
        const x = p.x - 170;
        this.box(ctx, x, p.y - 17, 170, 34, 10, sel);
        ctx.fillStyle = col;
        ctx.globalAlpha = p.a * (sess.state === "idle" ? 0.35 : 1);
        ctx.beginPath();
        ctx.arc(x + 17, p.y, 6, 0, 7);
        ctx.fill();
        ctx.globalAlpha = p.a;
        this.text(ctx, `session ${sid}`, x + 30, p.y - 2, { size: 11, weight: 600, color: C.ink });
        this.text(ctx, sessionStatus(sess, req), x + 30, p.y + 11, { size: 9.5, color: C.mute });
        if (req && req.out > 0) {
          ctx.fillStyle = C.soft;
          ctx.fillRect(x + 118, p.y - 2, 42, 4);
          ctx.fillStyle = C.decode;
          ctx.fillRect(x + 118, p.y - 2, (42 * req.out) / req.lOut, 4);
        }
      } else {
        const r = this.dotR;
        if (sess.state === "idle") {
          ctx.fillStyle = sessionColor(sid, 88, 35);
        } else if (sess.state === "thinking") {
          ctx.fillStyle = sessionColor(sid, 80, 55);
        } else ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, 7);
        ctx.fill();
        if (req && req.out > 0) {
          ctx.strokeStyle = C.decode;
          ctx.lineWidth = r > 6 ? 2.5 : 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + (r > 6 ? 3 : 1.5), -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * req.out) / req.lOut);
          ctx.stroke();
        }
        if (sel) {
          ctx.strokeStyle = C.ink;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 6, 0, 7);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    if (this.sessPos.size && lod > 0) {
      let top = Infinity;
      let left = Infinity;
      for (const p of this.sessPos.values()) {
        top = Math.min(top, p.y);
        left = Math.min(left, p.x);
      }
      const big = Math.max(11, Math.min(60, 9 / this.cam.s));
      this.text(ctx, `${fmtInt(this.sessPos.size)} session${this.sessPos.size > 1 ? "s" : ""}`, this.cardMode ? -170 : left - 10, top - 18 - big, { size: big, weight: 600, color: C.sub });
    }
  }

  private tokenizer(ctx: CanvasRenderingContext2D, w: World): void {
    ctx.globalAlpha = this.reveal.tokA;
    this.box(ctx, TOK.x, TOK.y, TOK.w, TOK.h, 14, this.selected?.type === "tokenizer");
    this.text(ctx, "Gateway · prompt assembly", TOK.x + 14, TOK.y + 22, { size: 13, weight: 650, color: C.ink });
    this.text(ctx, "hops 1–2 · history + new message → tokens", TOK.x + 14, TOK.y + 36, { size: 9.5, color: C.mute });
    let cur: Req | null = null;
    for (const r of w.reqs.values()) if (r.stage === "tokenize" && (!cur || r.stageStart > cur.stageStart)) cur = r;
    const show = cur ? { text: PROMPTS[cur.promptIdx % PROMPTS.length]!, lIn: cur.lIn, fresh: cur.newTokens, sid: cur.sid } : this.lastTok;
    if (!show) {
      ctx.globalAlpha = 1;
      return;
    }
    const u = cur ? clamp((w.t - cur.stageStart) / (cur.stageEnd - cur.stageStart), 0, 1) : 1;
    const ps = pieces(show.text);
    const shown = Math.ceil(ps.length * u);
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    let x = TOK.x + 14;
    let y = TOK.y + 58;
    for (let i = 0; i < ps.length; i++) {
      const tw = ctx.measureText(ps[i]!).width + 3;
      if (x + tw > TOK.x + TOK.w - 12) {
        x = TOK.x + 14;
        y += 16;
        if (y > TOK.y + 92) break;
      }
      if (i < shown) {
        ctx.fillStyle = `hsl(${(hueOf(show.sid) + (i % 4) * 22) % 360} 75% ${90 - (i % 2) * 4}%)`;
        ctx.beginPath();
        ctx.roundRect(x, y - 10, tw - 1, 13, 3);
        ctx.fill();
      }
      ctx.fillStyle = i < shown ? C.ink : C.mute;
      ctx.textAlign = "left";
      ctx.fillText(ps[i]!, x + 1, y);
      x += tw;
    }
    const by = TOK.y + TOK.h - 26;
    const hist = show.lIn - show.fresh;
    const bw = TOK.w - 28;
    ctx.fillStyle = C.soft;
    ctx.beginPath();
    ctx.roundRect(TOK.x + 14, by + 12, bw, 5, 2.5);
    ctx.fill();
    ctx.fillStyle = sessionColor(show.sid, 80, 50);
    ctx.fillRect(TOK.x + 14, by + 12, (bw * hist * u) / show.lIn, 5);
    ctx.fillStyle = sessionColor(show.sid);
    ctx.fillRect(TOK.x + 14 + (bw * hist) / show.lIn, by + 12, (bw * show.fresh * u) / show.lIn, 5);
    this.text(ctx, `${fmtInt(show.lIn * u)} tokens`, TOK.x + 14, by + 6, { size: 11, weight: 650, color: C.ink, mono: true });
    this.text(ctx, hist > 0 ? `history + ${fmtInt(show.fresh)} new` : "system + user prompt", TOK.x + TOK.w - 14, by + 6, { size: 9.5, color: C.mute, align: "right" });
    ctx.globalAlpha = 1;
  }

  private gateway(ctx: CanvasRenderingContext2D, w: World): void {
    ctx.globalAlpha = this.reveal.gwA;
    this.box(ctx, GW.x, GW.y, GW.w, GW.h, 14, this.selected?.type === "gateway");
    this.text(ctx, "Router", GW.x + 14, GW.y + 22, { size: 13, weight: 650, color: C.ink });
    this.text(ctx, `hop 3 · ${w.params.routing}`, GW.x + 14, GW.y + 36, { size: 9.5, color: C.mute });
    const q = w.gatewayQueue.length;
    this.text(ctx, fmtInt(q), GW.x + 14, GW.y + 70, { size: 24, weight: 650, color: q ? C.ink : C.mute, mono: true });
    this.text(ctx, "queued, waiting for a pod", GW.x + 14, GW.y + 84, { size: 9.5, color: C.mute });
    const lr = w.lastRoute;
    if (lr) this.text(ctx, `last → pod-${lr.chosen}${lr.policy === "prefix-aware" ? ` · cache ${(100 * (lr.candidates.find((c) => c.podId === lr.chosen)?.cache ?? 0)).toFixed(0)}%` : ""}`, GW.x + 14, GW.y + 102, { size: 9.5, color: C.sub });
    // queue stack above the node
    for (let i = 0; i < Math.min(q, 60); i++) {
      const r = w.reqs.get(w.gatewayQueue[i]!);
      if (!r) continue;
      ctx.fillStyle = sessionColor(r.sid);
      ctx.beginPath();
      ctx.roundRect(GW.x + 8 + (i % 15) * 11, GW.y - 14 - Math.floor(i / 15) * 11, 8, 8, 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private storeNode(ctx: CanvasRenderingContext2D, w: World): void {
    ctx.globalAlpha = this.storeA;
    this.box(ctx, STORE.x, STORE.y, STORE.w, STORE.h, 12, this.selected?.type === "store");
    this.text(ctx, "Conversation store", STORE.x + 14, STORE.y + 21, { size: 12, weight: 650, color: C.ink });
    this.text(ctx, "the text of every turn · source of truth", STORE.x + 14, STORE.y + 35, { size: 9, color: C.mute });
    // an append-only log: one tick per stored turn
    const n = Math.min(w.store.turns, 54);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = i % 2 ? "#cbd5e1" : "#94a3b8";
      ctx.fillRect(STORE.x + 14 + i * 3, STORE.y + 44, 2, 8);
    }
    this.text(ctx, `${fmtInt(w.store.turns)} turns · ${fmtInt(w.store.tokens)} tok`, STORE.x + 14, STORE.y + 64, { size: 9, color: C.sub, mono: true });
    ctx.globalAlpha = 1;
  }

  private remoteNode(ctx: CanvasRenderingContext2D, w: World): void {
    const r = this.remote;
    ctx.globalAlpha = r.a;
    this.box(ctx, r.x, r.y, PW, REMOTE_H, 14, this.selected?.type === "remote");
    this.text(ctx, "Remote KV pool", r.x + 14, r.y + 22, { size: 12, weight: 650, color: C.ink });
    this.text(ctx, "shared by all pods, over the network", r.x + PW - 14, r.y + 22, { size: 9, color: C.mute, align: "right" });
    const cap = w.params.remoteGB * 1e9;
    ctx.fillStyle = C.soft;
    ctx.beginPath();
    ctx.roundRect(r.x + 62, r.y + 34, PW - 150, 12, 4);
    ctx.fill();
    if (cap > 0) {
      ctx.fillStyle = C.remote;
      ctx.globalAlpha = r.a * 0.8;
      ctx.beginPath();
      ctx.roundRect(r.x + 62, r.y + 34, Math.max(2, ((PW - 150) * w.remoteBytes) / cap), 12, 4);
      ctx.fill();
      ctx.globalAlpha = r.a;
    }
    this.text(ctx, `${w.remote.size} seq`, r.x + 14, r.y + 44, { size: 9.5, color: C.sub, mono: true });
    this.text(ctx, cap ? `${(w.remoteBytes / 1e9).toFixed(1)}/${w.params.remoteGB} GB` : "off", r.x + PW - 14, r.y + 44, { size: 9.5, color: C.mute, align: "right", mono: true });
    ctx.globalAlpha = 1;
  }

  private pod(ctx: CanvasRenderingContext2D, w: World, pod: Pod, lod: number): void {
    const pp = this.podPos.get(pod.id);
    if (!pp) return;
    const g = podGeom(pod.spec.tp);
    const p = w.params;
    const sel = this.selected?.type === "pod" && this.selected.id === pod.id;
    ctx.save();
    ctx.globalAlpha = pp.a;
    ctx.translate(pp.x, pp.y + (1 - ease(pp.a)) * 14);
    this.box(ctx, 0, 0, PW, g.h, 16, sel);
    const T = (str: string, x: number, y: number, o: Parameters<Scene["text"]>[4] = {}) => this.text(ctx, str, x, y, o);

    // header
    const name = pod.role === "both" ? `pod-${pod.id}` : `pod-${pod.id} · ${pod.role}`;
    T(name, 14, 24, { size: 14, weight: 650, color: C.ink });
    const nameW = ctx.measureText(name).width;
    if (pod.role !== "both") {
      ctx.fillStyle = pod.role === "prefill" ? C.prefill : C.decode;
      ctx.fillRect(0, 12, 3, 18);
    }
    const stateLabel = pod.state === "loading" ? `loading weights ${(pod.loadProgress * 100).toFixed(0)}%` : pod.state === "creating" ? "scheduling container" : pod.state === "failed" ? "weights do not fit" : pod.state;
    const sc = pod.state === "ready" ? C.ok : pod.state === "failed" ? C.evict : C.mute;
    ctx.fillStyle = sc;
    ctx.beginPath();
    ctx.arc(26 + nameW, 20, 3.5, 0, 7);
    ctx.fill();
    T(stateLabel, 35 + nameW, 24, { size: 10.5, color: C.sub });
    if (pod.last && pod.state === "ready") T(`step ${(pod.last.dur * 1e3).toFixed(1)} ms`, PW - 14, 24, { size: 10.5, color: C.sub, align: "right", mono: true });

    // sequence lanes: waiting queue, then one slot per max_num_seqs
    if (lod > 0) T(`batch ${pod.running.length}/${p.maxNumSeqs}${pod.waiting.length ? ` · ${pod.waiting.length} waiting` : ""}`, 14, g.lanesY + 4, { size: 9.5, color: C.mute });
    const slots = Math.max(p.maxNumSeqs, pod.running.length);
    const gap = slots > 32 ? 1 : 3;
    const sw = Math.min(22, (PW - 28 - gap * (slots - 1)) / slots);
    for (let i = 0; i < slots; i++) {
      const x = 14 + i * (sw + gap);
      const y = g.lanesY + 12;
      const hh = 34;
      ctx.fillStyle = C.soft;
      ctx.beginPath();
      ctx.roundRect(x, y, sw, hh, Math.min(4, sw / 2));
      ctx.fill();
      const r = pod.running[i] !== undefined ? w.reqs.get(pod.running[i]!) : undefined;
      if (!r) continue;
      const pre = r.stage === "decode" ? 1 : r.stage === "prefill" ? r.prefillDone / Math.max(1, r.prefillTarget) : 0;
      const dec = r.stage === "decode" ? r.out / r.lOut : 0;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, sw, hh, Math.min(4, sw / 2));
      ctx.clip();
      if (r.stage === "reload") {
        ctx.fillStyle = C.dram;
        ctx.globalAlpha *= 0.35 + 0.3 * Math.sin(this.vt * 6);
        ctx.fillRect(x, y, sw, hh);
      } else {
        ctx.fillStyle = r.stage === "decode" ? "#f8d9cc" : C.prefill;
        ctx.fillRect(x, y + hh * (1 - pre), sw, hh * pre);
        if (r.cached > 0 && r.stage === "prefill") {
          ctx.fillStyle = "#f8d9cc";
          const cf = r.cached / Math.max(1, r.prefillTarget);
          ctx.fillRect(x, y + hh * (1 - cf), sw, hh * cf);
        }
        ctx.fillStyle = C.decode;
        ctx.fillRect(x, y + hh * (1 - dec), sw, hh * dec);
      }
      ctx.fillStyle = sessionColor(r.sid);
      ctx.fillRect(x, y, sw, 4);
      ctx.restore();
    }

    // GPUs: HBM split into weights | activations | KV block grid | headroom
    const ca = this.cellA.get(pod.id);
    const flashing = this.flashes.filter((f) => f.podId === pod.id);
    const b = pod.budget;
    pod.spec.tp > 0 &&
      g.gpus.forEach((gp, gi) => {
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 1;
        ctx.fillStyle = "#fbfcfe";
        ctx.beginPath();
        ctx.roundRect(gp.x, gp.y, gp.w, gp.h, 9);
        ctx.fill();
        ctx.stroke();
        if (lod > 0) {
          T(gp.w > 120 ? `GPU ${gi} · ${pod.spec.gpu.label}` : `GPU ${gi}`, gp.x + 8, gp.y + 15, { size: 9.5, weight: 600, color: C.sub });
          if (gp.w > 150) T(`HBM ${(b.hbm / 1e9).toFixed(0)} GB`, gp.x + gp.w - 8, gp.y + 15, { size: 9.5, color: C.mute, align: "right", mono: true });
        }
        const sp = hbmSplit(pod, gp);
        // weights fill up while the pod loads
        ctx.fillStyle = "#e2e8f0";
        ctx.beginPath();
        ctx.roundRect(sp.x0, sp.y, sp.ww - 1.5, sp.h, 3);
        ctx.fill();
        const lp = pod.state === "ready" || pod.state === "draining" ? 1 : pod.loadProgress;
        ctx.fillStyle = C.weights;
        ctx.beginPath();
        ctx.roundRect(sp.x0, sp.y + sp.h * (1 - lp), sp.ww - 1.5, sp.h * lp, 3);
        ctx.fill();
        if (lod > 1 && sp.ww > 44) {
          T("weights", sp.x0 + 5, sp.y + sp.h - 16, { size: 8.5, color: lp > 0.3 ? "#cbd5e1" : C.mute });
          T(`${(b.weights / 1e9).toFixed(1)} GB`, sp.x0 + 5, sp.y + sp.h - 5, { size: 8.5, color: lp > 0.15 ? "#ffffff" : C.mute, mono: true });
        }
        ctx.fillStyle = "#94a3b8";
        ctx.fillRect(sp.x0 + sp.ww, sp.y, sp.aw - 1.5, sp.h);
        // headroom: hatched, never allocated
        const hx = sp.kx + sp.kw + 1.5;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(hx, sp.y, sp.hw - 1.5, sp.h, 3);
        ctx.clip();
        ctx.fillStyle = "#f8fafc";
        ctx.fillRect(hx, sp.y, sp.hw, sp.h);
        ctx.strokeStyle = "#dbe2ea";
        ctx.lineWidth = 1;
        for (let d = -sp.h; d < sp.hw; d += 5) {
          ctx.beginPath();
          ctx.moveTo(hx + d, sp.y + sp.h);
          ctx.lineTo(hx + d + sp.h, sp.y);
          ctx.stroke();
        }
        ctx.restore();
        // KV pool: paged blocks, coloured by the session that owns them; pale = cached but idle
        if (sp.kw > 4 && ca) {
          const ready = pod.state === "ready" || pod.state === "draining";
          const pad = Math.min(1, sp.cw * 0.12);
          if (lod === 0) {
            ctx.fillStyle = "#eef2f7";
            ctx.fillRect(sp.kx, sp.y, sp.kw, sp.h);
          }
          for (let c = 0; c < CELLS; c++) {
            const cx = sp.kx + Math.floor(c / sp.rows) * sp.cw;
            const cy = sp.y + (c % sp.rows) * sp.ch;
            const a = ca.a[c]!;
            if (lod > 0) {
              ctx.fillStyle = ready ? "#eef2f7" : "#f6f8fb";
              ctx.fillRect(cx + pad, cy + pad, sp.cw - 2 * pad, sp.ch - 2 * pad);
            }
            if (a > 0.02) {
              const owner = ca.owner[c]!;
              const e = pod.entries.get(owner);
              ctx.globalAlpha = pp.a * a;
              ctx.fillStyle = e && !e.active ? sessionColor(owner, 84, 38) : sessionColor(owner, 60, 66);
              ctx.fillRect(cx + pad, cy + pad, sp.cw - 2 * pad, sp.ch - 2 * pad);
              ctx.globalAlpha = pp.a;
            }
          }
          for (const f of flashing) {
            ctx.globalAlpha = pp.a * (1 - (this.vt - f.t0) / 1.2);
            ctx.strokeStyle = C.evict;
            ctx.lineWidth = 1.2;
            for (const c of f.cells) ctx.strokeRect(sp.kx + Math.floor(c / sp.rows) * sp.cw + 0.5, sp.y + (c % sp.rows) * sp.ch + 0.5, sp.cw - 1, sp.ch - 1);
            ctx.globalAlpha = pp.a;
          }
        }
      });
    if (lod > 1 && pod.state === "ready") {
      const used = pod.usedBlocks * b.blockBytes;
      T(`KV cache ${(used / 1e9).toFixed(1)} / ${((b.kv * pod.spec.tp) / 1e9).toFixed(1)} GB`, PW - 14, g.lanesY + 4, { size: 9.5, color: C.mute, align: "right", mono: true });
    }

    // forward pass: a sweep across the layers once per engine step
    const lx = 14;
    const lw = PW - 28;
    const nL = pod.spec.model.nL;
    const stepping = pod.plan && pod.stepEnd > pod.stepStart;
    const u = stepping ? clamp((w.t - pod.stepStart) / (pod.stepEnd - pod.stepStart), 0, 1) : -1;
    const hot = pod.last && pod.last.prefillTok > pod.last.decodeTok ? C.prefill : C.decode;
    for (let i = 0; i < nL; i++) {
      const d = u < 0 ? 9 : Math.abs(i / nL - u) * nL;
      ctx.fillStyle = d < 3 ? hot : "#e2e8f0";
      ctx.globalAlpha = pp.a * (d < 3 ? 1 - d / 4 : 1);
      ctx.fillRect(lx + (i * lw) / nL, g.stripY, lw / nL - 1, 7);
    }
    ctx.globalAlpha = pp.a;

    // arithmetic intensity on a log axis, against the GPU's ridge point
    const gy = g.gaugeY;
    const lo = Math.log10(0.5);
    const hi = Math.log10(5000);
    const X = (logv: number) => lx + ((clamp(logv, lo, hi) - lo) / (hi - lo)) * lw;
    const rx = X(Math.log10(ridge(pod.spec.gpu)));
    ctx.fillStyle = "#e6effb";
    ctx.beginPath();
    ctx.roundRect(lx, gy + 14, rx - lx - 1, 6, 3);
    ctx.fill();
    ctx.fillStyle = "#fde7dd";
    ctx.beginPath();
    ctx.roundRect(rx + 1, gy + 14, lx + lw - rx - 1, 6, 3);
    ctx.fill();
    ctx.fillStyle = C.ink;
    ctx.fillRect(rx - 0.75, gy + 10, 1.5, 14);
    if (lod > 1) {
      T("memory-bound", lx, gy + 33, { size: 8.5, color: C.mute });
      T("compute-bound", lx + lw, gy + 33, { size: 8.5, color: C.mute, align: "right" });
      T(`ridge ${ridge(pod.spec.gpu).toFixed(0)}`, rx, gy + 33, { size: 8.5, color: C.sub, align: "center" });
    }
    if (pod.last && pod.state === "ready") {
      const dx = X(pp.i);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(dx, gy + 17, 7, 0, 7);
      ctx.fill();
      ctx.fillStyle = pod.last.bound === "memory" ? C.decode : C.prefill;
      ctx.beginPath();
      ctx.arc(dx, gy + 17, 5, 0, 7);
      ctx.fill();
      if (lod > 0) {
        T(`arithmetic intensity ${pod.last.intensity < 10 ? pod.last.intensity.toFixed(1) : pod.last.intensity.toFixed(0)} FLOP/byte`, lx, gy + 5, { size: 9.5, weight: 600, color: C.ink });
        T(`${pod.last.decodeTok} decode · ${fmtInt(pod.last.prefillTok)} prefill`, lx + lw, gy + 5, { size: 9, color: C.mute, align: "right" });
      }
    } else if (lod > 0) T("arithmetic intensity", lx, gy + 5, { size: 9.5, color: C.mute });

    // lower tiers on the node: host DRAM and local SSD
    (["dram", "ssd"] as const).forEach((tier, ti) => {
      const y = g.tiersY + ti * 22;
      const cap = tierCapBlocks(pod, tier === "dram" ? p.dramGB : p.ssdGB);
      const used = tier === "dram" ? pod.dramBlocks : pod.ssdBlocks;
      const col = tier === "dram" ? C.dram : C.ssd;
      if (lod > 0) T(tier === "dram" ? "DRAM" : "SSD", 14, y + 11, { size: 9.5, weight: 600, color: C.sub });
      const bx = 62;
      const bw = PW - 150;
      ctx.fillStyle = C.soft;
      ctx.beginPath();
      ctx.roundRect(bx, y + 2, bw, 12, 4);
      ctx.fill();
      if (cap > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(bx, y + 2, bw, 12, 4);
        ctx.clip();
        let x = bx;
        for (const e of pod.entries.values()) {
          if (e.tier !== tier) continue;
          const ew = (bw * e.blocks) / cap;
          ctx.fillStyle = col;
          ctx.globalAlpha = pp.a * 0.75;
          ctx.fillRect(x, y + 2, Math.max(1, ew - 1.5), 12);
          x += ew;
        }
        ctx.restore();
        ctx.globalAlpha = pp.a;
      }
      if (lod > 0) T(cap > 0 ? `${((used * b.blockBytes) / 1e9).toFixed(1)}/${tier === "dram" ? p.dramGB : p.ssdGB} GB` : "off", PW - 14, y + 11, { size: 9.5, color: C.mute, align: "right", mono: true });
    });
    ctx.restore();
  }

  private train(ctx: CanvasRenderingContext2D, a: P, b: P, u: number, r: Req, label: boolean): void {
    const n = clamp(Math.ceil(Math.log2(r.lIn / 96)), 2, 9);
    ctx.fillStyle = sessionColor(r.sid);
    for (let i = 0; i < n; i++) {
      const uu = u - i * 0.035;
      if (uu < 0) break;
      const p = bez(a, b, ease(uu));
      ctx.beginPath();
      ctx.roundRect(p.x - 3, p.y - 3, 6, 6, 1.5);
      ctx.fill();
    }
    if (label) {
      const p = bez(a, b, ease(u));
      this.text(ctx, `${fmtInt(r.lIn)} tok`, p.x, p.y - 9, { size: 9.5, color: C.sub, align: "center", mono: true });
    }
  }

  private transit(ctx: CanvasRenderingContext2D, w: World, lod: number): void {
    let moving = 0;
    for (const r of w.reqs.values()) if (r.stage === "send" || r.stage === "toGateway" || r.stage === "toPod") moving++;
    const label = lod > 1 && moving <= 6;
    let drawn = 0;
    for (const r of w.reqs.values()) {
      if (r.stage !== "send" && r.stage !== "toGateway" && r.stage !== "toPod" && r.stage !== "transfer") continue;
      if (++drawn > 300) break;
      ctx.globalAlpha = this.focusSid && this.focusSid !== r.sid ? 0.2 : 1;
      const u = r.stageEnd > r.stageStart ? clamp((w.t - r.stageStart) / (r.stageEnd - r.stageStart), 0, 1) : 1;
      if (r.stage === "send") {
        const p = bez(this.sessAnchor(r.sid), { x: TOK.x, y: TOK.y + TOK.h / 2 }, ease(u));
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = sessionColor(r.sid);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(p.x - 11, p.y - 8, 22, 16, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#94a3b8";
        for (let i = 0; i < 3; i++) ctx.fillRect(p.x - 7, p.y - 5 + i * 4, i === 2 ? 8 : 14, 1.5);
        if (label) this.text(ctx, "prompt text", p.x, p.y - 13, { size: 9.5, color: C.sub, align: "center" });
      } else if (r.stage === "toGateway") {
        this.train(ctx, { x: TOK.x + TOK.w, y: 0 }, { x: GW.x, y: 0 }, u, r, label);
      } else if (r.stage === "toPod") {
        const pod = w.pods.find((x) => x.id === r.podId);
        const rect = pod && this.podRect(pod);
        if (rect) this.train(ctx, { x: GW.x + GW.w, y: 0 }, { x: rect.x, y: rect.y + 54 }, u, r, label);
      } else if (r.stage === "transfer") {
        // disaggregated serving: the prompt's KV blocks travel from the prefill pod to the decode pod
        const from = w.pods.find((x) => x.id === r.fromPod);
        const to = w.pods.find((x) => x.id === r.podId);
        const a = from && this.podRect(from);
        const b = to && this.podRect(to);
        if (a && b) {
          const p0 = { x: a.x + PW / 2, y: a.y + a.h / 2 };
          const p1 = { x: b.x + PW / 2, y: b.y + 60 };
          ctx.strokeStyle = sessionColor(r.sid);
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = sessionColor(r.sid);
          for (let i = 0; i < 5; i++) {
            const uu = ease(clamp(u - i * 0.05, 0, 1));
            ctx.fillRect(p0.x + (p1.x - p0.x) * uu - 4, p0.y + (p1.y - p0.y) * uu - 4, 8, 8);
          }
          if (lod > 0) this.text(ctx, "KV cache", p0.x + (p1.x - p0.x) * ease(u), p0.y + (p1.y - p0.y) * ease(u) - 10, { size: 9.5, color: C.sub, align: "center" });
        }
      }
    }
  }

  private particles(ctx: CanvasRenderingContext2D): void {
    for (const p of this.parts) {
      const u = (this.vt - p.t0) / p.dur;
      if (u < 0) continue;
      const f = ease(u) * (p.pts.length - 1);
      const i = Math.min(p.pts.length - 2, Math.floor(f));
      const a = p.pts[i]!;
      const b = p.pts[i + 1]!;
      const x = a.x + (b.x - a.x) * (f - i);
      const y = a.y + (b.y - a.y) * (f - i);
      ctx.globalAlpha = p.fade ? 1 - u : Math.min(1, (1 - u) * 5);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.roundRect(x - p.size / 2, y - p.size / 2, p.size, p.size, 1.2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

export function sessionStatus(s: Session, r?: Req): string {
  if (!r) return s.state === "thinking" ? `turn ${s.turn} done · user is typing` : s.turn ? `idle · ${fmtInt(s.ctxTokens)} tok of context` : "idle";
  switch (r.stage) {
    case "send":
      return "sending prompt";
    case "tokenize":
      return "assembling prompt";
    case "toGateway":
    case "queued":
      return "at the router";
    case "toPod":
    case "waiting":
      return `waiting on pod-${r.podId}`;
    case "reload":
      return "reloading KV cache";
    case "handoff":
      return "prefilled · waiting for a decode pod";
    case "transfer":
      return `KV moving to pod-${r.podId}`;
    case "prefill":
      return `prefill ${fmtInt(r.prefillDone)}/${fmtInt(r.prefillTarget)}`;
    default:
      return `decode ${r.out}/${r.lOut}`;
  }
}

export const describeGpu = (pod: Pod) => `${pod.spec.tp} × ${GPUS[pod.spec.gpu.id]!.label} · ${pod.spec.model.label} ${pod.spec.precision.toUpperCase()} · weights ${(weightBytes(pod.spec.model, pod.spec.precision) / 1e9).toFixed(0)} GB`;
