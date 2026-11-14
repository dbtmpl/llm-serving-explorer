import type { HeaderRecord, SimEvent } from "@llm-viz/schema";
import {
  applyEventOwned,
  cloneState,
  createInitialState,
  DEFAULT_MAX_ROOFLINE_HISTORY
} from "./apply.js";
import type { ReplayTimelineOptions, SimState, TimelineSeekResult } from "./types.js";

const DEFAULT_SNAPSHOT_STRIDE = 500;

interface Checkpoint {
  readonly eventIndex: number;
  readonly state: SimState;
}

/**
 * Indexed replay timeline over a BLIS simulation stream.
 * Builds periodic copy-on-write state checkpoints for fast random-access seeking.
 */
export class ReplayTimeline {
  readonly header: HeaderRecord;
  readonly events: readonly SimEvent[];
  readonly snapshotStride: number;
  readonly maxRooflineHistory: number;
  readonly durationUs: number;
  readonly eventCount: number;

  private readonly checkpoints: Checkpoint[];

  constructor(
    header: HeaderRecord,
    events: readonly SimEvent[],
    options: ReplayTimelineOptions = {}
  ) {
    this.header = header;
    this.events = events;
    this.eventCount = events.length;
    this.durationUs = events.length > 0 ? events[events.length - 1].t_us : 0;
    this.snapshotStride = Math.max(1, Math.floor(options.snapshotStride ?? DEFAULT_SNAPSHOT_STRIDE));
    this.maxRooflineHistory = Math.max(
      1,
      Math.floor(options.maxRooflineHistory ?? DEFAULT_MAX_ROOFLINE_HISTORY)
    );

    const initial = createInitialState(header);
    const checkpoints: Checkpoint[] = [{ eventIndex: -1, state: cloneState(initial) }];
    const working = initial;

    for (let i = 0; i < events.length; i++) {
      applyEventOwned(working, events[i], this.maxRooflineHistory);
      if ((i + 1) % this.snapshotStride === 0) {
        checkpoints.push({
          eventIndex: i,
          state: cloneState(working)
        });
      }
    }

    this.checkpoints = checkpoints;
  }

  /**
   * Returns the index of the last event with `event.t_us <= t_us`, or -1 if none.
   */
  lastEventIndexAtOrBefore(t_us: number): number {
    if (this.events.length === 0 || t_us < this.events[0].t_us) {
      return -1;
    }
    let lo = 0;
    let hi = this.events.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.events[mid].t_us <= t_us) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  /**
   * Reconstructs the exact simulation state at timestamp `t_us`.
   * Never mutates stored checkpoints.
   */
  stateAt(t_us: number): SimState {
    const idx = this.lastEventIndexAtOrBefore(t_us);
    return this.stateAtEventIndex(idx);
  }

  /**
   * Reconstructs state at `t_us` along with the resolved event index and effective timestamp.
   */
  seekAt(t_us: number): TimelineSeekResult {
    const idx = this.lastEventIndexAtOrBefore(t_us);
    const state = this.stateAtEventIndex(idx);
    return {
      tUs: state.tUs,
      eventIndex: idx,
      state
    };
  }

  /**
   * Reconstructs the exact simulation state immediately after applying event `idx`
   * (`idx = -1` returns the initial state before any events).
   */
  stateAtEventIndex(idx: number): SimState {
    const clampedIdx = Math.max(-1, Math.min(idx, this.events.length - 1));
    const cpIdx = clampedIdx < 0 ? 0 : Math.floor((clampedIdx + 1) / this.snapshotStride);
    const cp = this.checkpoints[Math.min(cpIdx, this.checkpoints.length - 1)];

    const state = cloneState(cp.state);
    for (let i = cp.eventIndex + 1; i <= clampedIdx; i++) {
      applyEventOwned(state, this.events[i], this.maxRooflineHistory);
    }
    return state;
  }

  /**
   * Returns all events with timestamps inside `[from_us, to_us]` inclusive.
   */
  eventsInRange(from_us: number, to_us: number): SimEvent[] {
    if (this.events.length === 0 || to_us < from_us) {
      return [];
    }

    // First index with t_us >= from_us
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid].t_us < from_us) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const start = lo;
    if (start >= this.events.length || this.events[start].t_us > to_us) {
      return [];
    }

    const end = this.lastEventIndexAtOrBefore(to_us);
    if (end < start) {
      return [];
    }
    return this.events.slice(start, end + 1);
  }

  /**
   * Returns the number of cached state checkpoints held by this timeline.
   */
  get checkpointCount(): number {
    return this.checkpoints.length;
  }
}

/**
 * Factory creating a ReplayTimeline from a parsed header and event list.
 */
export function createTimeline(
  header: HeaderRecord,
  events: readonly SimEvent[],
  options?: ReplayTimelineOptions
): ReplayTimeline {
  return new ReplayTimeline(header, events, options);
}

/**
 * Parses a BLIS NDJSON event stream string and builds an indexed ReplayTimeline.
 */
export function parseTimeline(ndjson: string, options?: ReplayTimelineOptions): ReplayTimeline {
  const lines = ndjson.split(/\r?\n/);
  let header: HeaderRecord | undefined;
  const events: SimEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) {
      continue;
    }
    const parsed = JSON.parse(trimmed) as HeaderRecord | SimEvent;
    if (header === undefined) {
      if (parsed.type !== "header") {
        throw new Error(`Expected line 1 to be 'header', got '${String((parsed as { type?: unknown }).type)}'`);
      }
      header = parsed;
    } else {
      if (parsed.type === "header") {
        throw new Error(`Unexpected duplicate 'header' record at line ${i + 1}`);
      }
      events.push(parsed);
    }
  }

  if (header === undefined) {
    throw new Error("Empty NDJSON stream: missing header record");
  }

  return new ReplayTimeline(header, events, options);
}
