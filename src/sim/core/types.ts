/**
 * State of the simulated system. Plain data only: behaviour lives in the modules that own it.
 */
import type { MemoryBudget } from "../cost/memory.js";
import type { StepCost } from "../cost/roofline.js";
import type { PodRole } from "../disaggregation/index.js";
import type { ReplicaSpec } from "../hardware/catalog.js";
import type { CacheLocation, RoutingId } from "../routing/index.js";
import type { TraceRequest } from "../workload/trace.js";
import type { Params } from "./params.js";

/** Memory tiers on a pod's own node, fastest first. */
export type Tier = "hbm" | "dram" | "ssd";

/** Where a request is on its way through the stack. */
export type Stage = "send" | "tokenize" | "toGateway" | "queued" | "toPod" | "waiting" | "reload" | "prefill" | "handoff" | "transfer" | "decode";

/** One session's KV cache on one pod. */
export interface KvEntry {
  sid: number;
  /** Tokens whose KV is written. */
  tokens: number;
  /** Blocks held, including reserved but unwritten ones. */
  blocks: number;
  tier: Tier;
  /** In use by a running request, and therefore not evictable. */
  active: boolean;
  lastUsed: number;
  /** Display cells this entry occupies in the pod's block grid. */
  cells: number[];
}

export interface Req {
  id: number;
  sid: number;
  /** Prompt tokens including conversation history. */
  lIn: number;
  /** Prompt tokens that are new in this turn. */
  newTokens: number;
  /** Output tokens this request will produce. */
  lOut: number;
  stage: Stage;
  stageStart: number;
  stageEnd: number;
  podId: number;
  prefillDone: number;
  prefillTarget: number;
  /** Prompt tokens served from the prefix cache. */
  cached: number;
  /** Output tokens produced so far. */
  out: number;
  tCreate: number;
  tFirst: number;
  admitT: number;
  preemptions: number;
  /** Which sample prompt the interface shows for this request. */
  promptIdx: number;
  /** Tokens of KV that arrived from a prefill pod and only need blocks to land in. */
  kvReady: number;
  /** Whether its prompt has been added to the prefix-hit statistics. */
  counted: boolean;
  fromPod: number;
}

export interface Session {
  id: number;
  /** The conversation's number in the trace it was injected from, when it came from one. */
  traceId?: number;
  hue: number;
  turn: number;
  /** Tokens of conversation so far. */
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
  /** Host time of the step, seconds. */
  tCpu: number;
  /** Wall-clock time of the step, seconds. */
  dur: number;
  bytes: number;
  flops: number;
  batch: number;
  decodeTok: number;
  prefillTok: number;
}

export type PodState = "creating" | "loading" | "ready" | "draining" | "terminated" | "failed";

/** One sequence's share of a planned engine step. */
export interface PlanItem {
  reqId: number;
  /** Tokens it gains when the step completes. */
  n: number;
  prefill: boolean;
}

export type Role = PodRole;

export interface Pod {
  id: number;
  /** Position in the interface's pod grid. */
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
  /** Requests routed here that have not arrived yet. */
  inbound: number;
  stepStart: number;
  stepEnd: number;
  plan: PlanItem[] | null;
  last: StepInfo | null;
  steps: number;
  entries: Map<number, KvEntry>;
  /** Display grid of the KV pool: session id per cell, 0 when free. */
  cells: Int32Array;
  freeCells: number;
  usedBlocks: number;
  dramBlocks: number;
  ssdBlocks: number;
  idleSince: number;
  tokensOut: number;
  /** Duration of the last decode-only step, to show what a prefill chunk costs running streams. */
  decodeDur: number;
}

export interface RouteDecision {
  t: number;
  sid: number;
  /** The request this decision was made for. */
  reqId: number;
  chosen: number;
  policy: RoutingId;
  /** Load at which a pod counts as full (`max_num_seqs` plus the queue slack). */
  capacity: number;
  /** The policy's carried state before this decision (the round-robin counter). */
  cursor: number;
  candidates: { podId: number; load: number; cache: number; tier: CacheLocation | null; kvUtilisation: number; score: number }[];
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

/** A session's KV held in the pool shared by all pods. */
export interface RemoteEntry {
  sid: number;
  tokens: number;
  bytes: number;
  lastUsed: number;
}

export interface World {
  /** Simulated seconds. */
  t: number;
  params: Params;
  sessions: Map<number, Session>;
  reqs: Map<number, Req>;
  pods: Pod[];
  gatewayQueue: number[];
  /** Arrival times of sessions scheduled by a burst. */
  pending: number[];
  /** Requests of a trace not yet sent, in time order (see workload/trace.ts). */
  trace: TraceRequest[];
  events: SimEvent[];
  lastRoute: RouteDecision | null;
  /** The most recent routing decisions, newest last, so the interface can explain one after others were made. */
  routeLog: RouteDecision[];
  m: Metrics;
  history: Sample[];
  /** Routing policy state carried between decisions (the round-robin position). */
  rr: number;
  nextId: number;
  nextPod: number;
  seed: number;
  arrivalAcc: number;
  tokWindow: { t: number; n: number }[];
  lastSample: number;
  /**
   * Simulated time at which the first request was sent; null until then. The visible clock and the
   * time-based statistics (GPU-seconds, the history charts) count from here, so an empty page does
   * not run a clock. Pods that are meant to be warm still load their weights before it.
   */
  startedAt: number | null;
  /** Whether any request has ever reached this stage of the graph. */
  seen: { tokenizer: boolean; gateway: boolean };
  /** Conversation store: the text of every turn, the record every KV tier is derived from. */
  store: { turns: number; tokens: number };
  remote: Map<number, RemoteEntry>;
  remoteBytes: number;
  lastChurn: number;
  /** Requests whose prefill is done and that wait for a decode pod to take their KV. */
  handoff: number[];
}
