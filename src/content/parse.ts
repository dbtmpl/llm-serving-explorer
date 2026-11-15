/**
 * Parser for the markdown files in this directory (format: see README.md).
 * It is deliberately strict: anything it does not understand throws, so a typo in a content
 * file fails the tests instead of rendering as odd text.
 */

export interface Entry {
  id: string;
  headline: string;
  /** one sentence saying where and when the text is shown */
  where: string;
  /** field name to markdown text */
  fields: Record<string, string>;
}

export interface Doc {
  /** name used in error messages */
  name: string;
  title: string;
  description: string;
  entries: Map<string, Entry>;
}

const ENTRY = /^## `([^`]+)` (\S.*)$/;
const FIELD = /^### ([a-z][a-z0-9-]*)$/;
const WHERE = /^_Where:_ (\S.*)$/;

export function parseDoc(raw: string, name: string): Doc {
  const fail = (line: number, message: string): never => {
    throw new Error(`${name}:${line + 1}: ${message}`);
  };
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const title = /^# (\S.*)$/.exec(lines[0] ?? "")?.[1];
  if (!title) fail(0, "the file must start with an `# H1` title");

  const doc: Doc = { name, title: title!, description: "", entries: new Map() };
  const description: string[] = [];
  let entry: Entry | null = null;
  let field: string | null = null;
  let buffer: string[] = [];

  const closeField = () => {
    if (entry && field) {
      const text = buffer.join("\n").trim();
      if (!text) throw new Error(`${name}: entry ${entry.id}, field ${field} is empty`);
      entry.fields[field] = text;
    }
    field = null;
    buffer = [];
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) {
      closeField();
      const m = ENTRY.exec(line);
      if (!m) fail(i, "an entry heading is ## `id` Headline");
      if (doc.entries.has(m![1]!)) fail(i, `duplicate id ${m![1]}`);
      entry = { id: m![1]!, headline: m![2]!, where: "", fields: {} };
      doc.entries.set(entry.id, entry);
    } else if (line.startsWith("### ")) {
      if (!entry) fail(i, "a field outside an entry");
      closeField();
      const m = FIELD.exec(line);
      if (!m) fail(i, "a field heading is ### lower-case-name");
      if (m![1]! in entry!.fields) fail(i, `duplicate field ${m![1]} in ${entry!.id}`);
      field = m![1]!;
    } else if (line.startsWith("#")) {
      fail(i, "only #, ## and ### headings are used");
    } else if (!entry) {
      description.push(line);
    } else if (!field) {
      if (!line.trim()) continue;
      const m = WHERE.exec(line);
      if (!m || entry.where) fail(i, "after the heading comes one `_Where:_ ...` line, then ### fields");
      entry.where = m![1]!;
    } else {
      buffer.push(line);
    }
  }
  closeField();
  doc.description = description.join("\n").trim();
  if (!doc.description) throw new Error(`${name}: missing description paragraph under the title`);
  return doc;
}

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

export type Values = Readonly<Record<string, string | number>>;

/** The names of the `{placeholders}` in a template. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** Fill `{name}` placeholders. A placeholder without a value throws. */
export function fill(template: string, values: Values = {}): string {
  return template.replace(PLACEHOLDER, (_, key: string) => {
    if (!(key in values)) throw new Error(`placeholder {${key}} has no value in: ${template.slice(0, 60)}`);
    return String(values[key]);
  });
}

/** One output field is made of one or more content fields joined by a space; falsy parts are skipped. */
export type Pick = string | readonly (string | false | null | undefined)[];

/**
 * Fill the chosen fields of an entry. Every placeholder needs a value, and every value must be
 * used by one of the chosen fields; both mistakes throw.
 */
export function fillEntry<K extends string>(doc: Doc, id: string, pick: Record<K, Pick>, values: Values = {}): Record<K, string> {
  const entry = doc.entries.get(id);
  if (!entry) throw new Error(`${doc.name}: no entry ${id}`);
  const used = new Set<string>();
  const out = {} as Record<K, string>;
  for (const key of Object.keys(pick) as K[]) {
    const names = ([] as (string | false | null | undefined)[]).concat(pick[key] as never).filter((n): n is string => typeof n === "string");
    out[key] = names
      .map((n) => {
        const template = entry.fields[n];
        if (template === undefined) throw new Error(`${doc.name}: entry ${id} has no field ${n}`);
        for (const p of placeholders(template)) used.add(p);
        return fill(template, values);
      })
      .join(" ");
  }
  for (const k of Object.keys(values)) if (!used.has(k)) throw new Error(`${doc.name}: entry ${id}: value ${k} is not used by any chosen field`);
  return out;
}

export const hasField = (doc: Doc, id: string, field: string): boolean => doc.entries.get(id)?.fields[field] !== undefined;
