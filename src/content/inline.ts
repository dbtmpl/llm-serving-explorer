/** Inline markup: **bold**, `code`, $tex$, [text](https://...), [@key] and [text][@key]; blocks: see `blocks`. See README.md. */
import { CITATIONS, type CitationKey } from "../sim/index.js";

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string }
  | { type: "math"; tex: string };

const TOKEN = /\$([^$\n]+)\$|\[([^\]]+)\]\[@([A-Za-z0-9]+)\]|\[@([A-Za-z0-9]+)\]|\[([^\]]+)\]\((\S+?)\)|\*\*(.+?)\*\*|`([^`]+)`/g;

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
    if (m[1] !== undefined) out.push({ type: "math", tex: m[1] });
    else if (m[3]) out.push({ type: "link", text: m[2]!, href: citation(m[3]).url });
    else if (m[4]) out.push({ type: "link", text: citation(m[4]).short, href: citation(m[4]).url });
    else if (m[6]) {
      if (!m[6].startsWith("https://")) throw new Error(`link must be https: ${m[6]}`);
      out.push({ type: "link", text: m[5]!, href: m[6] });
    } else if (m[7]) out.push({ type: "bold", children: parseInline(m[7]) });
    else out.push({ type: "code", text: m[8]! });
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

/** A block of a text: a paragraph, a typeset formula (`$$ ... $$`) or a table (lines starting with `|`). */
export type Block = { type: "p"; text: string } | { type: "formula"; tex: string } | { type: "table"; head: string[]; rows: string[][] };

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/** Split a text into blocks. Blocks are separated by a blank line; a table needs a header, a `|---|` rule and rows of equal width. */
export function blocks(text: string): Block[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b): Block => {
      const f = /^\$\$([\s\S]+)\$\$$/.exec(b);
      if (f) return { type: "formula", tex: f[1]!.trim() };
      const lines = b.split("\n");
      if (lines.every((l) => l.trimStart().startsWith("|"))) {
        const [head, rule, ...rows] = lines.map(cells);
        if (!head || !rule || !rule.every((c) => /^:?-{3,}:?$/.test(c))) throw new Error(`a table needs a header row and a |---| rule: ${b.slice(0, 60)}`);
        for (const r of rows) if (r.length !== head.length) throw new Error(`table row has ${r.length} cells, header ${head.length}: ${b.slice(0, 60)}`);
        return { type: "table", head, rows };
      }
      return { type: "p", text: b.replace(/\s*\n\s*/g, " ") };
    });
}
