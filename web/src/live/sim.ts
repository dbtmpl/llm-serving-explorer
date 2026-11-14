/**
 * Live teaching simulation of an LLM serving stack. It advances in simulated seconds and can have
 * its parameters changed while requests are in flight. Costs come from model.ts (the reference notes chapter 2);
 * the engine loop, block lifecycle and preemption-by-recompute follow chapter 3.
 */
import {
  BLOCK_TOKENS,
  GPUS,
  MODELS,
  kvBytesPerToken,
  memoryBudget,
  seqLoad,
  stepCost,
  weightBytes,
  type MemoryBudget,
  type Precision,
  type ReplicaSpec,
  type StepCost
} from "./model.js";

export type Routing = "round-robin" | "least-loaded" | "prefix-aware";

export interface Params {
  model: string;
  gpu: string;
  precision: Precision;
  tp: number;
  gpuMemUtil: number;
  maxNumSeqs: number;
  tokenBudget: number;
  prefixCaching: boolean;
  overlap: boolean;
  mbu: number;
  mfu: number;
  hostMsBase: number;
  hostMsPerSeq: number;
  routing: Routing;
  minPods: number;
  maxPods: number;
  coldStartS: number;
  scaleDownIdleS: number;
  dramGB: number;
  ssdGB: number;
  /** shared KV pool reachable from every pod over the network (0 = none) */
  remoteGB: number;
  promptTokens: number;
  /** mean new tokens a follow-up turn adds to the history */
  followTokens: number;
  outputTokens: number;
  returnProb: number;
  thinkTimeS: number;
  maxTurns: number;
  arrivalRate: number;
  pricePerGpuHour: number;
  /** static: a batch runs to completion before the next is admitted (pre-Orca). continuous: join and leave at every step */
  batching: "static" | "continuous";
  /** how much KV a request must be given to be admitted: its next chunk (vLLM), its whole prompt, or prompt + max_tokens */
  admission: "on-demand" | "prompt" | "reserve";
  /** the max_tokens clients send; only the 'reserve' admission rule looks at it */
  maxTokensCap: number;
  /** separate prefill pods and decode pods, with the KV cache handed over between them */
  disagg: boolean;
  prefillShare: number;
  /** prompts with fewer uncached tokens than this skip the prefill pool and are prefilled on the decode pod */
  pdThreshold: number;
  linkGbps: number;
  specDecode: boolean;
  specK: number;
  specAccept: number;
  /** Leviathan et al.'s c: time of one draft-model run over one target-model run */
  specCost: number;
  /** achieved copy rates between tiers; see docs/design-choices.md for the measured ranges */
  dramGBs: number;
  ssdGBs: number;
  remoteGbps: number;
  /** shed a request that has waited this long at the router (0 = never) */
  shedAfterS: number;
}

export const DEFAULT_PARAMS: Params = {
  model: "llama-3.1-8b",
  gpu: "h100",
  precision: "bf16",
  tp: 1,
  gpuMemUtil: 0.9,
  maxNumSeqs: 12,
  tokenBudget: 8192,
  prefixCaching: true,
  overlap: false,
  mbu: 0.6,
  mfu: 0.5,
  hostMsBase: 1.5,
  hostMsPerSeq: 0.05,
  routing: "prefix-aware",
  minPods: 0,
  maxPods: 16,
  coldStartS: 2,
  scaleDownIdleS: 12,
  dramGB: 32,
  ssdGB: 128,
  remoteGB: 256,
  promptTokens: 3000,
  followTokens: 120,
  outputTokens: 150,
  returnProb: 0.7,
  thinkTimeS: 4,
  maxTurns: 6,
  arrivalRate: 0,
  pricePerGpuHour: 2.5,
  batching: "continuous",
  admission: "on-demand",
  maxTokensCap: 4096,
  disagg: false,
  prefillShare: 0.34,
  pdThreshold: 512,
  linkGbps: 100,
  specDecode: false,
  specK: 4,
  specAccept: 0.7,
  specCost: 0.04,
  dramGBs: 20,
  ssdGBs: 4,
  remoteGbps: 64,
  shedAfterS: 0
};

/** Changing any of these rebuilds every pod: the weights and the KV pool are sized at start-up. */
export const RESTART_KEYS: (keyof Params)[] = ["model", "gpu", "precision", "tp", "gpuMemUtil", "disagg"];

/** Illustrative host-link rates for moving KV blocks between tiers (not from a datasheet). */
/** Bytes per second for bringing KV back to HBM from each lower tier. */
export const tierBw = (p: Params) => ({ dram: p.dramGBs * 1e9, ssd: p.ssdGBs * 1e9, remote: (p.remoteGbps / 8) * 1e9 });
export const MAX_SESSIONS = 12000;
export const CELLS = 200;
const QUEUE_SLACK = 4;
/** Front-end hop times in simulated seconds: internet hop, template + tokenise, gateway, cluster hop. */
const HOP = { send: 0.06, tokenizeBase: 0.03, tokenizePerTok: 4e-6, toGateway: 0.04, toPod: 0.06 };

export type Tier = "hbm" | "dram" | "ssd";
export type Stage = "send" | "tokenize" | "toGateway" | "queued" | "toPod" | "waiting" | "reload" | "prefill" | "handoff" | "transfer" | "decode";

export interface KvEntry {
  sid: number;
  tokens: number;
  blocks: number;
  tier: Tier;
  active: boolean;
  lastUsed: number;
  cells: number[];
}

export interface Req {
  id: number;
  sid: number;
  lIn: number;
  newTokens: number;
  lOut: number;
  stage: Stage;
  stageStart: number;
  stageEnd: number;
  podId: number;
  prefillDone: number;
  prefillTarget: number;
  cached: number;
  out: number;
  tCreate: number;
  tFirst: number;
  admitT: number;
  preemptions: number;
  promptIdx: number;
  /** tokens of KV that arrived from a prefill pod and only need to be placed */
  kvReady: number;
  counted: boolean;
  fromPod: number;
}

export interface Session {
  id: number;
  hue: number;
  turn: number;
  ctxTokens: number;
  reqId: number | null;
  state: "active" | "thinking" | "idle";
  nextTurnAt: number;
  born: number;
  lastPod: number;
  lastTtft: number;
  lastTpot: number;
}

export interface StepInfo extends StepCost {
  tCpu: number;
  dur: number;
  bytes: number;
  flops: number;
  batch: number;
  decodeTok: number;
  prefillTok: number;
}

