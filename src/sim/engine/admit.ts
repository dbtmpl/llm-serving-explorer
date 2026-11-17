/**
 * Admission: taking a request from a pod's waiting queue into its running batch.
 */
import { admissionRule } from "../admission/index.js";
import type { KvEntry, Pod, Req, Tier, World } from "../core/types.js";
import { emit } from "../core/world.js";
import { seqLoad } from "../cost/flops.js";
import { computeSeconds } from "../cost/roofline.js";
import { blocksFor } from "../kvcache/blocks.js";
import { syncCells } from "../kvcache/hbm.js";
import { growTo, makeRoom } from "../kvcache/pool.js";
import { blockHashPrefix } from "../kvcache/prefix.js";
import { adaptiveReload } from "../kvcache/reload.js";
import { dropEntry, tierBw } from "../kvcache/tiers.js";

/** The policies in use. With a second approach each becomes a parameter. */
export const PREFIX_MATCHER = blockHashPrefix;
export const RELOAD = adaptiveReload;

/** A request leaves the system without an answer. */
export function failReq(w: World, pod: Pod | null, r: Req, why: string): void {
  w.reqs.delete(r.id);
  const s = w.sessions.get(r.sid);
  if (s) {
    s.reqId = null;
    s.state = "idle";
  }
  w.m.failed++;
  emit(w, "req.failed", { podId: pod?.id, sid: r.sid, reqId: r.id, why });
}

/** Start prefilling: fix how much of the context the prefix cache serves, and count it once. */
export function beginPrefill(w: World, r: Req, e: KvEntry): void {
  const context = r.lIn + r.out;
  r.cached = PREFIX_MATCHER.reusableTokens(e.tokens, context);
  e.tokens = r.cached;
  r.stage = "prefill";
  r.stageStart = w.t;
  r.prefillDone = r.cached;
  r.prefillTarget = context;
  if (!r.counted) {
    r.counted = true;
    w.m.promptTokens += r.lIn;
    w.m.cachedTokens += r.cached;
  }
}

/** Move a request from waiting to running while its KV is copied back into GPU memory. */
function beginReload(w: World, pod: Pod, r: Req, e: KvEntry, from: Tier | "remote", bytes: number, dur: number, recompute: number): void {
  pod.waiting.shift();
  pod.running.push(r.id);
  r.stage = "reload";
  r.stageStart = w.t;
  r.stageEnd = w.t + dur;
  r.admitT = w.t;
  w.m.reloads++;
  emit(w, "kv.reload", { podId: pod.id, sid: r.sid, reqId: r.id, from, bytes, dur, recompute, cells: e.cells.slice(), tokens: e.tokens });
}

/**
 * Try to admit the request at the head of the pod's queue. Returns false when it has to wait for
 * memory. A request that can never fit is failed and counts as handled.
 */
export function admit(w: World, pod: Pod, r: Req): boolean {
  const p = w.params;
  const rule = admissionRule(p.admission);
  const reservedOutput = rule.outputReservation({ outputTokens: r.lOut, maxTokensCap: p.maxTokensCap });
  if (blocksFor(r.lIn + reservedOutput) > pod.budget.poolBlocks) {
    pod.waiting.shift();
    failReq(w, pod, r, "context exceeds the KV pool");
    return true;
  }
  let e = pod.entries.get(r.sid);
  const recomputeSeconds = (tokens: number) => computeSeconds(pod.spec, seqLoad(pod.spec.model, 0, tokens).flops, p, tokens);

  // A copy in the shared pool can be loaded by any pod.
  const far = !e && p.prefixCaching ? w.remote.get(r.sid) : undefined;
  if (far) {
    const dur = far.bytes / tierBw(p).remote;
    const recompute = recomputeSeconds(far.tokens);
    const blocks = blocksFor(far.tokens);
    if (RELOAD.shouldLoad(dur, recompute) && makeRoom(w, pod, blocks, r, false)) {
      // making room may itself have pushed this copy out of the pool; it is in hand either way
      if (w.remote.delete(r.sid)) w.remoteBytes -= far.bytes;
      e = { sid: r.sid, tokens: far.tokens, blocks, tier: "hbm", active: true, lastUsed: w.t, cells: [] };
      pod.entries.set(r.sid, e);
      pod.usedBlocks += blocks;
      syncCells(pod, e);
      beginReload(w, pod, r, e, "remote", far.bytes, dur, recompute);
      return true;
    }
    if (!RELOAD.shouldLoad(dur, recompute)) emit(w, "kv.skipload", { podId: pod.id, sid: r.sid, from: "remote", dur, recompute, tokens: far.tokens });
  }

  // A copy in this node's DRAM or SSD.
  if (e && e.tier !== "hbm") {
    const from = e.tier;
    const bytes = e.blocks * pod.budget.blockBytes;
    const dur = bytes / tierBw(p)[from];
    const recompute = recomputeSeconds(e.tokens);
    e.active = true; // pinned: making room below must not push this entry further down
    if (RELOAD.shouldLoad(dur, recompute) && makeRoom(w, pod, e.blocks, r, false)) {
      if (from === "dram") pod.dramBlocks -= e.blocks;
      else pod.ssdBlocks -= e.blocks;
      e.tier = "hbm";
      pod.usedBlocks += e.blocks;
      syncCells(pod, e);
      beginReload(w, pod, r, e, from, bytes, dur, recompute);
      return true;
    }
    e.active = false;
    if (!RELOAD.shouldLoad(dur, recompute)) emit(w, "kv.skipload", { podId: pod.id, sid: r.sid, from, dur, recompute, tokens: e.tokens });
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

  const context = r.lIn + r.out;
  const cached = PREFIX_MATCHER.reusableTokens(e.tokens, context);
  const secure = rule.tokensToSecure({
    promptTokens: r.lIn,
    generatedTokens: r.out,
    outputTokens: r.lOut,
    maxTokensCap: p.maxTokensCap,
    cachedTokens: cached,
    tokenBudget: p.tokenBudget
  });
  // vLLM's full-sequence gate: the whole input sequence must fit beside what the other running sequences hold
  const fit = rule.tokensToFit({ promptTokens: r.lIn, generatedTokens: r.out, outputTokens: r.lOut, maxTokensCap: p.maxTokensCap, cachedTokens: cached, tokenBudget: p.tokenBudget });
  let heldByOthers = 0;
  for (const o of pod.entries.values()) if (o !== e && o.tier === "hbm" && o.active) heldByOthers += o.blocks;
  const fits = blocksFor(fit) + heldByOthers <= pod.budget.poolBlocks;
  if (!fits || !growTo(w, pod, e, secure, r, false)) {
    if (e.blocks === 0) pod.entries.delete(r.sid);
    else e.tokens = Math.min(e.tokens, context);
    return false;
  }
  e.tokens = cached;
  e.active = true;
  syncCells(pod, e);
  pod.waiting.shift();
  pod.running.push(r.id);
  r.admitT = w.t;
  beginPrefill(w, r, e);
  const turn = (w.sessions.get(r.sid)?.turn ?? 0) + 1;
  emit(w, "req.admitted", { podId: pod.id, sid: r.sid, reqId: r.id, cached, lIn: r.lIn, turn });
  return true;
}
