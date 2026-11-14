import React, { useMemo, useState } from "react";
import type { SimEvent, UnknownEvent } from "@llm-viz/schema";
import type { ReplayTimeline } from "../replay/index.js";
import {
  getEventPresentation,
  resolveEventTone,
  type EventCategory
} from "../registry/eventRegistry.js";
import { SourceLinksChip } from "../components/SourceLinksChip.js";

export interface EventLogViewProps {
  timeline: ReplayTimeline;
  tUs: number;
  currentEventIndex: number;
  reqFilter: string;
  podFilter: string;
  onSeekUs: (tUs: number) => void;
}

const CATEGORIES: ReadonlyArray<{ value: EventCategory | "all"; label: string }> = [
  { value: "all", label: "All Categories" },
  { value: "request", label: "Request" },
  { value: "batch", label: "Batch" },
  { value: "kv", label: "KV Cache" },
  { value: "pod", label: "Pod Lifecycle" },
  { value: "metrics", label: "Metrics" },
  { value: "unknown", label: "Unknown" }
];

function extractReqId(ev: SimEvent | UnknownEvent): string | undefined {
  const rec = ev as unknown as Record<string, unknown>;
  return typeof rec.req_id === "string" ? rec.req_id : undefined;
}

function extractPodId(ev: SimEvent | UnknownEvent): string | undefined {
  const rec = ev as unknown as Record<string, unknown>;
  if (typeof rec.pod_id === "string") return rec.pod_id;
  if (typeof rec.chosen_pod === "string") return rec.chosen_pod;
  if (typeof rec.from_pod === "string") return rec.from_pod;
  return undefined;
}

export const EventLogView: React.FC<EventLogViewProps> = ({
  timeline,
  currentEventIndex,
  reqFilter,
  podFilter,
  onSeekUs
}) => {
  const [category, setCategory] = useState<EventCategory | "all">("all");
  const [searchText, setSearchText] = useState("");
  const [showFuture, setShowFuture] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [limit, setLimit] = useState(250);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const reqQ = reqFilter.trim().toLowerCase();
    const podQ = podFilter.trim().toLowerCase();
    const maxIdx = showFuture ? timeline.events.length - 1 : currentEventIndex;

    const out: Array<{ index: number; event: SimEvent | UnknownEvent }> = [];
    for (let i = 0; i <= maxIdx; i++) {
      const ev = timeline.events[i];
      const pres = getEventPresentation(ev);
      if (category !== "all" && pres.category !== category) {
        continue;
      }
      const reqId = extractReqId(ev);
      if (reqQ && !(reqId?.toLowerCase().includes(reqQ) ?? false)) {
        continue;
      }
      const podId = extractPodId(ev);
      if (podQ && !(podId?.toLowerCase().includes(podQ) ?? false)) {
        continue;
      }
      if (q) {
        const summary = pres.shortSummary(ev).toLowerCase();
        if (!ev.type.toLowerCase().includes(q) && !summary.includes(q)) {
          continue;
        }
      }
      out.push({ index: i, event: ev });
    }

    if (newestFirst) {
      out.reverse();
    }
    return out;
  }, [timeline, currentEventIndex, category, searchText, reqFilter, podFilter, showFuture, newestFirst]);

  const visibleRows = filtered.slice(0, limit);

  return (
    <div data-testid="event-log-view" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="view-header-row">
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Simulation Event Log</h2>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            Click any row to seek playback to that event; expand JSON to inspect raw BLIS fields.
          </div>
        </div>
        <SourceLinksChip
          glossaryTerm="BLIS"
          links={[
            { path: "sim/events_schema.go", label: "Event Schema" },
            { path: "sim/events_sink.go", label: "Event Sink" },
            { path: "sim/engine_driver.go", label: "Engine Driver" }
          ]}
        />
      </div>

      <div className="event-log-toolbar" style={{ marginBottom: 0 }}>
        <select
          data-testid="event-category-filter"
          aria-label="Filter by event category"
          value={category}
          onChange={(e) => setCategory(e.target.value as EventCategory | "all")}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>

        <input
          type="search"
          data-testid="event-search-input"
          aria-label="Filter events by type or summary"
          placeholder="Search type or summary..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{ minWidth: 210 }}
        />

        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={newestFirst}
            onChange={(e) => setNewestFirst(e.target.checked)}
          />
          Newest first
        </label>

        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}>
          <input
            type="checkbox"
            data-testid="show-future-toggle"
            checked={showFuture}
            onChange={(e) => setShowFuture(e.target.checked)}
          />
          Preview future events
        </label>

        <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-secondary)" }}>
          Showing {visibleRows.length} of {filtered.length} matching events
        </span>
      </div>

      <div className="event-log-table-wrap">
        <table className="event-log-table">
          <thead>
            <tr>
              <th style={{ width: 64 }}>Seq</th>
              <th style={{ width: 92 }}>Time</th>
              <th style={{ width: 115 }}>Badge</th>
              <th style={{ width: 165 }}>Type</th>
              <th>Summary</th>
              <th style={{ width: 78 }}>Raw</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 20, textAlign: "center", color: "var(--text-muted)" }}>
                  No events up to the current timestamp match the active filters.
                </td>
              </tr>
            ) : (
              visibleRows.map(({ index, event }) => {
                const pres = getEventPresentation(event);
                const tone = resolveEventTone(pres, event);
                const isExpanded = expandedSeq === event.seq;
                const isFuture = index > currentEventIndex;
                const isCursor = index === currentEventIndex;
                let summaryText = "";
                let detailsObj: Record<string, unknown> = {};
                try {
                  summaryText = pres.shortSummary(event);
                  detailsObj = pres.details(event);
                } catch {
                  summaryText = `Event ${event.type}`;
                  detailsObj = { ...event };
                }

                return (
                  <React.Fragment key={`${event.seq}-${index}`}>
                    <tr
                      data-testid="event-log-row"
                      data-event-type={event.type}
                      className={`event-log-row ${isCursor ? "at-cursor" : ""} ${isFuture ? "future" : ""}`}
                      onClick={() => onSeekUs(event.t_us)}
                      title="Click row to seek timeline to this event"
                    >
                      <td className="mono">{event.seq}</td>
                      <td className="mono">{(event.t_us / 1000).toFixed(2)}ms</td>
                      <td>
                        <span className={`badge badge-${tone}`}>{pres.badge}</span>
                      </td>
                      <td className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                        {event.type}
                      </td>
                      <td>{summaryText}</td>
                      <td>
                        <button
                          type="button"
                          data-testid={`event-expand-${event.seq}`}
                          style={{ padding: "2px 7px", fontSize: 11 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedSeq(isExpanded ? null : event.seq);
                          }}
                        >
                          {isExpanded ? "Hide" : "JSON"}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="event-detail-row" data-testid={`event-detail-${event.seq}`}>
                        <td colSpan={6}>
                          <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                            Category: <strong>{pres.category}</strong> · Timestamp:{" "}
                            <span className="mono">{event.t_us} us</span>
                          </div>
                          <pre className="event-detail-json">{JSON.stringify(detailsObj, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > visibleRows.length && (
        <div style={{ marginTop: 10, textAlign: "center" }}>
          <button type="button" onClick={() => setLimit((prev) => prev + 250)}>
            Show 250 more ({filtered.length - visibleRows.length} remaining)
          </button>
        </div>
      )}
    </div>
  );
};
