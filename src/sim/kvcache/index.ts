/**
 * Concept: the KV cache. How is it laid out, reused, evicted, tiered, reloaded and reclaimed?
 *
 * This module owns several decisions, each with its own interface and registry. To add an
 * approach: implement the matching interface in its own file with its citation, add it to the
 * registry below, and add a unit test. See README.md in this directory.
 */
import type { ApproachMeta, Concept } from "../approach.js";
import { leastRecentlyUsed, type EvictionPolicy } from "./eviction.js";
import { preemptNewest, type PreemptionPolicy } from "./preemption.js";
import { blockHashPrefix, type PrefixMatcher } from "./prefix.js";
import { adaptiveReload, type ReloadPolicy } from "./reload.js";
import { tieredCache } from "./tiers.js";

export const pagedBlocks: ApproachMeta = {
  id: "paged-blocks",
  name: "Paged KV blocks (PagedAttention)",
  summary: "KV memory is handed out in fixed 16-token blocks as tokens are written, like virtual-memory pages.",
  citations: ["kwon2023"],
  fidelity: "structural",
  verification: ["kv-budget-8b-h100", "kv-budget-70b-h200-tp4", "preemption-overflow", "eviction-pressure"]
};

export const KV_LAYOUT: Concept = {
  module: "kvcache",
  title: "KV cache layout",
  question: "How is KV memory divided among sequences?",
  approaches: [pagedBlocks]
};

export const PREFIX_REUSE: Concept<PrefixMatcher> = {
  module: "kvcache",
  title: "Prefix reuse",
  question: "How much of a new request's context is served from cached KV?",
  approaches: [blockHashPrefix]
};

export const EVICTION_ORDER: Concept<EvictionPolicy> = {
  module: "kvcache",
  title: "Eviction order",
  question: "When a tier is full, whose cached KV leaves first?",
  approaches: [leastRecentlyUsed]
};

export const KV_TIERS: Concept = {
  module: "kvcache",
  title: "KV tiers",
  question: "Where does KV go when it leaves GPU memory?",
  approaches: [tieredCache]
};

export const RELOAD_DECISION: Concept<ReloadPolicy> = {
  module: "kvcache",
  title: "Reload decision",
  question: "Load KV back from a lower tier, or compute it again?",
  approaches: [adaptiveReload]
};

export const PREEMPTION_POLICY: Concept<PreemptionPolicy> = {
  module: "kvcache",
  title: "Preemption",
  question: "The pool is empty mid-flight. Which sequence gives its memory back?",
  approaches: [preemptNewest]
};

export const KVCACHE_CONCEPTS: readonly Concept[] = [KV_LAYOUT, PREFIX_REUSE, EVICTION_ORDER, KV_TIERS, RELOAD_DECISION, PREEMPTION_POLICY];