export type PodState = "creating" | "loading" | "ready" | "draining" | "terminated" | "failed";

interface PlanItem {
  reqId: number;
  n: number;
  prefill: boolean;
}

export type Role = "both" | "prefill" | "decode";

export interface Pod {
  id: number;
  slot: number;
  role: Role;
  state: PodState;
  born: number;
  stateSince: number;
  loadProgress: number;
  spec: ReplicaSpec;
  budget: MemoryBudget;
  waiting: number[];
  running: number[];
  inbound: number;
  stepStart: number;
  stepEnd: number;
  plan: PlanItem[] | null;
  last: StepInfo | null;
  steps: number;
  entries: Map<number, KvEntry>;
  cells: Int32Array;
  freeCells: number;
  usedBlocks: number;
  dramBlocks: number;
  ssdBlocks: number;
  idleSince: number;
  tokensOut: number;
  /** duration of the last decode-only step, to show what a prefill chunk costs the running streams */
  decodeDur: number;
}

export interface RouteDecision {
  t: number;
  sid: number;
  chosen: number;
  policy: Routing;
  candidates: { podId: number; load: number; cache: number; tier: Tier | "remote" | null; score: number }[];
}

export type SimEvent = { t: number; kind: string; podId?: number; sid?: number; reqId?: number; [k: string]: unknown };

export interface Metrics {
  completed: number;
  failed: number;
  tokensOut: number;
  promptTokens: number;
  cachedTokens: number;
  evictions: number;
  drops: number;
  preemptions: number;
  reloads: number;
  ttft: number[];
  tpot: number[];
  gpuSeconds: number;
}

export interface Sample {
  t: number;
  tokS: number;
  inflight: number;
  pods: number;
  kvFill: number;
}

export interface World {
  t: number;
  params: Params;
  sessions: Map<number, Session>;
  reqs: Map<number, Req>;
  pods: Pod[];
  gatewayQueue: number[];
  pending: number[];
  events: SimEvent[];
  lastRoute: RouteDecision | null;
  m: Metrics;
  history: Sample[];
  rr: number;
  nextId: number;
  nextPod: number;
  seed: number;
  arrivalAcc: number;
  tokWindow: { t: number; n: number }[];
  lastSample: number;
  /** has any request ever reached this stage of the graph */
  seen: { tokenizer: boolean; gateway: boolean };
  /** conversation store: the text of every turn, the system of record every KV tier is derived from */
  store: { turns: number; tokens: number };
  /** remote KV pool shared by all pods */
  remote: Map<number, { sid: number; tokens: number; bytes: number; lastUsed: number }>;
  remoteBytes: number;
  lastChurn: number;
  /** requests whose prefill is done and that wait for a decode pod to take their KV */
  handoff: number[];
}

export function createWorld(params: Params = { ...DEFAULT_PARAMS }, seed = 7): World {
  return {
    t: 0,
    params,
    sessions: new Map(),
    reqs: new Map(),
    pods: [],
    gatewayQueue: [],
    pending: [],
    events: [],
    lastRoute: null,
    m: { completed: 0, failed: 0, tokensOut: 0, promptTokens: 0, cachedTokens: 0, evictions: 0, drops: 0, preemptions: 0, reloads: 0, ttft: [], tpot: [], gpuSeconds: 0 },
    history: [],
    rr: 0,
    nextId: 1,
    nextPod: 1,
    seed,
    arrivalAcc: 0,
    tokWindow: [],
    lastSample: 0,
    seen: { tokenizer: false, gateway: false },
    store: { turns: 0, tokens: 0 },
    remote: new Map(),
    remoteBytes: 0,
    lastChurn: 0,
    handoff: []
  };
}

function rand(w: World): number {
  let z = (w.seed += 0x6d2b79f5);
  z = Math.imul(z ^ (z >>> 15), z | 1);
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
  return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
}

const emit = (w: World, kind: string, data: Omit<SimEvent, "t" | "kind"> = {}) => {
  w.events.push({ t: w.t, kind, ...data });
};

export function replicaSpec(p: Params): ReplicaSpec {
  return { model: MODELS[p.model]!, gpu: GPUS[p.gpu]!, precision: p.precision, tp: p.tp, gpuMemUtil: p.gpuMemUtil };
}

export const blocksFor = (tokens: number) => Math.ceil(tokens / BLOCK_TOKENS);
export const tierCapBlocks = (pod: Pod, gb: number) => Math.floor((gb * 1e9) / pod.budget.blockBytes);
export const podLoad = (pod: Pod) => pod.running.length + pod.waiting.length + pod.inbound;
export const livePods = (w: World) => w.pods.filter((p) => p.state === "creating" || p.state === "loading" || p.state === "ready");

/* ------------------------------------------------------------------ workload */

/** Schedule n new sessions, each sending one request, spread over `over` simulated seconds. */
export function spawnBurst(w: World, n: number, over = 0): void {
  for (let i = 0; i < n; i++) w.pending.push(w.t + (n > 1 ? (over * i) / (n - 1) : 0) + rand(w) * 0.02);
  w.pending.sort((a, b) => a - b);
}

function newSession(w: World): void {
  const id = w.nextId++;
  const s: Session = { id, hue: (id * 137.508) % 360, turn: 0, ctxTokens: 0, reqId: null, state: "active", nextTurnAt: 0, born: w.t, lastPod: -1, lastTtft: 0, lastTpot: 0 };
  w.sessions.set(id, s);
  emit(w, "session.new", { sid: id });
  newRequest(w, s);
  if (w.sessions.size > MAX_SESSIONS) {
    for (const old of w.sessions.values()) {
      if (old.state === "idle") {
        w.sessions.delete(old.id);
        if (w.sessions.size <= MAX_SESSIONS - 200) break;
      }
    }
  }
}

