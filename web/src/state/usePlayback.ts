import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplayTimeline, SimState } from "../replay/index.js";

export const PLAYBACK_SPEEDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25] as const;

export type MarkerKind =
  | "eviction"
  | "preemption"
  | "move"
  | "transfer"
  | "scale-up"
  | "scale-down";

export interface TimelineMarker {
  readonly id: string;
  readonly label: string;
  readonly tUs: number;
  readonly eventIndex: number;
  readonly kind: MarkerKind;
}

const MARKER_RULES: ReadonlyArray<{
  id: string;
  label: string;
  type: string;
  kind: MarkerKind;
}> = [
  { id: "first-eviction", label: "First Eviction", type: "kv.block.evicted", kind: "eviction" },
  { id: "first-preemption", label: "First Preemption", type: "request.preempted", kind: "preemption" },
  { id: "first-kv-move", label: "First KV Move", type: "kv.block.moved", kind: "move" },
  { id: "first-kv-transfer", label: "First KV Transfer", type: "kv.transfer", kind: "transfer" },
  { id: "first-scale-up", label: "First Scale-Up", type: "pod.created", kind: "scale-up" },
  { id: "scale-down", label: "Scale-Down", type: "pod.draining", kind: "scale-down" }
];

export function getTimelineMarkers(timeline: ReplayTimeline | null | undefined): TimelineMarker[] {
  if (!timeline) {
    return [];
  }
  const found = new Map<string, TimelineMarker>();
  for (let i = 0; i < timeline.events.length; i++) {
    const ev = timeline.events[i];
    for (const rule of MARKER_RULES) {
      if (ev.type === rule.type && !found.has(rule.id)) {
        found.set(rule.id, {
          id: rule.id,
          label: rule.label,
          tUs: ev.t_us,
          eventIndex: i,
          kind: rule.kind
        });
      }
    }
    if (found.size === MARKER_RULES.length) {
      break;
    }
  }
  return MARKER_RULES.map((r) => found.get(r.id)).filter((m): m is TimelineMarker => m !== undefined);
}

export interface UsePlaybackResult {
  readonly playing: boolean;
  readonly speed: number;
  readonly tUs: number;
  readonly currentEventIndex: number;
  readonly simState: SimState | null;
  readonly play: () => void;
  readonly pause: () => void;
  readonly togglePlay: () => void;
  readonly setSpeed: (nextSpeed: number) => void;
  readonly seekUs: (nextTUs: number) => void;
  readonly stepEvent: (delta: number) => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "SELECT" ||
    tag === "TEXTAREA" ||
    target.isContentEditable
  );
}

export function usePlayback(
  timeline: ReplayTimeline | null,
  initialTUs: number,
  initialSpeed: number
): UsePlaybackResult {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(initialSpeed);
  const [tUs, setTUs] = useState(initialTUs);
  // Explicit event index override during step-by-step navigation so simultaneous events
  // sharing the same t_us can be stepped individually forward and backward.
  const [stepIndexOverride, setStepIndexOverride] = useState<number | null>(null);

  const tUsRef = useRef(tUs);
  tUsRef.current = tUs;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const stepIndexRef = useRef(stepIndexOverride);
  stepIndexRef.current = stepIndexOverride;

  // Clamp tUs and clear step override when a new timeline loads.
  useEffect(() => {
    setStepIndexOverride(null);
    if (!timeline) {
      setPlaying(false);
      return;
    }
    setTUs((prev) => Math.max(0, Math.min(prev, timeline.durationUs)));
  }, [timeline]);

  const play = useCallback(() => {
    if (!timeline || timeline.durationUs <= 0) {
      return;
    }
    setStepIndexOverride(null);
    if (tUsRef.current >= timeline.durationUs) {
      setTUs(0);
    }
    setPlaying(true);
  }, [timeline]);

  const pause = useCallback(() => {
    setPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    setPlaying((prev) => {
      if (prev) return false;
      if (!timeline || timeline.durationUs <= 0) return false;
      setStepIndexOverride(null);
      if (tUsRef.current >= timeline.durationUs) {
        setTUs(0);
      }
      return true;
    });
  }, [timeline]);

  const seekUs = useCallback(
    (nextTUs: number) => {
      setStepIndexOverride(null);
      const maxUs = timeline?.durationUs ?? 0;
      const clamped = Math.max(0, Math.min(Math.round(nextTUs), maxUs));
      setTUs(clamped);
    },
    [timeline]
  );

  const setSpeed = useCallback((nextSpeed: number) => {
    if (Number.isFinite(nextSpeed) && nextSpeed > 0) {
      setSpeedState(nextSpeed);
    }
  }, []);

  const stepEvent = useCallback(
    (delta: number) => {
      if (!timeline || timeline.eventCount === 0) {
        return;
      }
      setPlaying(false);
      const currIdx =
        stepIndexRef.current !== null
          ? stepIndexRef.current
          : timeline.lastEventIndexAtOrBefore(tUsRef.current);
      const nextIdx = Math.max(-1, Math.min(currIdx + delta, timeline.eventCount - 1));
      const nextT = nextIdx < 0 ? 0 : timeline.events[nextIdx].t_us;
      setStepIndexOverride(nextIdx);
      setTUs(nextT);
    },
    [timeline]
  );

  // Playback RAF clock: 1x speed = 1 simulated second per wall-clock second.
  useEffect(() => {
    if (!playing || !timeline) {
      return;
    }
    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dtMs = Math.min(100, Math.max(0, now - lastTime));
      lastTime = now;
      const deltaUs = dtMs * 1000 * speedRef.current;
      const next = tUsRef.current + deltaUs;
      if (next >= timeline.durationUs) {
        setStepIndexOverride(null);
        setTUs(timeline.durationUs);
        setPlaying(false);
        return;
      }
      setStepIndexOverride(null);
      setTUs(Math.round(next));
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playing, timeline]);

  // Global keyboard shortcuts (Space, ArrowLeft, ArrowRight).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) {
        return;
      }
      if (e.code === "Space") {
        if (document.activeElement instanceof HTMLButtonElement) {
          return;
        }
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        stepEvent(e.shiftKey ? -10 : -1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        stepEvent(e.shiftKey ? 10 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, stepEvent]);

  const currentEventIndex = useMemo(() => {
    if (!timeline) return -1;
    if (stepIndexOverride !== null) {
      return Math.max(-1, Math.min(stepIndexOverride, timeline.eventCount - 1));
    }
    return timeline.lastEventIndexAtOrBefore(tUs);
  }, [timeline, tUs, stepIndexOverride]);

  const simState = useMemo(() => {
    if (!timeline) return null;
    if (stepIndexOverride !== null) {
      return timeline.stateAtEventIndex(stepIndexOverride);
    }
    return timeline.stateAt(tUs);
  }, [timeline, tUs, stepIndexOverride]);

  return {
    playing,
    speed,
    tUs,
    currentEventIndex,
    simState,
    play,
    pause,
    togglePlay,
    setSpeed,
    seekUs,
    stepEvent
  };
}
