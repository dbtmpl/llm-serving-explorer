/** Guided tour: one card per component, each with a looping preview of what its animation looks like. */
import type { CSSProperties } from "react";
import { tourText } from "../content/index.js";
import { C, type Target } from "./render.js";

export interface TourStep {
  id: string;
  /** markdown (inline), from src/content/tutorial.md */
  title: string;
  /** markdown, from src/content/tutorial.md */
  text: string;
  /** a node of the graph, or a floating panel (`data-tour` attribute) */
  target?: Target | { el: string };
}

const d = (delay: number, extra: CSSProperties = {}): CSSProperties => ({ animationDelay: `${delay}s`, ...extra });
const go = (dx: number, dy: number, delay = 0): CSSProperties => ({ ["--dx" as string]: `${dx}px`, ["--dy" as string]: `${dy}px`, animationDelay: `${delay}s` });
const HUES = ["hsl(200 66% 60%)", "hsl(20 66% 60%)", "hsl(140 55% 52%)", "hsl(290 55% 62%)"];

function Art({ id }: { id: string }) {
  switch (id) {
    case "welcome":
      return (
        <>
          {[0, 1, 2, 3].map((i) => (
            <g key={i} className="ta-pop" style={d(i * 0.5)}>
              {i > 0 && <line x1={i * 60 - 14} x2={i * 60 + 6} y1={48} y2={48} stroke={C.mute} strokeWidth={1.5} />}
              <rect x={10 + i * 60} y={30} width={40} height={36} rx={8} fill="#fff" stroke={C.line} />
              <rect x={18 + i * 60} y={40} width={24} height={5} rx={2} fill={i === 3 ? C.weights : HUES[i]} />
              <rect x={18 + i * 60} y={50} width={16} height={5} rx={2} fill={C.line} />
            </g>
          ))}
        </>
      );
    case "session":
      return (
        <>
          <circle cx={40} cy={48} r={12} fill={HUES[0]} />
          <circle cx={40} cy={48} r={17} fill="none" stroke={C.decode} strokeWidth={3} strokeDasharray={107} className="ta-ring" transform="rotate(-90 40 48)" />
          <g className="ta-go" style={go(120, 0)}>
            <rect x={62} y={40} width={24} height={16} rx={4} fill="#fff" stroke={HUES[0]} strokeWidth={1.5} />
            <rect x={66} y={44} width={14} height={1.5} fill={C.mute} />
            <rect x={66} y={48} width={14} height={1.5} fill={C.mute} />
            <rect x={66} y={52} width={8} height={1.5} fill={C.mute} />
          </g>
          <circle cx={200} cy={30} r={7} fill="hsl(200 55% 80%)" />
          <circle cx={200} cy={66} r={7} fill="hsl(200 35% 88%)" />
          <text x={212} y={33}>typing</text>
          <text x={212} y={69}>idle</text>
        </>
      );
    case "assemble":
      return (
        <>
          {["Why", " does", " decod", "e", " stay", " memor", "y-bou", "nd?"].map((t, i) => (
            <g key={i} className="ta-pop" style={d(i * 0.22)}>
              <rect x={12 + (i % 4) * 44} y={22 + Math.floor(i / 4) * 20} width={40} height={15} rx={3} fill={`hsl(${200 + (i % 4) * 22} 75% ${90 - (i % 2) * 4}%)`} />
              <text x={15 + (i % 4) * 44} y={33} dy={Math.floor(i / 4) * 20} className="mono">
                {t}
              </text>
            </g>
          ))}
          <rect x={12} y={72} width={176} height={6} rx={3} fill={C.soft} />
          <rect x={12} y={72} width={130} height={6} rx={3} fill="hsl(200 50% 80%)" className="ta-grow" />
          <rect x={142} y={72} width={46} height={6} rx={3} fill={HUES[0]} className="ta-grow" style={d(1.2)} />
          <text x={196} y={78}>history + new</text>
        </>
      );
    case "store":
      return (
        <>
          <rect x={20} y={24} width={200} height={50} rx={10} fill="#fff" stroke={C.line} />
          {Array.from({ length: 24 }, (_, i) => (
            <rect key={i} x={32 + i * 7} y={40} width={4} height={16} rx={1} fill={i % 2 ? "#cbd5e1" : "#94a3b8"} className="ta-pop" style={d(i * 0.11)} />
          ))}
          <text x={32} y={68}>user turn, answer, user turn, answer …</text>
        </>
      );
    case "router":
      return (
        <>
          <rect x={14} y={34} width={46} height={30} rx={8} fill="#fff" stroke={C.line} />
          {[0, 1, 2].map((i) => (
            <rect key={i} x={20 + i * 10} y={22} width={7} height={7} rx={2} fill={HUES[i + 1]} />
          ))}
          <rect x={180} y={10} width={46} height={30} rx={8} fill="#fff" stroke={C.line} />
          <rect x={180} y={58} width={46} height={30} rx={8} fill="#fff" stroke={C.line} />
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={62 - i * 8} y={45} width={6} height={6} rx={1.5} fill={HUES[0]} className="ta-go" style={go(116 + i * 8, -22, i * 0.06)} />
          ))}
          {[0, 1, 2].map((i) => (
            <rect key={i} x={62 - i * 8} y={45} width={6} height={6} rx={1.5} fill={HUES[1]} className="ta-go" style={go(116 + i * 8, 26, 1.5 + i * 0.06)} />
          ))}
          <text x={186} y={29}>pod-1</text>
          <text x={186} y={77}>pod-2</text>
        </>
      );
    case "weights":
      return (
        <>
          <rect x={20} y={14} width={200} height={68} rx={9} fill="#fbfcfe" stroke={C.line} />
          <rect x={28} y={24} width={46} height={50} rx={3} fill={C.line} />
          <rect x={28} y={24} width={46} height={50} rx={3} fill={C.weights} className="ta-rise" />
          <rect x={77} y={24} width={3} height={50} fill={C.mute} />
          {Array.from({ length: 40 }, (_, i) => (
            <rect key={i} x={84 + (i % 10) * 10} y={24 + Math.floor(i / 10) * 12.5} width={8.5} height={11} fill="#eef2f7" />
          ))}
          <rect x={186} y={24} width={26} height={50} rx={3} fill="url(#ta-hatch)" stroke="#dbe2ea" />
          <text x={30} y={94}>weights</text>
          <text x={104} y={94}>KV pool</text>
          <text x={176} y={94}>headroom</text>
        </>
      );
    case "slots":
      return (
        <>
          {Array.from({ length: 8 }, (_, i) => (
            <g key={i}>
              <rect x={24 + i * 25} y={22} width={20} height={48} rx={4} fill={C.soft} />
              {i < 6 && <rect x={24 + i * 25} y={22} width={20} height={48} rx={4} fill={C.prefill} className="ta-rise" style={d(i * 0.15, { animationDuration: "5s" })} />}
              {i < 6 && <rect x={24 + i * 25} y={22} width={20} height={48} rx={4} fill={C.decode} className="ta-rise2" style={d(i * 0.15)} />}
              {i < 6 && <rect x={24 + i * 25} y={22} width={20} height={4} fill={HUES[i % 4]} />}
            </g>
          ))}
          <text x={24} y={86}>orange: prompt being prefilled · blue: answer so far</text>
        </>
      );
    case "grid":
      return (
        <>
          {Array.from({ length: 60 }, (_, i) => {
            const owner = [3, 17, 22, 41, 8, 30, 52, 11, 46, 27, 35, 5, 58, 19].indexOf(i);
            const pale = [14, 15, 16, 44, 45].includes(i);
            return (
              <g key={i}>
                <rect x={30 + (i % 15) * 12} y={18 + Math.floor(i / 15) * 14} width={10.5} height={12.5} fill={pale ? "hsl(290 38% 86%)" : "#eef2f7"} />
                {owner >= 0 && <rect x={30 + (i % 15) * 12} y={18 + Math.floor(i / 15) * 14} width={10.5} height={12.5} fill={HUES[owner % 3]} className="ta-pop" style={d(owner * 0.2, { animationDuration: "5s" })} />}
              </g>
            );
          })}
          <text x={30} y={90}>one colour per session · pale: cached, idle</text>
        </>
      );
    case "roofline":
      return (
        <>
          {Array.from({ length: 24 }, (_, i) => (
            <rect key={i} x={20 + i * 8.5} y={20} width={7} height={8} fill={C.line} />
          ))}
          <rect x={20} y={20} width={24} height={8} fill={C.decode} className="ta-sweep" />
          <rect x={20} y={54} width={130} height={7} rx={3.5} fill="#e6effb" />
          <rect x={152} y={54} width={70} height={7} rx={3.5} fill="#fde7dd" />
          <rect x={150} y={49} width={1.5} height={17} fill={C.ink} />
          <circle cx={60} cy={57.5} r={6} className="ta-jump" style={go(140, 0)} />
          <text x={20} y={80}>memory-bound</text>
          <text x={136} y={80}>ridge</text>
          <text x={172} y={80}>compute</text>
          <text x={20} y={44}>one sweep = one engine step through every layer</text>
        </>
      );
    case "stream":
      return (
        <>
          <rect x={176} y={14} width={50} height={34} rx={8} fill="#fff" stroke={C.line} />
          <text x={186} y={35}>pod</text>
          <circle cx={26} cy={74} r={10} fill={HUES[2]} />
          <path d="M176 40 C 120 44, 90 78, 38 76" fill="none" stroke={C.line} strokeWidth={1.5} />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} x={170} y={38} width={5} height={5} rx={1} fill={C.decode} className="ta-go" style={go(-134, 34, i * 0.45)} />
          ))}
          <text x={60} y={30}>one dot = one output token</text>
        </>
      );
    case "tiers":
      return (
        <>
          {Array.from({ length: 30 }, (_, i) => (
            <rect key={i} x={30 + (i % 15) * 12} y={8 + Math.floor(i / 15) * 12} width={10.5} height={10.5} fill={[3, 4, 5, 18, 19].includes(i) ? "hsl(20 38% 86%)" : i % 3 ? HUES[i % 4] : "#eef2f7"} />
          ))}
          {[3, 4, 5].map((i, k) => (
            <rect key={i} x={30 + i * 12} y={8} width={10.5} height={10.5} fill="none" stroke={C.evict} strokeWidth={1.4} className="ta-blink" style={d(k * 0.1)} />
          ))}
          {[
            ["DRAM", C.dram, 42, 0],
            ["SSD", C.ssd, 58, 1],
            ["remote", C.remote, 74, 2]
          ].map(([l, c, y, k]) => (
            <g key={l as string}>
              <text x={30} y={(y as number) + 8}>{l}</text>
              <rect x={72} y={y as number} width={138} height={9} rx={3} fill={C.soft} />
              <rect x={72} y={y as number} width={40 + (k as number) * 22} height={9} rx={3} fill={c as string} opacity={0.75} className="ta-grow" style={d((k as number) * 0.9)} />
            </g>
          ))}
          {[0, 1, 2].map((k) => (
            <rect key={k} x={68 + k * 12} y={10} width={6} height={6} rx={1.5} fill={C.dram} className="ta-go" style={go(30, 34, k * 0.12)} />
          ))}
          <text x={30} y={96}>then the text in the conversation store</text>
        </>
      );
    case "menus":
      return (
        <>
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect x={30} y={26 + i * 22} width={180} height={4} rx={2} fill={C.line} />
              <circle cx={70 + i * 30} cy={28 + i * 22} r={7} fill={C.ink} className="ta-jump" style={go(50 - i * 40, 0, i * 0.4)} />
            </g>
          ))}
        </>
      );
    default:
      return (
        <>
          <circle cx={46} cy={48} r={20} fill={C.ink} />
          <rect x={39} y={39} width={5} height={18} fill="#fff" />
          <rect x={48} y={39} width={5} height={18} fill="#fff" />
          <rect x={90} y={30} width={110} height={36} rx={9} fill="#fff" stroke={C.line} />
          <rect x={100} y={40} width={60} height={5} rx={2} fill={C.mute} />
          <rect x={100} y={50} width={40} height={5} rx={2} fill={C.line} />
          <rect x={206} y={36} width={26} height={24} rx={7} fill={C.decode} className="ta-blink" />
          <path d="M215 42 l8 6 l-8 6 z" fill="#fff" />
        </>
      );
  }
}