function newRequest(w: World, s: Session): void {
  const p = w.params;
  const jitter = (lo: number, hi: number) => lo + rand(w) * (hi - lo);
  const fresh = s.turn === 0 ? Math.round(p.promptTokens * jitter(0.6, 1.4)) : Math.max(1, Math.round(p.followTokens * jitter(0.4, 1.6)));
  const r: Req = {
    id: w.nextId++,
    sid: s.id,
    lIn: Math.max(1, s.ctxTokens + fresh),
    newTokens: fresh,
    lOut: Math.max(2, Math.round(p.outputTokens * jitter(0.5, 1.5))),
    stage: "send",
    stageStart: w.t,
    stageEnd: w.t + HOP.send,
    podId: -1,
    prefillDone: 0,
    prefillTarget: 0,
    cached: 0,
    out: 0,
    tCreate: w.t,
    tFirst: 0,
    admitT: 0,
    preemptions: 0,
    promptIdx: Math.floor(rand(w) * 1000),
    kvReady: 0,
    counted: false,
    fromPod: -1
  };
  w.reqs.set(r.id, r);
  s.reqId = r.id;
  s.state = "active";
  emit(w, "req.new", { sid: s.id, reqId: r.id, lIn: r.lIn, turn: s.turn });
  if (s.turn > 0) emit(w, "req.followup", { sid: s.id, reqId: r.id, turn: s.turn + 1, history: s.ctxTokens, fresh });
}

/* ------------------------------------------------------------------ KV cache */

function allocCells(pod: Pod, e: KvEntry): void {
  const perCell = pod.budget.poolBlocks / CELLS;
  // cells show blocks that hold tokens, so a prompt's reservation fills in as prefill writes it
  const filled = Math.min(e.blocks, blocksFor(Math.max(1, e.tokens)));
  const target = e.tier === "hbm" && e.blocks > 0 ? Math.max(1, Math.round(filled / perCell)) : 0;
  while (e.cells.length < target && pod.freeCells > 0) {
    // paged: any free physical block will do, so cells land wherever there is room
    let c = (Math.imul(e.sid * 2654435761 + e.cells.length * 40503 + pod.steps, 1) >>> 0) % CELLS;
    while (pod.cells[c] !== 0) c = (c + 1) % CELLS;
    pod.cells[c] = e.sid;
    pod.freeCells--;
    e.cells.push(c);
  }
  while (e.cells.length > target) {
    pod.cells[e.cells.pop()!] = 0;
    pod.freeCells++;
  }
}

function releaseHbm(pod: Pod, e: KvEntry): number[] {
  const cells = e.cells.slice();
  pod.usedBlocks -= e.blocks;
  for (const c of e.cells) pod.cells[c] = 0;
  pod.freeCells += e.cells.length;
  e.cells = [];
  return cells;
}

function lru(pod: Pod, tier: Tier, skip?: KvEntry): KvEntry | null {
  let best: KvEntry | null = null;
  for (const e of pod.entries.values()) {
    if (e.tier !== tier || e.active || e === skip) continue;
    if (!best || e.lastUsed < best.lastUsed) best = e;
  }
  return best;
}

function dropEntry(w: World, pod: Pod, e: KvEntry, from: Tier, cells: number[] = []): void {
  if (from === "dram") pod.dramBlocks -= e.blocks;
  if (from === "ssd") pod.ssdBlocks -= e.blocks;
  pod.entries.delete(e.sid);
  w.m.drops++;
  emit(w, "kv.drop", { podId: pod.id, sid: e.sid, from, cells, bytes: e.blocks * pod.budget.blockBytes, tokens: e.tokens });
}

/** Leave the node: into the shared remote pool if there is one with room, otherwise the KV is gone. */
function spill(w: World, pod: Pod, e: KvEntry, from: Tier, cells: number[] = []): void {
  const bytes = e.blocks * pod.budget.blockBytes;
  const cap = w.params.remoteGB * 1e9;
  if (bytes > cap) return dropEntry(w, pod, e, from, cells);
  while (w.remoteBytes + bytes > cap) {
    let old: { sid: number; tokens: number; bytes: number; lastUsed: number } | null = null;
    for (const r of w.remote.values()) if (!old || r.lastUsed < old.lastUsed) old = r;
    if (!old) break;
    w.remote.delete(old.sid);
    w.remoteBytes -= old.bytes;
    w.m.drops++;
    emit(w, "kv.drop", { sid: old.sid, from: "remote", cells: [], bytes: old.bytes, tokens: old.tokens });
  }
  if (from === "dram") pod.dramBlocks -= e.blocks;
  if (from === "ssd") pod.ssdBlocks -= e.blocks;
  pod.entries.delete(e.sid);
  const prev = w.remote.get(e.sid);
  if (prev) w.remoteBytes -= prev.bytes;
  w.remote.set(e.sid, { sid: e.sid, tokens: e.tokens, bytes, lastUsed: e.lastUsed });
  w.remoteBytes += bytes;
  emit(w, "kv.move", { podId: pod.id, sid: e.sid, from, to: "remote", cells, bytes, tokens: e.tokens, idleFor: w.t - e.lastUsed });
}

function toSsd(w: World, pod: Pod, e: KvEntry, from: Tier, cells: number[]): void {
  const cap = tierCapBlocks(pod, w.params.ssdGB);
  if (e.blocks > cap) return spill(w, pod, e, from, cells);
  while (pod.ssdBlocks + e.blocks > cap) {
    const v = lru(pod, "ssd", e);
    if (!v) return spill(w, pod, e, from, cells);
    spill(w, pod, v, "ssd");
  }
  if (from === "dram") pod.dramBlocks -= e.blocks;
  e.tier = "ssd";
  pod.ssdBlocks += e.blocks;
  emit(w, "kv.move", { podId: pod.id, sid: e.sid, from, to: "ssd", cells, bytes: e.blocks * pod.budget.blockBytes, tokens: e.tokens, idleFor: w.t - e.lastUsed });
}

/** Evict one idle cached sequence from HBM: to DRAM, pushing DRAM's oldest down to SSD, or drop. */
function demote(w: World, pod: Pod, e: KvEntry): void {
  const cells = releaseHbm(pod, e);
  w.m.evictions++;
  const cap = tierCapBlocks(pod, w.params.dramGB);
  if (e.blocks > cap) return toSsd(w, pod, e, "hbm", cells);
  while (pod.dramBlocks + e.blocks > cap) {
    const v = lru(pod, "dram", e);
    if (!v) return toSsd(w, pod, e, "hbm", cells);
    toSsd(w, pod, v, "dram", []);
  }
  e.tier = "dram";
  pod.dramBlocks += e.blocks;
  emit(w, "kv.move", { podId: pod.id, sid: e.sid, from: "hbm", to: "dram", cells, bytes: e.blocks * pod.budget.blockBytes, tokens: e.tokens, idleFor: w.t - e.lastUsed });
}

