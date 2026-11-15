/**
 * What every pluggable piece of the simulation must declare about itself.
 *
 * A "concept" is a decision the serving stack has to make (how to route, when to admit, what to
 * evict). An "approach" is one published or deployed way of making it. Each module under `src/sim/`
 * owns one concept, defines the interface an approach implements, and keeps a registry of the
 * approaches it supports.
 */
import type { CitationKey } from "./citations.js";
import type { Verification } from "./verification.js";

/** How closely an approach follows its source. Shown in the READMEs so readers know what to trust. */
export type Fidelity =
  /** A formula or rule reproduced as published and checked by a unit test. */
  | "exact"
  /** The mechanism follows the source; constants are ours and exposed as parameters. */
  | "structural"
  /** A deliberately simplified stand-in. The docstring says what is left out. */
  | "simplified";

export interface ApproachMeta {
  /** Stable identifier, unique within its concept. */
  id: string;
  /** Name as it appears in tables and menus. */
  name: string;
  /** One or two sentences: what the approach does. */
  summary: string;
  /** At least one source. The first is the primary reference. */
  citations: readonly [CitationKey, ...CitationKey[]];
  fidelity: Fidelity;
  /**
   * The conformance scenarios that check this approach against BLIS, or why BLIS cannot (vLLM does
   * neither, no counterpart in its catalog). Enforced by the registry test; shown in the README tables.
   */
  verification: Verification;
}

export interface Concept<A extends ApproachMeta = ApproachMeta> {
  /** Directory name under `src/sim/`. */
  module: string;
  /** Heading used in the README tables. */
  title: string;
  /** The question this concept answers. */
  question: string;
  approaches: readonly A[];
}

/** Look an approach up by id, failing loudly on a typo rather than silently falling back. */
export function selectApproach<A extends ApproachMeta>(concept: Concept<A>, id: string): A {
  const found = concept.approaches.find((a) => a.id === id);
  if (!found) {
    const known = concept.approaches.map((a) => a.id).join(", ");
    throw new Error(`Unknown ${concept.title} approach "${id}". Known: ${known}.`);
  }
  return found;
}
