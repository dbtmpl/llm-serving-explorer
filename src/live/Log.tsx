/**
 * The history of every explanation box shown so far (callouts and step-through steps), so a visitor
 * who missed one can read it again. Collapsed by default; a box that leaves the screen flies into the
 * log's button, which says where it went.
 */
import { useEffect, useRef } from "react";
import { Rich } from "./Rich.js";
import type { Target } from "./render.js";

export interface LogEntry {
  id: number;
  /** a callout next to a node, or a step of the step-through */
  kind: "callout" | "step";
  /** simulated seconds when it was shown */
  t: number;
  tone: string;
  title: string;
  body: string;
  target?: Target;
  /** the number its box showed (a note), or its step number (a step) */
  no?: number;
}

/** Entries kept; older ones are dropped. */
export const LOG_MAX = 300;

/** Append an entry unless the same one (kind and id) is already there. */
export function logAppend(log: LogEntry[], e: LogEntry): LogEntry[] {
  if (log.some((x) => x.kind === e.kind && x.id === e.id)) return log;
  const next = [...log, e];
  return next.length > LOG_MAX ? next.slice(next.length - LOG_MAX) : next;
}

/**
 * Animate a box that is about to disappear into the log button: a copy of it shrinks along a short
 * arc to the button, then the button pulses. The original is left to React. With reduced motion the
 * copy only fades.
 */
export function flyToLog(el: HTMLElement, button: HTMLElement | null): void {
  const from = el.getBoundingClientRect();
  const to = button?.getBoundingClientRect();
  const opacity = Number(getComputedStyle(el).opacity);
  if (!to || to.width === 0 || from.width === 0 || opacity < 0.05) return;
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("data-testid");
  ghost.classList.add("lv-fly");
  Object.assign(ghost.style, { position: "fixed", left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, margin: "0", transform: "none", opacity: String(opacity), pointerEvents: "none" });
  // first among the box's siblings, so it passes behind the boxes still shown instead of over them;
  // inside the app root, so the copy keeps the page's fonts and colours
  const host = el.parentElement ?? el.closest(".lv-root") ?? document.body;
  host.insertBefore(ghost, host.firstChild);
  let reduce = false;
  try {
    reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    reduce = false;
  }
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const frames = reduce
    ? [{ opacity }, { opacity: 0 }]
    : [
        { transform: "translate(0, 0) scale(1)", opacity },
        { transform: `translate(${dx * 0.3}px, ${dy * 0.3 - 24}px) scale(0.6)`, opacity: Math.min(opacity, 0.9), offset: 0.4 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.06)`, opacity: 0.15 }
      ];
  const anim = ghost.animate(frames, { duration: reduce ? 200 : 700, easing: "cubic-bezier(0.55, 0, 0.7, 0.2)" });
  const done = () => {
    ghost.remove();
    if (!reduce) button?.animate([{ transform: "scale(1)" }, { transform: "scale(1.22)" }, { transform: "scale(1)" }], { duration: 320, easing: "ease-out" });
  };
  anim.onfinish = done;
  anim.oncancel = done;
}

export function LogButton({ count, open, onToggle, unread, buttonRef, compact }: { count: number; open: boolean; onToggle: () => void; unread: boolean; buttonRef: React.Ref<HTMLButtonElement>; compact?: boolean }) {
  return (
    <button ref={buttonRef} className={`lv-ghost lv-log-btn ${open ? "on" : ""}`} data-testid="log-toggle" aria-expanded={open} aria-controls="lv-log" onClick={onToggle} title="Every explanation shown so far" aria-label="History of explanations">
      {compact ? <span aria-hidden="true">🕘</span> : "history"}
      <span className={`lv-log-count ${unread ? "new" : ""}`} data-testid="log-count">
        {count}
      </span>
    </button>
  );
}

export function LogPanel({ entries, onPick, onClose, onClear }: { entries: LogEntry[]; onPick: (e: LogEntry) => void; onClose: () => void; onClear: () => void }) {
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  // stay at the newest entry unless the visitor has scrolled up to read an older one
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  return (
    <section className="lv-log" id="lv-log" data-testid="log" aria-label="History of explanations">
      <header>
        <h2>History</h2>
        <span>{entries.length ? `${entries.length} shown so far, oldest first` : ""}</span>
        {entries.length > 0 && (
          <button className="lv-ghost" onClick={onClear}>
            clear
          </button>
        )}
        <button className="lv-ghost" data-testid="log-close" onClick={onClose} aria-label="Close history">
          ✕
        </button>
      </header>
      {entries.length === 0 ? (
        <p className="lv-note">Explanations land here when they leave the graph. Send a request or start the step-through to see some.</p>
      ) : (
        <ol
          ref={list}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {entries.map((e) => (
            <li key={`${e.kind}:${e.id}`} className={`tone-${e.tone}`} data-testid="log-entry">
              <button onClick={() => onPick(e)} disabled={!e.target}>
                <span className="lv-log-meta">
                  {e.kind === "step" ? "step" : "note"} · {e.t.toFixed(2)} s
                </span>
                <b>
                  {e.no !== undefined && (
                    <i className="lv-log-no" data-testid="log-no">
                      {e.no}
                    </i>
                  )}
                  <Rich inline text={e.title} />
                </b>
                <span className="lv-log-body">
                  <Rich inline text={e.body} />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