function preempt(w: World, pod: Pod, r: Req, why: string): void {
  const e = pod.entries.get(r.sid);
  let cells: number[] = [];
  if (e) {
    cells = releaseHbm(pod, e);
    pod.entries.delete(r.sid);
  }
  pod.running.splice(pod.running.indexOf(r.id), 1);
  pod.waiting.unshift(r.id);
  r.stage = "waiting";
  r.prefillDone = 0;
  r.cached = 0;
  r.preemptions++;
  w.m.preemptions++;
  emit(w, "req.preempted", { podId: pod.id, sid: r.sid, reqId: r.id, cells, why, lost: r.lIn + r.out });
}

/** Make `need` free HBM blocks: evict idle cached sequences first, then (if allowed) preempt the newest running one. */
function makeRoom(w: World, pod: Pod, need: number, protect: Req, allowPreempt: boolean): boolean {
  while (pod.budget.poolBlocks - pod.usedBlocks < need) {
    const idle = lru(pod, "hbm", pod.entries.get(protect.sid));
    if (idle) {
      demote(w, pod, idle);
      continue;
    }
    if (!allowPreempt) return false;
    // the newest admission goes first (FCFS priority). If that is the requester itself, it must wait or yield.
    let victim: Req | null = null;
    for (const id of pod.running) {
      const r = w.reqs.get(id)!;
      if (r.stage === "reload") continue;
      if (!victim || r.admitT > victim.admitT) victim = r;
    }
    if (!victim || victim === protect) return false;
    preempt(w, pod, victim, "KV memory short");
  }
  return true;
}

function growTo(w: World, pod: Pod, e: KvEntry, tokens: number, r: Req, allowPreempt: boolean): boolean {
  const need = blocksFor(tokens) - e.blocks;
  if (need > 0) {
    if (!makeRoom(w, pod, need, r, allowPreempt)) return false;
    e.blocks += need;
    pod.usedBlocks += need;
  }
  e.tokens = tokens;
  allocCells(pod, e);
  return true;
}

function shrinkTo(pod: Pod, e: KvEntry, tokens: number): void {
  const extra = e.blocks - blocksFor(Math.max(1, tokens));
  if (extra > 0) {
    e.blocks -= extra;
    pod.usedBlocks -= extra;
  }
  allocCells(pod, e);
}

/* ------------------------------------------------------------------ engine */

function failReq(w: World, pod: Pod | null, r: Req, why: string): void {
  w.reqs.delete(r.id);
  const s = w.sessions.get(r.sid);
  if (s) {
    s.reqId = null;
    s.state = "idle";
  }
  w.m.failed++;
  emit(w, "req.failed", { podId: pod?.id, sid: r.sid, reqId: r.id, why });
}

/** Returns false when the request could not be admitted this step. */
function admit(w: World, pod: Pod, r: Req): boolean {
  const p = w.params;
  const reserveOut = p.admission === "reserve" ? Math.max(r.lOut, p.maxTokensCap) : r.lOut;
  if (blocksFor(r.lIn + reserveOut) > pod.budget.poolBlocks) {
    pod.waiting.shift();
    failReq(w, pod, r, "context exceeds the KV pool");
    return true;
  }
  let e = pod.entries.get(r.sid);
  const recomputeTime = (tokens: number) => seqLoad(pod.spec.model, 0, tokens).flops / (pod.spec.tp * pod.spec.gpu.peak * p.mfu);
  const far = !e && p.prefixCaching ? w.remote.get(r.sid) : undefined;
  if (far) {
    // a copy in the shared pool can be loaded by any pod, if that beats recomputing it
    const dur = far.bytes / tierBw(p).remote;
    const recompute = recomputeTime(far.tokens);
    const blocks = blocksFor(far.tokens);
    if (dur <= recompute && makeRoom(w, pod, blocks, r, false)) {
      // making room may itself have pushed this copy out of the pool; it is in hand either way
      if (w.remote.delete(r.sid)) w.remoteBytes -= far.bytes;
      e = { sid: r.sid, tokens: far.tokens, blocks, tier: "hbm", active: true, lastUsed: w.t, cells: [] };
      pod.entries.set(r.sid, e);
      pod.usedBlocks += blocks;
      allocCells(pod, e);
      pod.waiting.shift();
      pod.running.push(r.id);
      r.stage = "reload";
      r.stageStart = w.t;
      r.stageEnd = w.t + dur;
      r.admitT = w.t;
      w.m.reloads++;
      emit(w, "kv.reload", { podId: pod.id, sid: r.sid, reqId: r.id, from: "remote", bytes: far.bytes, dur, recompute, cells: e.cells.slice(), tokens: far.tokens });
      return true;
    }
    if (dur > recompute) emit(w, "kv.skipload", { podId: pod.id, sid: r.sid, from: "remote", dur, recompute, tokens: far.tokens });
  }
  if (e && e.tier !== "hbm") {
    const from = e.tier;
    const bytes = e.blocks * pod.budget.blockBytes;
    const dur = bytes / tierBw(p)[from];
    const recompute = recomputeTime(e.tokens);
    e.active = true; // pinned: making room below must not push this entry further down
    // loading is adaptive: only when copying the bytes back is faster than prefilling them again
    if (dur <= recompute && makeRoom(w, pod, e.blocks, r, false)) {
      if (from === "dram") pod.dramBlocks -= e.blocks;
      else pod.ssdBlocks -= e.blocks;
      e.tier = "hbm";
      pod.usedBlocks += e.blocks;
      allocCells(pod, e);
      pod.waiting.shift();
      pod.running.push(r.id);
      r.stage = "reload";
      r.stageStart = w.t;
      r.stageEnd = w.t + dur;
      r.admitT = w.t;
      w.m.reloads++;
      emit(w, "kv.reload", { podId: pod.id, sid: r.sid, reqId: r.id, from, bytes, dur, recompute, cells: e.cells.slice(), tokens: e.tokens });
      return true;
    }
    e.active = false;
    if (dur > recompute) emit(w, "kv.skipload", { podId: pod.id, sid: r.sid, from, dur, recompute, tokens: e.tokens });
    dropEntry(w, pod, e, from);
    e = undefined;
  }
  if (!e) {
    e = { sid: r.sid, tokens: 0, blocks: 0, tier: "hbm", active: true, lastUsed: w.t, cells: [] };
    pod.entries.set(r.sid, e);
  }
  if (r.kvReady) {
    // KV computed on a prefill pod has arrived over the network: it only needs blocks to land in
    if (!growTo(w, pod, e, r.kvReady, r, false)) {
      if (e.blocks === 0) pod.entries.delete(r.sid);
      return false;
    }
    r.kvReady = 0;
  }
  // a prefill needs logits at the last prompt position, so at least one token is always computed.
  // A prefix hit is whole blocks only: a block's hash covers all 16 of its tokens.
  const target = r.lIn + r.out;
  const cached = Math.floor(Math.min(e.tokens, target - 1) / BLOCK_TOKENS) * BLOCK_TOKENS;
  // what must fit before the request may join the batch depends on the admission rule
  const need = p.admission === "on-demand" ? cached + Math.min(p.tokenBudget, target - cached) : p.admission === "prompt" ? target : r.lIn + reserveOut;
  if (!growTo(w, pod, e, need, r, false)) {
    if (e.blocks === 0) pod.entries.delete(r.sid);
    else e.tokens = Math.min(e.tokens, target);
    return false;
  }
  e.tokens = cached;
  e.active = true;
  allocCells(pod, e);
  pod.waiting.shift();
  pod.running.push(r.id);
  r.stage = "prefill";
  r.stageStart = w.t;
  r.admitT = w.t;
  r.cached = cached;
  r.prefillDone = cached;
  r.prefillTarget = r.lIn + r.out;
  if (!r.counted) {
    r.counted = true;
    w.m.promptTokens += r.lIn;
    w.m.cachedTokens += cached;
  }
  const turn = (w.sessions.get(r.sid)?.turn ?? 0) + 1;
  emit(w, "req.admitted", { podId: pod.id, sid: r.sid, reqId: r.id, cached, lIn: r.lIn, turn });
  return true;
}

