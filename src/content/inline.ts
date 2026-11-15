/** Inline markup: **bold**, `code`, [text](https://...), [@key] and [text][@key]. See README.md. */
import { CITATIONS, type CitationKey } from "../sim/index.js";

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

const TOKEN = /\[([^\]]+)\]\[@([A-Za-z0-9]+)\]|\[@([A-Za-z0-9]+)\]|\[([^\]]+)\]\((\S+?)\)|\*\*(.+?)\*\*|`([^`]+)`/g;

export function citation(key: string): { short: string; url: string } {
  const c = (CITATIONS as Record<string, { short: string; url: string } | undefined>)[key];
  if (!c) throw new Error(`unknown citation key @${key}`);
  return c;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (t: string) => t && out.push({ type: "text", text: t });
  for (const m of text.matchAll(TOKEN)) {
    push(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[2]) out.push({ type: "link", text: m[1]!, href: citation(m[2]).url });
    else if (m[3]) out.push({ type: "link", text: citation(m[3]).short, href: citation(m[3]).url });
    else if (m[5]) {
      if (!m[5].startsWith("https://")) throw new Error(`link must be https: ${m[5]}`);
      out.push({ type: "link", text: m[4]!, href: m[5] });
    } else if (m[6]) out.push({ type: "bold", children: parseInline(m[6]) });
    else out.push({ type: "code", text: m[7]! });
  }
  push(text.slice(last));
  return out;
}

/** Paragraphs are separated by a blank line; line breaks inside one become spaces. */
export const paragraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

/** The citation keys a piece of text refers to. */
export const citationKeys = (text: string): string[] => [...text.matchAll(/\[@([A-Za-z0-9]+)\]/g)].map((m) => m[1]!);
