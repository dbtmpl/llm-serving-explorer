/**
 * The explanatory text of the site. The markdown files in this directory are the single source of
 * truth; code selects an entry, fills its `{placeholders}` and renders the result with `<Rich>`.
 * Format and how to add an entry: see README.md.
 */
import architecturesRaw from "./architectures.md?raw";
import inspectorRaw from "./inspector.md?raw";
import panelsRaw from "./panels.md?raw";
import stepThroughRaw from "./step-through.md?raw";
import diveRaw from "./dive-deeper.md?raw";
import tutorialRaw from "./tutorial.md?raw";
import { fillEntry, parseDoc, type Pick, type Values } from "./parse.js";

export { fill, fillEntry, hasField, parseDoc, placeholders, type Doc, type Entry, type Pick, type Values } from "./parse.js";
export { blocks, citation, citationKeys, paragraphs, parseInline, type Block, type Inline } from "./inline.js";

export const STEP_THROUGH = parseDoc(stepThroughRaw, "step-through.md");
export const TUTORIAL = parseDoc(tutorialRaw, "tutorial.md");
export const INSPECTOR = parseDoc(inspectorRaw, "inspector.md");
export const PANELS = parseDoc(panelsRaw, "panels.md");
export const DIVE_DEEPER = parseDoc(diveRaw, "dive-deeper.md");
export const ARCHITECTURE_TEXT = parseDoc(architecturesRaw, "architectures.md");

/** Every document with its raw text, for tests and tooling. */
export const ALL_DOCS = { "step-through": STEP_THROUGH, tutorial: TUTORIAL, inspector: INSPECTOR, panels: PANELS, architectures: ARCHITECTURE_TEXT, "dive-deeper": DIVE_DEEPER } as const;

/** One field of a step-through entry, unfilled (for texts the code repeats, such as the rows of a table). */
export function stepField(id: string, field: string): string {
  const text = STEP_THROUGH.entries.get(id)?.fields[field];
  if (text === undefined) throw new Error(`step-through.md: entry ${id} has no field ${field}`);
  return text;
}

/** One concept of the "Dive deeper" section (dive-deeper.md): its title, body and optional formula, all unfilled markdown. */
export interface DiveConcept {
  id: string;
  title: string;
  body: string;
  formula?: string;
}

/** The concepts of a step, in the order its `### dive` field lists them; empty for a step without the field. */
export function diveConcepts(stepId: string): DiveConcept[] {
  const list = STEP_THROUGH.entries.get(stepId)?.fields["dive"];
  if (!list) return [];
  return list.split(",").map((raw) => {
    const id = raw.trim();
    const e = DIVE_DEEPER.entries.get(id);
    if (!e) throw new Error(`step-through.md: step ${stepId} lists the unknown concept ${id}`);
    return { id, title: e.fields["title"]!, body: e.fields["body"]!, ...(e.fields["formula"] ? { formula: e.fields["formula"] } : {}) };
  });
}

/** A single-text entry of inspector.md; `extra` names more fields to append (optional sentences). */
export function inspectorText(id: string, values: Values = {}, extra: readonly string[] = []): string {
  return fillEntry(INSPECTOR, id, { text: ["text", ...extra] as Pick }, values).text;
}

/** A single-text entry of panels.md. */
export function panelText(id: string, values: Values = {}): string {
  return fillEntry(PANELS, id, { text: "text" }, values).text;
}

/** An entry of panels.md with several named fields (for example the empty-state screen). */
export function panelFields<K extends string>(id: string, pick: Record<K, Pick>, values: Values = {}): Record<K, string> {
  return fillEntry(PANELS, id, pick, values);
}

/** The prose of one serving architecture; `id` is the architecture's id in src/sim/presets. */
export function architectureText(id: string): { name: string; adds: string; source: string } {
  return fillEntry(ARCHITECTURE_TEXT, id, { name: "name", adds: "adds", source: "source" });
}

/** The title and text of one tutorial step; `id` is the step's id in src/live/Tutorial.tsx. */
export function tourText(id: string): { title: string; text: string } {
  return fillEntry(TUTORIAL, id, { title: "title", text: "text" });
}

/** Callout texts (floating boxes and the step-through box); see src/live/callouts.ts. */
export function stepText(id: string, pick: Partial<Record<"title" | "body" | "detail", Pick>> = {}, values: Values = {}): { title: string; body: string; detail?: string; at?: string } {
  const entry = STEP_THROUGH.entries.get(id);
  if (!entry) throw new Error(`step-through.md: no entry ${id}`);
  const base: Record<string, Pick> = { title: "title", body: "body" };
  if (entry.fields.detail !== undefined || pick.detail !== undefined) base.detail = "detail";
  if (entry.fields.at !== undefined) base.at = "at";
  const out = fillEntry(STEP_THROUGH, id, { ...base, ...pick } as Record<"title" | "body" | "detail" | "at", Pick>, values) as { title: string; body: string; detail?: string; at?: string };
  if (!out.detail) delete out.detail;
  return out;
}
