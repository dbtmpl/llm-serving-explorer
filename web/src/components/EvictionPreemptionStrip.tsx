import React, { useMemo, useState } from "react";
import type { KVBlockEvictedEvent, RequestPreemptedEvent } from "@llm-viz/schema";
import { selectPods, type ReplayTimeline, type SimState } from "../replay/index.js";
import { InfoHint } from "./GlossaryModal.js";

export interface EvictionPreemptionStripProps {
  timeline: ReplayTimeline;
  state: SimState;
  tUs: number;
  podFilter?: string;
  reqFilter?: string;
  windowUs?: number;
  onSeekUs?: (tUs: number) => void;
}

const DEFAULT_LOOKBACK_US = 250_000;

function formatMs(tUs: number): string {
  return `${(tUs / 1000).toFixed(2)} ms`;
}

function upperBoundByTime(events: ReadonlyArray<{ t_us: number }>, tUs: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].t_us <= tUs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export const EvictionPreemptionStrip: React.FC<EvictionPreemptionStripProps> = ({
  timeline,
  state,
  tUs,
  podFilter = "",
  reqFilter = "",
  windowUs = DEFAULT_LOOKBACK_US,
  onSeekUs
}) => {
  const [expanded, setExpanded] = useState(false);

  // Index all eviction & preemption events once per timeline for O(log N) seeks
  const indexed = useMemo(() => {
    const evictions: KVBlockEvictedEvent[] = [];
    const preemptions: RequestPreemptedEvent[] = [];
    for (const ev of timeline.events) {
      if (ev.type === "kv.block.evicted") {
        evictions.push(ev);
      } else if (ev.type === "request.preempted") {
        preemptions.push(ev);
      }
    }
    return { evictions, preemptions };
  }, [timeline]);

  const podQ = podFilter.trim().toLowerCase();
  const reqQ = reqFilter.trim().toLowerCase();

  const filteredAll = useMemo(() => {
    const evictions = indexed.evictions.filter((ev) => {
      if (podQ && !ev.pod_id.toLowerCase().includes(podQ)) return false;
      if (reqQ && !(ev.triggered_by_req_id?.toLowerCase().includes(reqQ) ?? false)) return false;
      return true;
    });
    const preemptions = indexed.preemptions.filter((ev) => {
      if (podQ && !ev.pod_id.toLowerCase().includes(podQ)) return false;
      if (reqQ && !ev.req_id.toLowerCase().includes(reqQ)) return false;
      return true;
    });
    return { evictions, preemptions };
  }, [indexed, podQ, reqQ]);

  const liveStats = useMemo(() => {
    const evEnd = upperBoundByTime(filteredAll.evictions, tUs);
    const prEnd = upperBoundByTime(filteredAll.preemptions, tUs);

    const winStart = Math.max(0, tUs - windowUs);
    const activeEvictions: KVBlockEvictedEvent[] = [];
    for (let i = evEnd - 1; i >= 0; i--) {
      if (filteredAll.evictions[i].t_us < winStart) break;
      activeEvictions.push(filteredAll.evictions[i]);
    }

    const activePreemptions: RequestPreemptedEvent[] = [];
    for (let i = prEnd - 1; i >= 0; i--) {
      if (filteredAll.preemptions[i].t_us < winStart) break;
      activePreemptions.push(filteredAll.preemptions[i]);
    }

    let evictedBlocksUpToNow = 0;
    for (let i = 0; i < evEnd; i++) {
      evictedBlocksUpToNow += filteredAll.evictions[i].block_ids.length;
    }

    // Also reflect pod-level preemption counter from SimState when unfiltered by req
    const pods = selectPods(state).filter((p) => !podQ || p.podId.toLowerCase().includes(podQ));
    const podPreemptionsSum = pods.reduce((sum, p) => sum + p.preemptions, 0);

    return {
      totalEvictions: evEnd,
      evictedBlocksUpToNow,
      totalPreemptions: reqQ ? prEnd : Math.max(prEnd, podPreemptionsSum),
      activeEvictions,
      activePreemptions,
      lastEviction: evEnd > 0 ? filteredAll.evictions[evEnd - 1] : undefined,
      nextEviction: evEnd < filteredAll.evictions.length ? filteredAll.evictions[evEnd] : undefined,
      lastPreemption: prEnd > 0 ? filteredAll.preemptions[prEnd - 1] : undefined,
      nextPreemption: prEnd < filteredAll.preemptions.length ? filteredAll.preemptions[prEnd] : undefined
    };
  }, [filteredAll, state, tUs, windowUs, podQ, reqQ]);

  const hasActiveEviction = liveStats.activeEvictions.length > 0;
  const hasActivePreemption = liveStats.activePreemptions.length > 0;
  const hasAnyInScenario =
    filteredAll.evictions.length > 0 || filteredAll.preemptions.length > 0;

  const recentCombined = useMemo(() => {
    const items: Array<
      | { kind: "eviction"; ev: KVBlockEvictedEvent }
      | { kind: "preemption"; ev: RequestPreemptedEvent }
    > = [];
    for (const ev of liveStats.activeEvictions) {
      items.push({ kind: "eviction", ev });
    }
    for (const ev of liveStats.activePreemptions) {
      items.push({ kind: "preemption", ev });
    }
    items.sort((a, b) => b.ev.t_us - a.ev.t_us || b.ev.seq - a.ev.seq);
    return items;
  }, [liveStats.activeEvictions, liveStats.activePreemptions]);

  const borderColor = hasActivePreemption
    ? "var(--sem-preempted)"
    : hasActiveEviction
      ? "var(--sem-evicted)"
      : "var(--border-subtle)";

  const bgTint = hasActivePreemption
    ? "rgba(239, 68, 68, 0.08)"
    : hasActiveEviction
      ? "rgba(251, 113, 133, 0.08)"
      : "var(--bg-surface)";

  return (
    <div
      className="panel-card"
      data-testid="eviction-preemption-strip"
      style={{
        padding: "10px 14px",
        marginBottom: 12,
        borderColor,
        background: bgTint,
        display: "flex",
        flexDirection: "column",
        gap: 8
      }}
    >
      {(hasActiveEviction || hasActivePreemption) && (
        <style>{`@keyframes ep-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }`}</style>
      )}

      {/* Compact Summary & Pulse Badges Row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          flexWrap: "wrap"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 5 }}>
            KV Evictions &amp; Preemptions <InfoHint term="Eviction" /> <InfoHint term="Preemption" />
          </span>

          {hasActiveEviction && (
            <span
              className="badge badge-evicted mono"
              data-testid="active-eviction-badge"
              style={{ animation: "ep-pulse 1.2s ease-in-out infinite" }}
            >
              ACTIVE EVICTION ({liveStats.activeEvictions.length})
            </span>
          )}

          {hasActivePreemption && (
            <span
              className="badge badge-preempted mono"
              data-testid="active-preemption-badge"
              style={{ animation: "ep-pulse 1.2s ease-in-out infinite" }}
            >
              PREEMPTION ({liveStats.activePreemptions.length})
            </span>
          )}

          <span className="badge badge-neutral mono" data-testid="eviction-count-badge">
            Evictions: {liveStats.totalEvictions}
            {filteredAll.evictions.length > liveStats.totalEvictions
              ? ` / ${filteredAll.evictions.length} run`
              : ""}{" "}
            ({liveStats.evictedBlocksUpToNow} blk)
          </span>

          <span className="badge badge-neutral mono" data-testid="preemption-count-badge">
            Preemptions: {liveStats.totalPreemptions}
            {filteredAll.preemptions.length > liveStats.totalPreemptions
              ? ` / ${filteredAll.preemptions.length} run`
              : ""}
          </span>
        </div>

        {/* Click-to-jump controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {liveStats.lastEviction && (
            <button
              type="button"
              data-testid="jump-last-eviction"
              onClick={() => onSeekUs?.(liveStats.lastEviction!.t_us)}
              title="Jump to most recent KV eviction"
              style={{ fontSize: 11, padding: "3px 8px" }}
            >
              Last Evict @ {formatMs(liveStats.lastEviction.t_us)}
            </button>
          )}
          {liveStats.nextEviction && (
            <button
              type="button"
              data-testid="jump-next-eviction"
              onClick={() => onSeekUs?.(liveStats.nextEviction!.t_us)}
              title="Jump to next KV eviction in timeline"
              style={{ fontSize: 11, padding: "3px 8px" }}
            >
              Next Evict @ {formatMs(liveStats.nextEviction.t_us)}
            </button>
          )}
          {liveStats.lastPreemption && (
            <button
              type="button"
              data-testid="jump-last-preemption"
              onClick={() => onSeekUs?.(liveStats.lastPreemption!.t_us)}
              title="Jump to most recent request preemption"
              style={{ fontSize: 11, padding: "3px 8px", borderColor: "rgba(239, 68, 68, 0.45)" }}
            >
              Last Preempt @ {formatMs(liveStats.lastPreemption.t_us)}
            </button>
          )}
          {liveStats.nextPreemption && (
            <button
              type="button"
              data-testid="jump-next-preemption"
              onClick={() => onSeekUs?.(liveStats.nextPreemption!.t_us)}
              title="Jump to next request preemption in timeline"
              style={{ fontSize: 11, padding: "3px 8px", borderColor: "rgba(239, 68, 68, 0.45)" }}
            >
              Next Preempt @ {formatMs(liveStats.nextPreemption.t_us)}
            </button>
          )}
          {hasAnyInScenario && (
            <button
              type="button"
              data-testid="toggle-eviction-preemption-details"
              onClick={() => setExpanded((e) => !e)}
              style={{ fontSize: 11, padding: "3px 8px" }}
            >
              {expanded ? "Hide Ledger" : `Ledger (${filteredAll.evictions.length + filteredAll.preemptions.length})`}
            </button>
          )}
        </div>
      </div>

      {/* Active Window Highlights (who lost computed tokens / triggered LRU eviction) */}
      {recentCombined.length > 0 && (
        <div
          data-testid="active-window-events"
          style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
        >
          {recentCombined.slice(0, 8).map((item) => {
            if (item.kind === "preemption") {
              const ev = item.ev;
              return (
                <button
                  key={`pr-${ev.seq}`}
                  type="button"
                  data-testid={`preemption-chip-${ev.seq}`}
                  onClick={() => onSeekUs?.(ev.t_us)}
                  style={{
                    fontSize: 11,
                    padding: "3px 8px",
                    background: "var(--sem-preempted-bg)",
                    borderColor: "rgba(239, 68, 68, 0.45)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6
                  }}
                  title={`Click to seek to preemption at ${formatMs(ev.t_us)}`}
                >
                  <span className="mono" style={{ color: "var(--sem-preempted)", fontWeight: 700 }}>
                    PREEMPT {ev.req_id}
                  </span>
                  <span className="mono" style={{ color: "var(--text-secondary)" }}>
                    {ev.pod_id} · lost {ev.computed_tokens_lost ?? "?"} tok · freed {ev.freed_blocks.length} blk @{" "}
                    {formatMs(ev.t_us)}
                  </span>
                </button>
              );
            }
            const ev = item.ev;
            return (
              <button
                key={`ev-${ev.seq}`}
                type="button"
                data-testid={`eviction-chip-${ev.seq}`}
                onClick={() => onSeekUs?.(ev.t_us)}
                style={{
                  fontSize: 11,
                  padding: "3px 8px",
                  background: "var(--sem-evicted-bg)",
                  borderColor: "rgba(251, 113, 133, 0.45)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6
                }}
                title={`Click to seek to eviction at ${formatMs(ev.t_us)}`}
              >
                <span className="mono" style={{ color: "var(--sem-evicted)", fontWeight: 700 }}>
                  EVICT {ev.block_ids.length} blk ({ev.destination})
                </span>
                <span className="mono" style={{ color: "var(--text-secondary)" }}>
                  {ev.pod_id} · {ev.triggered_by_req_id ? `by ${ev.triggered_by_req_id}` : ev.reason} @{" "}
                  {formatMs(ev.t_us)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Expandable Full Scenario Preemption & Eviction Jump Ledger */}
      {expanded && hasAnyInScenario && (
        <div
          data-testid="eviction-preemption-ledger"
          style={{
            borderTop: "1px solid var(--border-subtle)",
            paddingTop: 8,
            maxHeight: 200,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 4
          }}
        >
          {[
            ...filteredAll.preemptions.map((ev) => ({ kind: "preemption" as const, ev })),
            ...filteredAll.evictions.map((ev) => ({ kind: "eviction" as const, ev }))
          ]
            .sort((a, b) => a.ev.t_us - b.ev.t_us || a.ev.seq - b.ev.seq)
            .slice(0, 100)
            .map((item) => {
              const isFuture = item.ev.t_us > tUs;
              if (item.kind === "preemption") {
                const ev = item.ev;
                return (
                  <div
                    key={`ledger-pr-${ev.seq}`}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 11.5,
                      padding: "4px 8px",
                      borderRadius: 5,
                      background: "var(--bg-inset)",
                      opacity: isFuture ? 0.65 : 1
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className="badge badge-preempted">PREEMPT</span>
                      <span className="mono">{ev.req_id}</span>
                      <span className="mono" style={{ color: "var(--text-secondary)" }}>
                        {ev.pod_id} · reason={ev.reason} · lost {ev.computed_tokens_lost ?? 0} tok · freed{" "}
                        {ev.freed_blocks.length} blk
                      </span>
                    </div>
                    <button
                      type="button"
                      className="mono"
                      data-testid={`ledger-jump-${ev.seq}`}
                      onClick={() => onSeekUs?.(ev.t_us)}
                      style={{ fontSize: 11, padding: "2px 7px" }}
                    >
                      Jump {formatMs(ev.t_us)}
                    </button>
                  </div>
                );
              }
              const ev = item.ev;
              return (
                <div
                  key={`ledger-ev-${ev.seq}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 11.5,
                    padding: "4px 8px",
                    borderRadius: 5,
                    background: "var(--bg-inset)",
                    opacity: isFuture ? 0.65 : 1
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span className="badge badge-evicted">EVICT</span>
                    <span className="mono">{ev.pod_id}</span>
                    <span className="mono" style={{ color: "var(--text-secondary)" }}>
                      blocks=[{ev.block_ids.slice(0, 4).join(",")}
                      {ev.block_ids.length > 4 ? `...+${ev.block_ids.length - 4}` : ""}] · {ev.tier} -&gt;{" "}
                      {ev.destination} · {ev.triggered_by_req_id ? `triggered_by=${ev.triggered_by_req_id}` : ev.reason}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="mono"
                    data-testid={`ledger-jump-${ev.seq}`}
                    onClick={() => onSeekUs?.(ev.t_us)}
                    style={{ fontSize: 11, padding: "2px 7px" }}
                  >
                    Jump {formatMs(ev.t_us)}
                  </button>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
};
