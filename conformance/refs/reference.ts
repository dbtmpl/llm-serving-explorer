/**
 * What the TypeScript model is compared with: a `Reference`.
 *
 * A reference is anything that can state, for a scenario, the numbers a check compares: a simulator
 * that embeds the real code of the systems being modelled (BLIS), or measurements taken on real
 * hardware. The suite knows only this interface; each reference lives in `conformance/refs/<id>/`.
 *
 * Every reference does the same four things, in this order:
 *
 * - `translate(scenario, arm)`: the scenario as the reference's own input (a simulator's files, or
 *   for measured data the identification of the measurements that answer the scenario).
 * - `run(input)`: the raw output (run a simulator, or load the measurements). May need external
 *   tools or a clone of a repository, so only `pnpm conformance:reference` calls it.
 * - `reduce(scenario, arm, raw)`: the one common record (`record.ts`).
 * - `generate(scenario)`: the committed file for the scenario, `conformance/reference/<id>/<scenario>.json`.
 *   For a simulator that is translate, run and reduce for every arm; for measured data it is reducing
 *   committed or downloaded measurements. Nothing but `generate` is allowed to produce a committed file.
 *
 * What a reference can say is declared in `supports`, so the suite can tell, per scenario and per
 * check, whether the reference applies instead of failing on a quantity it cannot state.
 */
import type { Provenance, ReferenceFile, Reduced } from "../record.js";
import type { Check, Deployment, ExactQuantity, Metric, Scenario } from "../scenario.js";

/** Mechanisms beyond one replica of the engine running a request list that a scenario can exercise. */
export const MECHANISMS = ["multi-replica", "multi-turn", "speculative", "disaggregation", "host-offload", "autoscaling", "shedding"] as const;
export type Mechanism = (typeof MECHANISMS)[number];

export interface Support {
  /** Neutral model names (`scenario.ts`) the reference has data or a catalogue entry for. */
  models: readonly string[];
  /** Neutral GPU names. */
  gpus: readonly string[];
  /** Mechanisms a scenario may exercise. Every reference runs one engine on one request list; this is what it can do beyond that. */
  mechanisms: readonly Mechanism[];
  /** Exact quantities (`ExactQuantity`) the reference states. */
  quantities: readonly ExactQuantity[];
  /** Metrics a calibrated or directional check may use. */
  metrics: readonly Metric[];
  /** Whether a scenario with `arms` (an intervention) can be answered; measured data has one deployment, so it cannot. */
  arms: boolean;
}

/** Per-run settings the generating script hands to a reference. */
export interface GenerateContext {
  /** Directory to keep a run's inputs and outputs in, when the caller wants to look at them. */
  keep?: string;
  /** Settings from the environment and command line (`BLIS_BIN`, a clone's path, ...), by the names the reference documents. */
  settings: Record<string, string | undefined>;
}

export interface Reference<Input = unknown, Raw = unknown> {
  /** Short, stable, used in file names and in the scenario files (`blis`). */
  readonly id: string;
  /** For people (`BLIS`). */
  readonly name: string;
  readonly kind: "simulator" | "measurement";
  /** One paragraph: what agreement with this reference is evidence for, and what it is not. */
  readonly evidence: string;
  readonly supports: Support;
  /** What the reference pins: a commit, a dataset revision. Read from its lock file. */
  lock(): string;
  translate(scenario: Scenario, arm: string): Input;
  run(input: Input, context: GenerateContext): Raw;
  reduce(scenario: Scenario, arm: string, raw: Raw): Reduced;
  /** Produce the committed file for a scenario. Throws, saying why, when the reference cannot answer it. */
  generate(scenario: Scenario, context: GenerateContext): ReferenceFile;
  /** Fails fast, with an actionable message, when `generate` cannot work in this environment (missing binary, wrong checkout). */
  prepare(context: GenerateContext): void;
  /** Hash of everything the reference is given for the scenario; a committed file made from another hash is stale. */
  inputHash(scenario: Scenario): string;
  /** What is wrong with a committed file's provenance (pinned commit differs, ...), or null. */
  provenanceProblem(provenance: Provenance): string | null;
}

/** The mechanisms a deployment exercises. */
export function mechanismsOf(d: Deployment): Mechanism[] {
  const out: Mechanism[] = [];
  if (d.replicas > 1) out.push("multi-replica");
  if (d.requests.some((r) => r.round > 0)) out.push("multi-turn");
  if (d.speculative) out.push("speculative");
  if (d.disagg) out.push("disaggregation");
  if (d.offload) out.push("host-offload");
  if (d.autoscale) out.push("autoscaling");
  if (d.queueDeadlineS > 0) out.push("shedding");
  return out;
}

/** Why the reference cannot answer the scenario at all (its model, GPU, mechanisms or arms), or null when it can. */
export function unsupportedBecause(ref: Pick<Reference, "supports" | "name">, s: Scenario): string | null {
  const arms = Object.values(s.arms);
  if (arms.length > 1 && !ref.supports.arms) return `${ref.name} has one deployment and cannot answer a scenario with arms`;
  for (const d of arms) {
    if (!ref.supports.models.includes(d.model)) return `${ref.name} has no data for the model ${d.model}`;
    if (!ref.supports.gpus.includes(d.gpu)) return `${ref.name} has no data for the GPU ${d.gpu}`;
    const missing = mechanismsOf(d).filter((m) => !ref.supports.mechanisms.includes(m));
    if (missing.length) return `${ref.name} does not model ${missing.join(", ")}`;
  }
  return null;
}

/** Whether the reference can state what a check compares (its quantity or metric). Independent of the scenario. */
export function canState(ref: Pick<Reference, "supports">, check: Check): boolean {
  return check.kind === "exact" || check.kind === "capacity" ? ref.supports.quantities.includes(check.quantity) : ref.supports.metrics.includes(check.metric);
}
