/**
 * The engine step loop of one pod: decide what the next forward pass contains, price it, and
 * apply its results when it completes.
 *
 * Order within a step follows vLLM's V1 scheduler (vLLM source, scheduler.py): running sequences
 * are scheduled first, decodes before prefills, and the rest of the per-step token budget is
 * filled with prefill chunks (chunked prefill: Agrawal et al., OSDI 2024). Nothing new is admitted
 * in a step that had to preempt.
 */
import { admissionRule } from "../admission/index.js";
import { batchingMode } from "../batching/index.js";
import type { Pod, Req, World } from "../core/types.js";
import { emit, rand } from "../core/world.js";
import { seqLoad } from "../cost/flops.js";
import { hostSeconds, stepSeconds } from "../cost/host.js";
import { kvBytesPerToken, weightBytes } from "../cost/memory.js";
import { stepCost } from "../cost/roofline.js";
import { decodeStrategy, type DecodeSettings } from "../decoding/index.js";
import { releaseHbm, shrinkTo } from "../kvcache/hbm.js";
import { growTo, preempt } from "../kvcache/pool.js";
import { thinkSeconds } from "../workload/index.js";
import { admit, beginPrefill } from "./admit.js";
import { IDLE_RETRY_S, LATENCY_WINDOW, MIXED_STEP } from "./constants.js";

const decodeSettings = (w: World): DecodeSettings => ({ draftTokens: w.params.specK, acceptance: w.params.specAccept, draftCost: w.params.specCost });

/** A sequence stops running on this pod; its KV stays cached if prefix caching is on. */
function retireEntry(w: World, pod: Pod, r: Req): void {
  const e = pod.entries.get(r.sid);
  if (!e) return;
  e.active = false;
  e.lastUsed = w.t;
  shrinkTo(pod, e, e.tokens);
  if (!w.params.prefixCaching) {
    releaseHbm(pod, e);
    pod.entries.delete(r.sid);
  }
}

/**
 * What a finished request leaves in the prefix cache: its prompt and answer except the last token.
 *
 * Source: vLLM's `allocate_slots` caches blocks up to `min(computed + scheduled, request.num_tokens)`
 * (vllm/v1/core/kv_cache_manager.py), and a token's KV is computed only when the token is fed to the model
 * in a step. The last token of the answer is sampled by the final step but never fed to the model, because
 * the request finishes with it. So after a turn the cache holds `prompt + output - 1` tokens, in whole blocks.
 * (BLIS's translation does the same: core/kv/manager.go, `min(mainModel, a.NumTokens)`.)
 *
 * Example: a turn of 860 prompt tokens and 20 answer tokens ends with 879 tokens of KV, so 54 blocks are
 * cached (864 tokens), not 55. A follow-up whose history is those 880 tokens reuses 864 and prefills 16 more
 * plus its new message, where counting the last token would reuse 880.
 *
 * A decode step allocates for `computed + scheduled` tokens, as vLLM does, so a finished entry already holds
 * exactly this many; the cap is a guard for the last step.
 */
export const cachedAfterTurn = (promptTokens: number, outputTokens: number): number => promptTokens + outputTokens - 1;

function finish(w: World, pod: Pod, r: Req): void {
  pod.running.splice(pod.running.indexOf(r.id), 1);
  w.reqs.delete(r.id);
  const entry = pod.entries.get(r.sid);
  if (entry) entry.tokens = Math.min(entry.tokens, cachedAfterTurn(r.lIn, r.lOut));
  retireEntry(w, pod, r);
  const s = w.sessions.get(r.sid);
  const ttft = r.tFirst - r.tCreate;
  const tpot = r.lOut > 1 ? (w.t - r.tFirst) / (r.lOut - 1) : 0;
  w.m.completed++;
  w.m.ttft.push(ttft);
  w.m.tpot.push(tpot);
  if (w.m.ttft.length > LATENCY_WINDOW) {
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
    const back = !s.closing && s.turn < w.params.maxTurns && rand(w) < w.params.returnProb;
    s.state = back ? "thinking" : "idle";
    s.nextTurnAt = w.t + thinkSeconds(w);
    w.store.turns++;
    w.store.tokens += r.newTokens + r.lOut;
    emit(w, "store.append", { podId: pod.id, sid: r.sid, tokens: r.newTokens + r.lOut });
    if (!back) emit(w, "session.idle", { podId: pod.id, sid: r.sid, tokens: s.ctxTokens, bytes: s.ctxTokens * kvBytesPerToken(pod.spec.model), cached: w.params.prefixCaching });
  }
  emit(w, "req.done", { podId: pod.id, sid: r.sid, reqId: r.id, ttft, tpot, out: r.out });
}