function finish(w: World, pod: Pod, r: Req): void {
  pod.running.splice(pod.running.indexOf(r.id), 1);
  w.reqs.delete(r.id);
  const e = pod.entries.get(r.sid);
  if (e) {
    e.active = false;
    e.lastUsed = w.t;
    shrinkTo(pod, e, e.tokens);
    if (!w.params.prefixCaching) {
      releaseHbm(pod, e);
      pod.entries.delete(r.sid);
    }
  }
  const s = w.sessions.get(r.sid);
  const ttft = r.tFirst - r.tCreate;
  const tpot = r.lOut > 1 ? (w.t - r.tFirst) / (r.lOut - 1) : 0;
  w.m.completed++;
  w.m.ttft.push(ttft);
  w.m.tpot.push(tpot);
  if (w.m.ttft.length > 300) {
    w.m.ttft.shift();
    w.m.tpot.shift();
  }
  if (s) {
    s.reqId = null;
    s.ctxTokens = r.lIn + r.lOut;
    s.turn++;
    s.lastPod = pod.id;
    s.lastTtft = ttft;
    s.lastTpot = tpot;
    const back = s.turn < w.params.maxTurns && rand(w) < w.params.returnProb;
    s.state = back ? "thinking" : "idle";
    s.nextTurnAt = w.t + w.params.thinkTimeS * (0.5 + rand(w));
    w.store.turns++;
    w.store.tokens += r.newTokens + r.lOut;
    emit(w, "store.append", { podId: pod.id, sid: r.sid, tokens: r.newTokens + r.lOut });
    if (!back) emit(w, "session.idle", { podId: pod.id, sid: r.sid, tokens: s.ctxTokens, bytes: kvBytesOf(pod, s.ctxTokens), cached: w.params.prefixCaching });
  }
  emit(w, "req.done", { podId: pod.id, sid: r.sid, reqId: r.id, ttft, tpot, out: r.out });
}

function applyPlan(w: World, pod: Pod): void {
  const emitted: number[] = [];
  let tokens = 0;
  for (const it of pod.plan ?? []) {
    const r = w.reqs.get(it.reqId);
    if (!r || r.podId !== pod.id || !pod.running.includes(r.id)) continue;
    if (it.prefill) {
      if (r.stage !== "prefill") continue;
      r.prefillDone += it.n;
      if (r.prefillDone >= r.prefillTarget && pod.role === "prefill") {
        // disaggregated: this pod's job ends here; the KV goes to a decode pod
        pod.running.splice(pod.running.indexOf(r.id), 1);
        const e = pod.entries.get(r.sid);
        if (e) {
          e.active = false;
          e.lastUsed = w.t;
          shrinkTo(pod, e, e.tokens);
          if (!w.params.prefixCaching) {
            releaseHbm(pod, e);
            pod.entries.delete(r.sid);
          }
        }
        r.stage = "handoff";
        r.stageStart = w.t;
        r.fromPod = pod.id;
        w.handoff.push(r.id);
        continue;
      }
      if (r.prefillDone >= r.prefillTarget) {
        r.stage = "decode";
        if (r.out === 0) {
          r.out = 1;
          r.tFirst = w.t;
          emitted.push(r.sid);
          emit(w, "req.firstToken", { podId: pod.id, sid: r.sid, reqId: r.id, ttft: w.t - r.tCreate });
        }
      }
    } else if (r.stage === "decode") {
      r.out += it.n;
      tokens += it.n - 1;
      emitted.push(r.sid);
    }
    if (r.stage === "decode" && r.out >= r.lOut) finish(w, pod, r);
  }
  pod.plan = null;
  if (emitted.length) {
    tokens += emitted.length;
    pod.tokensOut += tokens;
    w.m.tokensOut += tokens;
    w.tokWindow.push({ t: w.t, n: tokens });
    emit(w, "step.tokens", { podId: pod.id, sids: emitted });
    if (tokens > emitted.length) emit(w, "step.spec", { podId: pod.id, tokens, seqs: emitted.length, k: w.params.specK });
  }
}

