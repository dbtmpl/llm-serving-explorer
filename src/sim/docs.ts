/**
 * Renders the tables of concepts, approaches and sources that appear in the READMEs.
 * The READMEs are kept in step with the code by a test; run `pnpm docs:sync` to rewrite them.
 */
import type { Concept, Fidelity } from "./approach.js";
import { CITATIONS, citeMarkdown, type CitationKey } from "./citations.js";
import { isVerifiable, type Verification } from "./verification.js";

const FIDELITY_LABEL: Record<Fidelity, string> = {
  exact: "Exact",
  structural: "Structural",
  simplified: "Simplified"
};

const escapeCell = (text: string): string => text.replace(/\|/g, "\\|");

/** The "Verified against BLIS" cell: the scenarios that check the approach (named when there are few), or that none can. */
export function verificationCell(v: Verification): string {
  if (!isVerifiable(v)) return "Not verifiable";
  return v.length <= 3 ? `Yes: ${v.map((id) => `\`${id}\``).join(", ")}` : `Yes: ${v.length} scenarios`;
}

/** One row per approach. `linkPrefix` is the path from the README to `src/sim/`. */
export function renderApproachTable(concepts: readonly Concept[], linkPrefix: string | null): string {
  const rows = ["| Concept | Approach | What it does | Fidelity | Verified against BLIS | Sources |", "|---|---|---|---|---|---|"];
  for (const concept of concepts) {
    const title = linkPrefix === null ? concept.title : `[${concept.title}](${linkPrefix}${concept.module}/)`;
    for (const a of concept.approaches) {
      rows.push(`| ${title} | ${escapeCell(a.name)} | ${escapeCell(a.summary)} | ${FIDELITY_LABEL[a.fidelity]} | ${verificationCell(a.verification)} | ${a.citations.map(citeMarkdown).join("; ")} |`);
    }
  }
  return rows.join("\n");
}

/** Every source in the registry, with the approaches that cite it. */
export function renderCitationList(concepts: readonly Concept[]): string {
  const usedBy = new Map<CitationKey, string[]>();
  for (const concept of concepts) {
    for (const a of concept.approaches) {
      for (const key of a.citations) usedBy.set(key, [...(usedBy.get(key) ?? []), a.name]);
    }
  }
  const lines: string[] = [];
  for (const key of Object.keys(CITATIONS) as CitationKey[]) {
    const c = CITATIONS[key];
    const users = usedBy.get(key);
    lines.push(`- **${c.short}.** [${c.title}](${c.url}).${users ? ` Used by: ${[...new Set(users)].join(", ")}.` : ""}`);
  }
  return lines.join("\n");
}

/** Replace the text between a pair of markers, keeping the markers. */
export function replaceGenerated(document: string, name: string, content: string): string {
  const start = `<!-- generated:${name}:start -->`;
  const end = `<!-- generated:${name}:end -->`;
  const from = document.indexOf(start);
  const to = document.indexOf(end);
  if (from < 0 || to < from) throw new Error(`Markers for "${name}" not found`);
  return `${document.slice(0, from + start.length)}\n${content}\n${document.slice(to)}`;
}