export function TourArt({ id }: { id: string }) {
  return (
    <svg className="lv-tour-art" viewBox="0 0 240 100" role="img" aria-label="Preview of the animation">
      <defs>
        <pattern id="ta-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="#f8fafc" />
          <rect width="1" height="5" fill="#dbe2ea" />
        </pattern>
      </defs>
      <Art id={id} />
    </svg>
  );
}

/** Where each step points. The wording of every step is in src/content/tutorial.md, in this order. */
const TARGETS: { id: string; target?: TourStep["target"] }[] = [
  { id: "welcome" },
  { id: "session", target: { type: "session", id: -1 } },
  { id: "assemble", target: { type: "tokenizer" } },
  { id: "store", target: { type: "store" } },
  { id: "router", target: { type: "gateway" } },
  { id: "weights", target: { type: "pod", id: -1, part: "gpu" } },
  { id: "slots", target: { type: "pod", id: -1, part: "engine" } },
  { id: "grid", target: { type: "pod", id: -1, part: "gpu" } },
  { id: "roofline", target: { type: "pod", id: -1, part: "roofline" } },
  { id: "stream", target: { type: "stream" } },
  { id: "tiers", target: { type: "pod", id: -1, part: "tiers" } },
  { id: "menus", target: { el: "right" } },
  { id: "step", target: { el: "transport" } }
];

export const TOUR: TourStep[] = TARGETS.map((t) => ({ ...t, ...tourText(t.id) }));