function planStep(w: World, pod: Pod): void {
  const p = w.params;
  const m = pod.spec.model;
  const items: PlanItem[] = [];
  let used = 0;
  let flops = 0;
  let kvBytes = 0;
  let decodeTok = 0;
  let prefillTok = 0;
  const preemptedBefore = w.m.preemptions;
  // static batching: nobody joins until the whole batch has finished
  const open = p.batching === "continuous" || pod.running.length === 0;

  // decode first: one token for every running sequence that has finished its prompt
  for (const id of pod.running.slice()) {
    const r = w.reqs.get(id)!;
    if (r.stage !== "decode" || !pod.running.includes(id)) continue;
    const e = pod.entries.get(r.sid)!;
    const ctx = r.lIn + r.out;
    // speculative decoding: a small draft model proposes k tokens, the target checks them all in this one pass
    // and keeps the agreeing prefix plus one of its own
    let n = 1;
    if (p.specDecode) while (n <= p.specK && rand(w) < p.specAccept) n++;
    n = Math.min(n, r.lOut - r.out);
    if (!growTo(w, pod, e, ctx + n, r, true)) {
      preempt(w, pod, r, "KV memory short");
      continue;
    }
    const l = seqLoad(m, ctx, p.specDecode ? p.specK + 1 : 1);
    flops += l.flops;
    kvBytes += l.kvBytes;
    items.push({ reqId: id, n, prefill: false });
    used++;
    decodeTok += n;
  }
  const chunk = (r: Req) => {
    const n = Math.min(p.tokenBudget - used, r.prefillTarget - r.prefillDone);
    if (n <= 0) return;
    const e = pod.entries.get(r.sid)!;
    if (!growTo(w, pod, e, r.prefillDone + n, r, p.admission === "on-demand")) {
      // on-demand allocation: a running prompt that cannot get its next blocks and is itself the newest yields
      if (p.admission === "on-demand" && pod.running.length > 1) preempt(w, pod, r, "no blocks for the next prefill chunk");
      return;
    }
    const l = seqLoad(m, r.prefillDone, n);
    flops += l.flops;
    kvBytes += l.kvBytes;
    items.push({ reqId: r.id, n, prefill: true });
    used += n;
    prefillTok += n;
  };
  // then fill the token budget with prefill chunks: running prompts first, then new admissions
  for (const id of pod.running.slice()) {
    const r = w.reqs.get(id)!;
    if (!pod.running.includes(id)) continue;
    if (r.stage === "reload" && w.t >= r.stageEnd) {
      r.stage = "prefill";
      r.stageStart = w.t;
      const e = pod.entries.get(r.sid)!;
      r.cached = Math.floor(Math.min(e.tokens, r.lIn + r.out - 1) / BLOCK_TOKENS) * BLOCK_TOKENS;
      e.tokens = r.cached;
      r.prefillDone = r.cached;
      r.prefillTarget = r.lIn + r.out;
      if (!r.counted) {
        r.counted = true;
        w.m.promptTokens += r.lIn;
        w.m.cachedTokens += r.cached;
      }
      emit(w, "req.admitted", { podId: pod.id, sid: r.sid, reqId: r.id, cached: r.cached, lIn: r.lIn });
    }
    if (r.stage === "prefill" && used < p.tokenBudget) chunk(r);
  }
  // as in vLLM, nothing new is admitted in a step that had to preempt
  while (open && w.m.preemptions === preemptedBefore && pod.waiting.length && pod.running.length < p.maxNumSeqs && (used < p.tokenBudget || p.batching === "static")) {
    const r = w.reqs.get(pod.waiting[0]!)!;
    if (!admit(w, pod, r)) break;
    if (r.stage === "prefill") chunk(r);
  }

  if (!items.length) {
    // every running prompt is stalled on memory: give one's blocks back so the others can finish
    const stuck = pod.running.map((id) => w.reqs.get(id)!).filter((r) => r.stage === "prefill");
    if (stuck.length > 1 && stuck.length === pod.running.length) {
      preempt(w, pod, stuck.reduce((a, b) => (b.admitT > a.admitT ? b : a)), "prefill stalled on KV memory");
    }
    pod.stepEnd = w.t + 0.002;
    return;
  }
  const bytes = weightBytes(m, pod.spec.precision) + kvBytes;
  const cost = stepCost(pod.spec, { tokens: used, flops, bytes }, p.mbu, p.mfu);
  const tCpu = (p.hostMsBase + p.hostMsPerSeq * items.length) / 1e3;
  // the draft model runs k small sequential steps before the target's pass
  const tDraft = p.specDecode && decodeTok > 0 ? p.specK * p.specCost * cost.tGpu : 0;
  const dur = (p.overlap ? Math.max(tCpu, cost.tGpu) : tCpu + cost.tGpu) + tDraft;
  pod.plan = items;
  pod.stepStart = w.t;
  pod.stepEnd = w.t + dur;
  pod.steps++;
  pod.last = { ...cost, tCpu, dur, bytes, flops, batch: items.length, decodeTok, prefillTok };
  if (prefillTok === 0) pod.decodeDur = dur;
  else if (decodeTok >= 2 && prefillTok >= 512) emit(w, "step.mixed", { podId: pod.id, decodeTok, prefillTok, dur, decodeDur: pod.decodeDur, intensity: cost.intensity });
}

/* ------------------------------------------------------------------ fleet */

