/** Short explanations that appear next to the node where something just happened. */
import { fmtGB, fmtInt, fmtMs } from "./format.js";
import type { Target } from "./render.js";
import type { SimEvent, World } from "../sim/index.js";

export interface Callout {
  key: string;
  target: Target;
  title: string;
  body: string;
  /** a second paragraph, shown in step-through mode */
  detail?: string;
  tone: "info" | "prefill" | "decode" | "dram" | "ssd" | "remote" | "evict";
  /** shown only the first time it happens */
  once?: boolean;
  /** minimum seconds between repeats (default 2.5) */
  every?: number;
}

const TIER_NAME: Record<string, string> = { hbm: "HBM", dram: "DRAM", ssd: "SSD", remote: "the remote pool" };

export function calloutFor(e: SimEvent, w: World): Callout[] {
  const pod = (part: "engine" | "gpu" | "roofline" | "tiers" = "engine"): Target => ({ type: "pod", id: e.podId!, part });
  const sess: Target = { type: "session", id: e.sid ?? 0 };
  const p = w.pods.find((x) => x.id === e.podId);
  const gb = () => fmtGB(e.bytes as number, (e.bytes as number) < 1e9 ? 2 : 1);
  switch (e.kind) {
    case "req.new":
      return [{ key: "req.new", once: true, target: sess, tone: "info", title: "A request starts as text", body: "The client sends its new message and sampling parameters over HTTP. Nothing is a token yet.", detail: `Session ${e.sid}, turn ${(e.turn as number) + 1}. The call itself is stateless: whatever the model should remember has to be in the prompt it is given.` }];
    case "store.read":
      return [{ key: "store.read", once: true, target: { type: "store" }, tone: "info", title: "History is read back as text", body: "A model call is stateless, so every turn re-sends the whole conversation. The grey dots are that history joining the new message.", detail: `${fmtInt(e.history as number)} tokens of earlier turns are fetched from the conversation store and placed in front of the new message. Their order decides what the prefix cache can reuse later.` }];
    case "req.tokenized":
      return [{ key: "tok", once: true, target: { type: "tokenizer" }, tone: "info", title: `${fmtInt(e.lIn as number)} tokens`, body: "The gateway authenticates, assembles the prompt (system prompt, history, new message) and counts it in tokens. Tokens, not requests, set compute, memory and cost.", detail: `${fmtInt((e.lIn as number) - (e.newTokens as number))} tokens of history + ${fmtInt(e.newTokens as number)} new. Rate limits and the deadline are attached here. The engine's own front end tokenises again on the replica.` }];
    case "req.queued":
      if (w.pods.some((x) => x.state === "ready")) return [];
      return [{ key: "queued", once: true, target: { type: "gateway" }, tone: "info", title: "No replica is ready", body: "The request waits at the router while the autoscaler starts a pod.", detail: "This wait is part of time to first token. Cold start is why fleets keep a warm minimum." }];
    case "scale.up":
      return [
        {
          key: "scale.up",
          every: 0,
          target: { type: "gateway" },
          tone: "info",
          title: `Scale up to ${e.to} pod${(e.to as number) > 1 ? "s" : ""}`,
          body: `${fmtInt(e.demand as number)} request${(e.demand as number) > 1 ? "s" : ""} in flight, and one pod runs at most ${e.perPod} sequences at once (max_num_seqs), so ${e.to} pod${(e.to as number) > 1 ? "s are" : " is"} needed${(e.to as number) >= w.params.maxPods ? `. That hits the cap of ${w.params.maxPods} pods; the rest queue at the router.` : "."}`,
          detail: `Why ${e.perPod}? It is the engine's batch-slot limit, a setting you can change under Engine. A pod could hold more sequences in memory, but every sequence in the batch shares each step, so more slots mean higher throughput and a slower token for everyone. Production values are often in the hundreds; it is small here so a batch is easy to see. The rule shown (requests in flight ÷ slots per pod) is a target-concurrency autoscaler. Real ones, such as KEDA on router metrics in llm-d, watch queue depth and running requests and react with a delay; this one reacts at once.${w.params.disagg ? " With disaggregation at least two pods are started: one for prefill, one for decode." : ""}`
        }
      ];
    case "pod.loading":
      return p ? [{ key: "loading", once: true, target: pod("gpu"), tone: "info", title: "Weights load into HBM", body: `${fmtGB(p.budget.weights)} per GPU must be resident before a single token is served.`, detail: "The dark block filling up is the weights being read into accelerator memory. Until it is full the pod cannot take traffic." }] : [];
    case "pod.ready":
      return p ? [{ key: "ready", once: true, target: pod("gpu"), tone: "info", title: "What is left is the KV pool", body: `${fmtGB(p.budget.kv * p.spec.tp)} after weights, activations and headroom: ${fmtInt(p.budget.poolBlocks)} blocks of 16 tokens. This pool caps the batch.`, detail: "The grid of empty cells is that pool. Each cell will take the colour of the session whose keys and values it holds." }] : [];
    case "pod.failed":
      return p ? [{ key: `failed${e.podId}`, target: pod("gpu"), tone: "evict", title: "The model does not fit", body: `Weights need ${fmtGB(p.budget.weights)} of ${fmtGB(p.budget.hbm, 0)} per GPU, leaving no room for a batch. Raise tensor parallelism or pick a larger GPU.` }] : [];
    case "req.routed": {
      const how = w.params.routing === "prefix-aware" ? "Prefix-aware: prefer the pod that already holds this session's KV cache, unless it is too busy." : w.params.routing === "least-loaded" ? "Least-loaded: the pod with the fewest running and waiting sequences." : "Round-robin: next pod in turn, blind to load and cache.";
      const via = e.via === "prefill" ? " Disaggregated serving: most of this prompt is not cached on any decode pod, so it goes to a prefill pod first; its KV will be handed to a decode pod afterwards. (In llm-d the decode pod is chosen first and a sidecar in front of it calls the prefill pod with max_tokens=1; the line is drawn straight to the prefill pod here.)" : e.via === "decode-only" ? " Disaggregated serving: the decode pod already holds nearly all of this prompt, so the prefill pool is skipped and the few new tokens are prefilled in place." : "";
      return [{ key: "routed", once: true, target: { type: "gateway" }, tone: "info", title: `Routed to pod-${e.podId}`, body: how + via, detail: `${e.n} candidate${(e.n as number) > 1 ? "s" : ""}. The chosen pod holds ${((e.cache as number) * 100).toFixed(0)}% of this prompt${e.tier ? ` in ${TIER_NAME[e.tier as string]}` : ""} and has ${e.load} sequences on it. From admission to its last token the request is pinned to this pod, because its state lives in that pod's memory. The score follows llm-d's recommended profile: prefix-cache match weighted 3, KV-cache utilisation 2, queue length 2.` }];
    }
    case "req.followup":
      return [{ key: "followup", every: 5, target: sess, tone: "info", title: `Follow-up turn ${e.turn}`, body: `Session ${e.sid} replies: ${fmtInt(e.history as number)} tokens of history + ${fmtInt(e.fresh as number)} new. If the history's KV is still cached, only the new tokens are prefilled.` }];
    case "req.admitted": {
      const cached = e.cached as number;
      const lIn = e.lIn as number;
      if (cached > 16) return [{ key: `hit${e.podId}`, target: pod(), tone: "decode", title: "Prefix cache hit", body: `${fmtInt(cached)} of ${fmtInt(lIn)} prompt tokens are already in HBM. Only ${fmtInt(lIn - cached)} are prefilled.`, detail: "A follow-up turn is a short, cheap prefill and then the usual memory-bound decode. The cached blocks turn from pale back to full colour: they are in use again." }];
      if ((e.turn as number) > 1) return [{ key: `miss${e.podId}`, every: 4, target: pod(), tone: "prefill", title: "Rebuilt from text", body: `No tier holds session ${e.sid}'s KV any more. All ${fmtInt(lIn)} tokens are prefilled again from the conversation store's text: slower, never wrong.` }];
      return [{ key: "prefill", once: true, target: pod(), tone: "prefill", title: "Prefill", body: `All ${fmtInt(lIn)} prompt tokens pass through the model and their keys and values are written into KV blocks. Lots of arithmetic per byte: compute-bound.`, detail: "The slot fills orange as the prompt is processed, in chunks of at most the token budget per step. The intensity dot sits right of the ridge while this runs." }];
    }
    case "req.firstToken":
      return [{ key: "decode", once: true, target: pod("roofline"), tone: "decode", title: "Decode: one token per step", body: "Every step re-reads all the weights and each sequence's cache to emit one token per sequence. Few FLOPs per byte: memory-bound, left of the ridge.", detail: `Time to first token: ${fmtMs(e.ttft as number)}. From here the slot fills blue, one token per engine step, and the sequence's cache grows by one block every 16 tokens.` }];
    case "step.tokens": {
      const n = (e.sids as number[]).length;
      const out: Callout[] = [{ key: "stream", once: true, target: { type: "stream" }, tone: "decode", title: "Blue dots: output tokens streaming back", body: "Each dot is a generated token leaving the pod. It is turned back into text and sent to its session as a streaming event (hop 6), one per sequence per engine step." }];
      if (n >= 4) out.push({ key: "batch", once: true, target: pod(), tone: "decode", title: `One weight read, ${n} tokens`, body: "Continuous batching shares each forward pass. Throughput rises with the batch while every step gets a little slower." });
      return out;
    }
    case "step.spec":
      return [{ key: "spec", every: 20, target: pod("roofline"), tone: "decode", title: `Speculative decoding: ${e.tokens} tokens from ${e.seqs} sequence${(e.seqs as number) > 1 ? "s" : ""} in one step`, body: `A small draft model guesses up to ${e.k} tokens ahead; the large model checks them all in a single pass and keeps the agreeing prefix plus one token of its own. Decode is limited by reading memory, not by arithmetic, so checking the extra positions is nearly free.` }];
    case "kv.transfer":
      return [{ key: "transfer", every: 6, target: pod(), tone: "decode", title: "KV handed over: prefill pod → decode pod", body: `Session ${e.sid}'s prompt was prefilled on pod-${e.from}. Its ${gb()} of keys and values cross a ${w.params.linkGbps} Gbps link in ${fmtMs(e.dur as number)}; decoding starts here.`, detail: "Prefill is compute-bound and decode is memory-bound. On one pod a new prompt stalls every running stream; on separate pools neither disturbs the other, at the price of moving the cache once. That transfer is what limits how far apart the two pools can be." }];
    case "step.mixed":
      return [{ key: `mixed${e.podId}`, every: 12, target: pod("roofline"), tone: "prefill", title: "A prefill shares the step with the decoders", body: `${fmtInt(e.prefillTok as number)} prompt tokens rode along with ${e.decodeTok} decodes. The step took ${fmtMs(e.dur as number)}${(e.decodeDur as number) > 0 ? ` instead of ${fmtMs(e.decodeDur as number)}` : ""}: compute-bound work stalls every memory-bound stream on the pod.` }];
    case "req.done":
      return [{ key: "done", once: true, target: sess, tone: "info", title: "Finished", body: `TTFT ${fmtMs(e.ttft as number)}, ${fmtMs(e.tpot as number)} per output token. Its KV blocks stay cached in case the session returns.`, detail: `${e.out} tokens were generated. The answer is appended to the conversation store as text; the KV blocks turn pale: cached, idle, and evictable.` }];
    case "store.append":
      return [{ key: "store.append", once: true, target: { type: "store" }, tone: "info", title: "The turn is appended as text", body: "This log is the system of record. Every KV tier is a derived copy that can be lost and rebuilt from it by a prefill." }];
    case "session.idle":
      return [{ key: "idle", every: 6, target: sess, tone: "info", title: `Session ${e.sid} went idle`, body: e.cached ? `It stopped replying. Its ${gb()} of KV sit cached in HBM doing nothing: first in line when the pool needs room.` : "It stopped replying. With prefix caching off its KV blocks were freed at once." }];
    case "churn":
      return [{ key: "churn", every: 10, target: sess, tone: "info", title: "Session churn", body: `${(e.rate as number) > 0 ? `${e.rate} new sessions per second. ` : ""}Of ${fmtInt(e.total as number)} sessions: ${fmtInt(e.active as number)} waiting on a model call, ${fmtInt(e.typing as number)} typing a follow-up, ${fmtInt(e.idle as number)} gone idle.` }];
    case "kv.move": {
      const idle = `idle for ${(e.idleFor as number).toFixed(1)} s`;
      if (e.to === "dram") return [{ key: `evict${e.podId}`, target: pod("tiers"), tone: "dram", title: "Evicted: HBM → DRAM", body: `Session ${e.sid} was ${idle}. Its ${gb()} of KV blocks move to host memory to make room.`, detail: "Whole sessions are evicted, least recently used first: a returning turn needs all of its history or none of it." }];
      if (e.to === "ssd") return [{ key: `evict${e.podId}`, target: pod("tiers"), tone: "ssd", title: `Pushed down: ${TIER_NAME[e.from as string]} → SSD`, body: `DRAM is full. Session ${e.sid}'s ${gb()} go to local SSD: more room, slower to bring back.` }];
      return [{ key: "toremote", every: 4, target: { type: "remote" }, tone: "remote", title: "Spilled to the remote pool", body: `This node's tiers are full. Session ${e.sid}'s ${gb()} go to a pool that every pod can reach, at network speed.` }];
    }
    case "kv.drop":
      return [{ key: e.podId ? `evict${e.podId}` : "remotedrop", target: e.podId ? pod("tiers") : { type: "remote" }, tone: "evict", title: "KV dropped", body: `No tier has room. Nothing is lost but time: if session ${e.sid} returns, its ${fmtInt(e.tokens as number)} tokens are prefilled again from the stored text.` }];
    case "kv.reload":
      return [{ key: `evict${e.podId}`, target: pod("tiers"), tone: e.from === "dram" ? "dram" : e.from === "ssd" ? "ssd" : "remote", title: `Loaded back from ${TIER_NAME[e.from as string]}`, body: `Session ${e.sid} is back. Copying ${gb()} to HBM takes ${fmtMs(e.dur as number)}; recomputing it would take ${fmtMs(e.recompute as number)}.` }];
    case "kv.skipload":
      return [{ key: `skip${e.podId}`, every: 5, target: pod("tiers"), tone: "prefill", title: "Recompute beats loading", body: `Copying session ${e.sid} back from ${TIER_NAME[e.from as string]} would take ${fmtMs(e.dur as number)}; prefilling its ${fmtInt(e.tokens as number)} tokens again takes ${fmtMs(e.recompute as number)}. The engine recomputes.` }];
    case "req.preempted":
      return [{ key: `pre${e.podId}`, target: pod(), tone: "evict", title: "Preempted", body: `The KV pool is full and nothing idle is left to evict. Session ${e.sid} gives its blocks back and re-prefills ${fmtInt(e.lost as number)} tokens later.`, detail: "All of a sequence's blocks go, newest admission first. The tokens already streamed are kept as text, so the user sees a stall, not a restart." }];
    case "req.failed":
      return [{ key: "failed", target: e.podId !== undefined ? pod() : { type: "gateway" }, tone: "evict", title: "Request rejected", body: `Session ${e.sid}: ${e.why}.` }];
    case "scale.down":
      return [{ key: `down${e.podId}`, target: pod(), tone: "info", title: "Scaled down", body: `Idle for ${(e.idle as number).toFixed(0)} s. The KV in this node's HBM, DRAM and SSD is lost with it; only the remote pool and the text survive.` }];
    case "fleet.restart":
      return [{ key: "restart", target: { type: "gateway" }, tone: "info", title: "Fleet restarted", body: "Weights and the KV pool are sized at start-up, so this change rebuilds every pod. In-flight requests re-prefill." }];
    default:
      return [];
  }
}

/** Event kinds that stop the clock in step-through mode when they concern the followed session. */
export const STEP_KINDS = new Set(["req.new", "store.read", "req.tokenized", "req.queued", "req.routed", "req.admitted", "req.firstToken", "req.done", "req.preempted", "req.failed", "kv.move", "kv.drop", "kv.reload", "kv.skipload", "kv.transfer", "session.idle"]);
