import React from "react";
import { PLAYBACK_SPEEDS } from "../state/usePlayback.js";

export interface PlaybackBarProps {
  playing: boolean;
  speed: number;
  tUs: number;
  durationUs: number;
  currentEventIndex: number;
  eventCount: number;
  reqFilter: string;
  podFilter: string;
  disabled: boolean;
  onTogglePlay: () => void;
  onStepEvent: (delta: number) => void;
  onChangeSpeed: (speed: number) => void;
  onSeekUs: (tUs: number) => void;
  onChangeReqFilter: (val: string) => void;
  onChangePodFilter: (val: string) => void;
}

function formatMs(tUs: number): string {
  return `${(tUs / 1000).toFixed(2)} ms`;
}

export const PlaybackBar: React.FC<PlaybackBarProps> = ({
  playing,
  speed,
  tUs,
  durationUs,
  currentEventIndex,
  eventCount,
  reqFilter,
  podFilter,
  disabled,
  onTogglePlay,
  onStepEvent,
  onChangeSpeed,
  onSeekUs,
  onChangeReqFilter,
  onChangePodFilter
}) => {
  return (
    <div className="playback-bar" role="region" aria-label="Playback Controls">
      <div className="playback-buttons">
        <button
          type="button"
          className="primary"
          data-testid="play-toggle"
          disabled={disabled}
          onClick={onTogglePlay}
          title="Play / Pause (Space)"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          data-testid="step-back"
          disabled={disabled || currentEventIndex < 0}
          onClick={() => onStepEvent(-1)}
          title="Step back 1 event (Left Arrow)"
        >
          -1
        </button>
        <button
          type="button"
          data-testid="step-forward"
          disabled={disabled || currentEventIndex >= eventCount - 1}
          onClick={() => onStepEvent(1)}
          title="Step forward 1 event (Right Arrow)"
        >
          +1
        </button>
        <select
          data-testid="speed-select"
          aria-label="Playback Speed"
          disabled={disabled}
          value={String(speed)}
          onChange={(e) => onChangeSpeed(Number(e.target.value))}
        >
          {PLAYBACK_SPEEDS.map((s) => (
            <option key={s} value={String(s)}>
              {s}x
            </option>
          ))}
        </select>
      </div>

      <div className="scrubber-wrap">
        <input
          type="range"
          className="timeline-scrubber"
          data-testid="timeline-scrubber"
          aria-label="Simulation Time Scrubber"
          min={0}
          max={Math.max(1, durationUs)}
          step={1}
          value={Math.min(tUs, Math.max(1, durationUs))}
          disabled={disabled}
          onChange={(e) => onSeekUs(Number(e.target.value))}
        />
        <span className="time-readout mono" data-testid="time-readout">
          {formatMs(tUs)} / {formatMs(durationUs)}
        </span>
        <span className="event-counter mono" data-testid="event-counter">
          ev {currentEventIndex + 1}/{eventCount}
        </span>
      </div>

      <div className="quick-filters">
        <input
          type="search"
          data-testid="req-filter"
          aria-label="Filter by Request ID"
          placeholder="req_id filter..."
          value={reqFilter}
          onChange={(e) => onChangeReqFilter(e.target.value)}
        />
        <input
          type="search"
          data-testid="pod-filter"
          aria-label="Filter by Pod ID"
          placeholder="pod_id filter..."
          value={podFilter}
          onChange={(e) => onChangePodFilter(e.target.value)}
        />
      </div>
    </div>
  );
};