function createPod(w: World): Pod {
  const spec = replicaSpec(w.params);
  const used = new Set(w.pods.map((p) => p.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  const live = livePods(w);
  const prefills = live.filter((x) => x.role === "prefill").length;
  const role: Role = !w.params.disagg ? "both" : prefills < Math.max(1, Math.round((live.length + 1) * w.params.prefillShare)) ? "prefill" : "decode";
  const pod: Pod = {
    id: w.nextPod++,
    slot,
    role,
    state: "creating",
    born: w.t,
    stateSince: w.t,
    loadProgress: 0,
    spec,
    budget: memoryBudget(spec),
    waiting: [],
    running: [],
    inbound: 0,
    stepStart: 0,
    stepEnd: 0,
    plan: null,
    last: null,
    steps: 0,
    entries: new Map(),
    cells: new Int32Array(CELLS),
    freeCells: CELLS,
    usedBlocks: 0,
    dramBlocks: 0,
    ssdBlocks: 0,
    idleSince: w.t,
    tokensOut: 0,
    decodeDur: 0
  };
  w.pods.push(pod);
  emit(w, "pod.created", { podId: pod.id });
  return pod;
}

function setPodState(w: World, pod: Pod, state: PodState): void {
  pod.state = state;
  pod.stateSince = w.t;
  emit(w, `pod.${state}`, { podId: pod.id });
}

function requeue(w: World, r: Req): void {
  r.stage = "queued";
  r.stageStart = w.t;
  r.podId = -1;
  r.prefillDone = 0;
  r.cached = 0;
  r.kvReady = 0;
  w.gatewayQueue.push(r.id);
}

/** Tear down every pod (model, GPU or memory settings changed). In-flight requests go back to the gateway. */
export function restartFleet(w: World): void {
  for (const pod of w.pods) {
    for (const id of [...pod.running, ...pod.waiting]) requeue(w, w.reqs.get(id)!);
    pod.running = [];
    pod.waiting = [];
    pod.plan = null;
    if (pod.state !== "terminated") setPodState(w, pod, "terminated");
  }
  for (const r of w.reqs.values()) {
    if (r.stage === "toPod" || r.stage === "transfer" || r.stage === "handoff") requeue(w, r);
  }
  w.handoff = [];
  emit(w, "fleet.restart");
}

function inFlight(w: World): number {
  return w.reqs.size;
}

function autoscale(w: World): void {
  const p = w.params;
  const live = livePods(w);
  const failed = w.pods.some((x) => x.state === "failed");
  let desired = Math.max(p.minPods, Math.min(p.maxPods, Math.ceil(inFlight(w) / Math.max(1, p.maxNumSeqs))));
  if (p.disagg && inFlight(w) > 0) desired = Math.max(2, desired);
  if (live.length < desired && !failed) {
    const from = live.length;
    for (let i = live.length; i < desired; i++) createPod(w);
    emit(w, "scale.up", { from, to: desired, demand: inFlight(w), perPod: p.maxNumSeqs });
  }
  let n = live.length;
  for (const pod of live) {
    if (n <= Math.max(desired, p.minPods)) break;
    if (pod.state === "ready" && podLoad(pod) === 0 && w.t - pod.idleSince > p.scaleDownIdleS) {
      setPodState(w, pod, "draining");
      emit(w, "scale.down", { podId: pod.id, idle: w.t - pod.idleSince });
      n--;
    }
  }
}

function tickPod(w: World, pod: Pod): void {
  const p = w.params;
  const age = w.t - pod.stateSince;
  switch (pod.state) {
    case "creating":
      if (age > 0.25 * p.coldStartS) setPodState(w, pod, pod.budget.fits ? "loading" : "failed");
      return;
    case "loading":
      pod.loadProgress = Math.min(1, age / (0.75 * p.coldStartS));
      if (pod.loadProgress >= 1) {
        pod.idleSince = w.t;
        setPodState(w, pod, "ready");
      }
      return;
    case "draining":
      if (age > 0.5) setPodState(w, pod, "terminated");
      return;
    case "ready":
      break;
    default:
      return;
  }
  if (w.t < pod.stepEnd) return;
  // Steps end between clock ticks. Finish each at its exact end time and start the next from there,
  // so step time is not rounded up to the tick.
  const now = w.t;
  for (let guard = 0; guard < 64; guard++) {
    if (pod.plan) {
      w.t = pod.stepEnd;
      applyPlan(w, pod);
    }
    if (!pod.running.length && !pod.waiting.length) break;
    pod.idleSince = w.t;
    planStep(w, pod);
    if (!pod.plan || pod.stepEnd > now) break;
  }
  w.t = now;
}

function route(w: World, r: Req): boolean {
  const p = w.params;
  // while replicas are still starting, hold the overflow at the gateway instead of queueing it behind a full pod
  const starting = w.pods.some((x) => x.state === "creating" || x.state === "loading");
  const room = p.maxNumSeqs + (starting ? 0 : QUEUE_SLACK);
  const ready = w.pods.filter((x) => x.state === "ready" && podLoad(x) < room);
  const tierWeight = { hbm: 1, dram: 0.7, ssd: 0.4, remote: 0.25 } as const;
  const score = (pods: Pod[]) =>
    pods.map((pod) => {
      const e = pod.entries.get(r.sid);
      const far = e ? undefined : w.remote.get(r.sid);
      const tier: Tier | "remote" | null = e ? e.tier : far ? "remote" : null;
      const cache = tier && r.lIn > 0 ? Math.min(1, (e ? e.tokens : far!.tokens) / r.lIn) : 0;
      const load = podLoad(pod);
      // llm-d's recommended profile: prefix-cache scorer (weight 3), KV-cache-utilisation scorer (2), queue scorer (2).
      // The load term here counts running as well as queued requests.
      const kvUtil = pod.budget.poolBlocks ? activeBlocks(pod) / pod.budget.poolBlocks : 1;
      const sc = p.routing === "prefix-aware" ? 3 * cache * (tier ? tierWeight[tier] : 0) + 2 * (1 - kvUtil) + 2 * (1 - load / (p.maxNumSeqs + QUEUE_SLACK)) : -load;
      return { podId: pod.id, load, cache, tier, score: sc };
    });
  const pick = (cands: ReturnType<typeof score>) => {
    let best = cands[0]!;
    if (p.routing === "round-robin") best = cands[w.rr++ % cands.length]!;
    else for (const c of cands) if (c.score > best.score) best = c;
    return best;
  };
  let candidates = score(p.disagg ? ready.filter((x) => x.role !== "prefill") : ready);
  if (!candidates.length) return false;
  let chosen = pick(candidates);
  let via = "direct";
  if (p.disagg) {
    // pick the decode pod first; go through the prefill pool only if enough of the prompt is not cached there
    const uncached = r.lIn - (chosen.tier === "hbm" ? chosen.cache * r.lIn : 0);
    if (uncached > p.pdThreshold) {
      const pre = score(ready.filter((x) => x.role === "prefill"));
      if (!pre.length) return false;
      candidates = pre;
      chosen = pick(pre);
      via = "prefill";
    } else via = "decode-only";
  }
  const pod = w.pods.find((x) => x.id === chosen.podId)!;
  pod.inbound++;
  r.podId = pod.id;
  r.stage = "toPod";
  r.stageStart = w.t;
  r.stageEnd = w.t + HOP.toPod;
  w.lastRoute = { t: w.t, sid: r.sid, chosen: pod.id, policy: p.routing, candidates };
  emit(w, "req.routed", { podId: pod.id, sid: r.sid, reqId: r.id, cache: chosen.cache, tier: chosen.tier, load: chosen.load, n: candidates.length, via, role: pod.role });
  return true;
}

/** Disaggregated serving: move a finished prefill's KV to a decode pod over the network. */
function handoffs(w: World): void {
  const p = w.params;
  while (w.handoff.length) {
    const r = w.reqs.get(w.handoff[0]!);
    if (!r || r.stage !== "handoff") {
      w.handoff.shift();
      continue;
    }
    let best: Pod | null = null;
    for (const pod of w.pods) {
      if (pod.state !== "ready" || pod.role === "prefill" || podLoad(pod) >= p.maxNumSeqs + QUEUE_SLACK) continue;
      const has = pod.entries.get(r.sid)?.tier === "hbm";
      if (!best || (has ? -1 : podLoad(pod)) < (best.entries.get(r.sid)?.tier === "hbm" ? -1 : podLoad(best))) best = pod;
    }
    if (!best) return;
    w.handoff.shift();
    const have = best.entries.get(r.sid);
    const tokens = r.lIn + r.out;
    const bytes = Math.max(0, tokens - (have?.tier === "hbm" ? have.tokens : 0)) * kvBytesPerToken(best.spec.model);
    const dur = bytes / ((p.linkGbps / 8) * 1e9);
    best.inbound++;
    r.podId = best.id;
    r.stage = "transfer";
    r.stageStart = w.t;
    r.stageEnd = w.t + dur;
    r.kvReady = tokens;
    emit(w, "kv.transfer", { podId: best.id, from: r.fromPod, sid: r.sid, reqId: r.id, bytes, dur, tokens });
  }
}

function tick(w: World, h: number): void {
  const p = w.params;
  if (p.arrivalRate > 0) {
    w.arrivalAcc += p.arrivalRate * h;
    while (w.arrivalAcc >= 1) {
      w.arrivalAcc -= 1;
      newSession(w);
    }
  }
  while (w.pending.length && w.pending[0]! <= w.t) {
    w.pending.shift();
    newSession(w);
  }
  for (const s of w.sessions.values()) {
    if (s.state === "thinking" && w.t >= s.nextTurnAt) newRequest(w, s);
  }
  for (const r of w.reqs.values()) {
    if (w.t < r.stageEnd) continue;
    if (r.stage === "send") {
      r.stage = "tokenize";
      r.stageStart = w.t;
      r.stageEnd = w.t + HOP.tokenizeBase + HOP.tokenizePerTok * r.lIn;
      w.seen.tokenizer = true;
      if (r.lIn > r.newTokens) emit(w, "store.read", { sid: r.sid, reqId: r.id, history: r.lIn - r.newTokens });
    } else if (r.stage === "tokenize") {
      r.stage = "toGateway";
      r.stageStart = w.t;
      r.stageEnd = w.t + HOP.toGateway;
      emit(w, "req.tokenized", { sid: r.sid, reqId: r.id, lIn: r.lIn, newTokens: r.newTokens });
    } else if (r.stage === "toGateway") {
      r.stage = "queued";
      r.stageStart = w.t;
      w.seen.gateway = true;
      w.gatewayQueue.push(r.id);
      emit(w, "req.queued", { sid: r.sid, reqId: r.id });
    } else if (r.stage === "toPod" || r.stage === "transfer") {
      const pod = w.pods.find((x) => x.id === r.podId);
      if (!pod || pod.state !== "ready") {
        requeue(w, r);
        continue;
      }
      pod.inbound--;
      pod.waiting.push(r.id);
      r.stage = "waiting";
      r.stageStart = w.t;
    }
  }
  autoscale(w);
  while (w.gatewayQueue.length) {
    const r = w.reqs.get(w.gatewayQueue[0]!);
    if (r && p.shedAfterS > 0 && w.t - r.stageStart > p.shedAfterS) {
      // flow control: better a fast 429 than an answer that arrives after its deadline
      w.gatewayQueue.shift();
      failReq(w, null, r, `shed after waiting ${p.shedAfterS} s at the router (HTTP 429)`);
      continue;
    }
    if (r && !route(w, r)) break;
    w.gatewayQueue.shift();
  }
  if (w.handoff.length) handoffs(w);
  for (const pod of w.pods) tickPod(w, pod);
  for (let i = w.pods.length - 1; i >= 0; i--) {
    const pod = w.pods[i]!;
    if (pod.state === "terminated" && w.t - pod.stateSince > 0.25) w.pods.splice(i, 1);
  }
  w.m.gpuSeconds += livePods(w).length * p.tp * h;
  if (w.t - w.lastChurn >= 6 && w.sessions.size >= 8) {
    w.lastChurn = w.t;
    let typing = 0;
    let idle = 0;
    let first = 0;
    for (const s of w.sessions.values()) {
      if (!first) first = s.id;
      if (s.state === "thinking") typing++;
      else if (s.state === "idle") idle++;
    }
    emit(w, "churn", { sid: first, rate: p.arrivalRate, active: w.reqs.size, typing, idle, total: w.sessions.size });
  }
  if (w.t - w.lastSample >= 0.1) {
    w.lastSample = w.t;
    while (w.tokWindow.length && w.tokWindow[0]!.t < w.t - 1) w.tokWindow.shift();
    w.history.push({ t: w.t, tokS: tokensPerSecond(w), inflight: w.reqs.size, pods: livePods(w).length, kvFill: kvFill(w) });
    if (w.history.length > 240) w.history.shift();
  }
}

export function advance(w: World, dt: number): void {
  let rem = dt;
  while (rem > 1e-9) {
    const h = Math.min(rem, 0.002);
    w.t += h;
    tick(w, h);
    rem -= h;
  }
}

/** Apply a parameter change while the simulation runs. */
export function setParam<K extends keyof Params>(w: World, key: K, value: Params[K]): void {
  if (w.params[key] === value) return;
  w.params[key] = value;
  if (RESTART_KEYS.includes(key)) restartFleet(w);
}

/* ------------------------------------------------------------------ selectors */

export function tokensPerSecond(w: World): number {
  let n = 0;
  for (const b of w.tokWindow) if (b.t >= w.t - 1) n += b.n;
  return n;
}

export function kvFill(w: World): number {
  let used = 0;
  let pool = 0;
  for (const pod of w.pods) {
    if (pod.state !== "ready") continue;
    used += pod.usedBlocks;
    pool += pod.budget.poolBlocks;
  }
  return pool ? used / pool : 0;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export function costPerMTok(w: World): number {
  return w.m.tokensOut ? ((w.m.gpuSeconds * w.params.pricePerGpuHour) / 3600 / w.m.tokensOut) * 1e6 : 0;
}

export function activeBlocks(pod: Pod): number {
  let n = 0;
  for (const e of pod.entries.values()) if (e.tier === "hbm" && e.active) n += e.blocks;
  return n;
}

export const kvBytesOf = (pod: Pod, tokens: number) => tokens * kvBytesPerToken(pod.spec.model);