/** The step that was planned has completed: hand out its tokens. */
export function applyPlan(w: World, pod: Pod): void {
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
        retireEntry(w, pod, r);
        r.stage = "handoff";
        r.stageStart = w.t;
        r.fromPod = pod.id;
        w.handoff.push(r.id);
        continue;
      }
      if (r.prefillDone >= r.prefillTarget) {
        r.stage = "decode";
        if (r.out === 0) {
          // the last prefill position yields the first output token
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

/** Decide the contents of the pod's next forward pass and when it will complete. */
export function planStep(w: World, pod: Pod): void {
  const p = w.params;
  const m = pod.spec.model;
  const batching = batchingMode(p.batching);
  const admission = admissionRule(p.admission);
  const decoding = decodeStrategy(p.specDecode ? "speculative" : "autoregressive");
  const settings = decodeSettings(w);
  const items: NonNullable<Pod["plan"]> = [];
  let used = 0;
  let flops = 0;
  let kvBytes = 0;
  let decodeTok = 0;
  let prefillTok = 0;
  const preemptedBefore = w.m.preemptions;
  const open = batching.admitsInto(pod.running.length);

  // 1. decode: every running sequence that has finished its prompt
  for (const id of pod.running.slice()) {
    const r = w.reqs.get(id)!;
    if (r.stage !== "decode" || !pod.running.includes(id)) continue;
    const e = pod.entries.get(r.sid)!;
    const context = r.lIn + r.out;
    const n = Math.min(
      decoding.tokensThisStep(() => rand(w), settings),
      r.lOut - r.out
    );
    // The step feeds the last sampled token (its KV is computed now) and n - 1 further ones, so `n` slots beyond the
    // `context - 1` positions already computed. vLLM allocates for exactly those (allocate_slots: computed + scheduled).
    if (!growTo(w, pod, e, context - 1 + n, r, true)) {
      preempt(w, pod, r, "KV memory short");
      continue;
    }
    const load = seqLoad(m, context, decoding.positionsEvaluated(settings));
    flops += load.flops;
    kvBytes += load.kvBytes;
    items.push({ reqId: id, n, prefill: false });
    used++;
    decodeTok += n;
  }

  const prefillChunk = (r: Req) => {
    const n = Math.min(p.tokenBudget - used, r.prefillTarget - r.prefillDone);
    if (n <= 0) return;
    const e = pod.entries.get(r.sid)!;
    if (!growTo(w, pod, e, r.prefillDone + n, r, admission.allocatesPrefillPerChunk)) {
      // a running prompt that cannot get its next blocks, and is itself the newest, yields
      if (admission.allocatesPrefillPerChunk && pod.running.length > 1) preempt(w, pod, r, "no blocks for the next prefill chunk");
      return;
    }
    const load = seqLoad(m, r.prefillDone, n);
    flops += load.flops;
    kvBytes += load.kvBytes;
    items.push({ reqId: r.id, n, prefill: true });
    used += n;
    prefillTok += n;
  };

  // 2. prefill chunks for prompts already running, within the token budget
  for (const id of pod.running.slice()) {
    const r = w.reqs.get(id)!;
    if (!pod.running.includes(id)) continue;
    if (r.stage === "reload" && w.t >= r.stageEnd) {
      beginPrefill(w, r, pod.entries.get(r.sid)!);
      emit(w, "req.admitted", { podId: pod.id, sid: r.sid, reqId: r.id, cached: r.cached, lIn: r.lIn });
    }
    if (r.stage === "prefill" && used < p.tokenBudget) prefillChunk(r);
  }

  // 3. new admissions, unless this step had to preempt
  const budgetLeft = () => !batching.admissionHonoursTokenBudget || used < p.tokenBudget;
  while (open && w.m.preemptions === preemptedBefore && pod.waiting.length && pod.running.length < p.maxNumSeqs && budgetLeft()) {
    const r = w.reqs.get(pod.waiting[0]!)!;
    if (!admit(w, pod, r)) break;
    if (r.stage === "prefill") prefillChunk(r);
  }

  if (!items.length) {
    // every running prompt is stalled on memory: give one's blocks back so the others can finish
    const stuck = pod.running.map((id) => w.reqs.get(id)!).filter((r) => r.stage === "prefill");
    if (stuck.length > 1 && stuck.length === pod.running.length) {
      preempt(w, pod, stuck.reduce((a, b) => (b.admitT > a.admitT ? b : a)), "prefill stalled on KV memory");
    }
    pod.stepEnd = w.t + IDLE_RETRY_S;
    return;
  }

  const bytes = weightBytes(m, pod.spec.precision) + kvBytes;
  const cost = stepCost(pod.spec, { tokens: used, flops, bytes }, p);
  const tCpu = hostSeconds(p.hostMsBase, p.hostMsPerSeq, items.length);
  const tExtra = decodeTok > 0 ? decoding.overheadFactor(settings) * cost.tGpu : 0;
  const dur = stepSeconds(tCpu, cost.tGpu, p.overlap) + tExtra;
  pod.plan = items;
  pod.stepStart = w.t;
  pod.stepEnd = w.t + dur;
  pod.steps++;
  pod.last = { ...cost, tCpu, dur, bytes, flops, batch: items.length, decodeTok, prefillTok };
  if (prefillTok === 0) pod.decodeDur = dur;
  else if (decodeTok >= MIXED_STEP.minDecodeTokens && prefillTok >= MIXED_STEP.minPrefillTokens) emit(w, "step.mixed", { podId: pod.id, decodeTok, prefillTok, dur, decodeDur: pod.decodeDur, intensity: cost.intensity });
}
