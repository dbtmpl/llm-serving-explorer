/**
 * The generated parts of `docs/parity.md` (one block set per reference) and of the root README's
 * parity section. The rest of those pages is prose. `pnpm docs:sync` rewrites them; a test fails
 * when they are out of date.
 */
import { loadFitted } from "./calibration/fitted.js";
import { REFERENCES, referenceById } from "./refs/index.js";
import { loadScenario, scenarioIds, SPAN } from "./scenario.js";
import type { ReferenceSummary, Summary } from "./summary.js";

const pct = (x: number): string => `${(x * 100).toFixed(1)} percent`;

/** `Check -> text`: the sentence that names a recorded value pair, with the references' real names. */
const nameOf = (id: string): string => (id === "typescript" ? "TypeScript" : id === SPAN ? "span" : referenceById(id).name);

export function renderHeadline(s: Summary, ref: string): string {
  const r = s.references[ref]!;
  const k = r.checks.byKind;
  const row = (name: string, c: (typeof k)["exact"], agree: number, how: string) => `| ${name} | ${c.total} | ${agree} | ${c.known_difference ?? 0} | ${how} |`;
  const disputed = r.checks.disputed ? ` ${r.checks.disputed} checks it shares with another reference that disagrees with it are in the cross-reference section, not here.` : "";
  return [
    `**${r.headline.definition}: ${r.headline.agree} of ${r.headline.total} (${pct(r.headline.share)}), with ${r.headline.knownDifferences} known differences.** Regenerate with \`pnpm conformance:summary\`; the figures below are in \`conformance/summary.json\`, kept in step with the scenarios by a test.${disputed}`,
    "",
    "| Kind of check | Checks | Agree | Known difference | Agree means |",
    "|---|---|---|---|---|",
    row("Exact", k.exact, k.exact.exact ?? 0, "every key of an integer or decision equal"),
    row("Calibrated", k.calibrated, k.calibrated.within_tolerance ?? 0, "within the scenario's relative tolerance"),
    row("Directional", k.directional, k.directional.directional_agree ?? 0, "same direction, effect within the scenario's factor band"),
    "",
    `Approaches in the registry: ${r.verified.length} of ${s.approaches.total} are named by at least one scenario this reference covers; ${s.approaches.notVerifiable} are named by none and say why (below). Being named by a scenario means checked, not agreeing: several approaches appear in a check that is a known difference. Approaches that cannot be verified are not in the figure at all, in either direction.`,
    "",
    `Scenarios this reference covers: ${r.scenarios.total}, of which ${r.scenarios.calibration} are calibration data (they carry no checks; the fit uses them) and ${r.scenarios.withChecks} carry the ${r.checks.total + r.checks.disputed} checks. ${r.name} ${r.kind === "simulator" ? "commit" : "revision"}: \`${r.lock.slice(0, 8)}\`.`
  ].join("\n");
}

/** The one figure per reference that the root README quotes in prose; a test fails if the README says anything else. */
export function readmeFigure(s: Summary, ref: string): string {
  const h = s.references[ref]!.headline;
  return `${h.agree} of ${h.total} checks agree (${pct(h.share)})`;
}

/** The table of the README's parity section: one block per reference. */
export function renderReadmeParity(s: Summary): string {
  const out: string[] = [];
  for (const r of Object.values(s.references)) {
    if (!r.checks.total) continue;
    const k = r.checks.byKind;
    const row = (name: string, what: string, c: (typeof k)["exact"], agree: number) => `| ${name} | ${what} | ${c.total} | ${agree} | ${c.known_difference ?? 0} |`;
    out.push(
      `**${r.name}** (${r.kind === "simulator" ? "commit" : "revision"} \`${r.lock.slice(0, 8)}\`): ${r.headline.agree} of ${r.headline.total} checks agree (${pct(r.headline.share)}), ${r.headline.knownDifferences} known differences. ${r.verified.length} of the ${s.approaches.total} approaches in the table above are covered by at least one of its scenarios.`,
      "",
      "| Kind of check | What must hold | Checks | Agree | Known difference |",
      "|---|---|---|---|---|",
      row("Exact", "Integers and decisions are equal (KV blocks per replica, cached prefix tokens, the pod chosen, which requests are shed or preempted)", k.exact, k.exact.exact ?? 0),
      row("Calibrated", "A timing or rate is within the tolerance written in the scenario", k.calibrated, k.calibrated.within_tolerance ?? 0),
      row("Directional", "The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling)", k.directional, k.directional.directional_agree ?? 0),
      `| **All** | | **${r.checks.total}** | **${r.headline.agree}** | **${r.headline.knownDifferences}** |`,
      ""
    );
  }
  out.push(`${s.approaches.notVerifiable} of the ${s.approaches.total} approaches have no counterpart in any reference and are counted neither way; regenerate with \`pnpm conformance:summary && pnpm docs:sync\`.`);
  return out.join("\n");
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The known differences of one reference, with the model's value first and the reference's second. */
export function renderKnownDifferences(ref: string): string {
  const out: string[] = [];
  for (const id of scenarioIds()) {
    const scenario = loadScenario(id);
    for (const check of scenario.checks) {
      const k = check.knownDifferences.find((x) => x.reference === ref);
      if (!k) continue;
      const diffs = Object.entries(k.differences);
      const shown = diffs
        .slice(0, 3)
        .map(([key, v]) => `${key}: ${String(v.typescript)} / ${String(v[ref])}`)
        .join("; ");
      const values = diffs.length > 3 ? `${diffs.length} values differ, for example ${shown}` : shown;
      out.push(`- **\`${id}\` / \`${check.id}\`** (${check.kind}). ${check.claim} TypeScript / ${nameOf(ref)}: ${values}. ${oneLine(k.reason)}`);
    }
  }
  return out.join("\n\n");
}

/** Checks that several references cover: how the model and the references stand, and every recorded gap. */
export function renderCrossReference(s: Summary): string {
  const c = s.crossReference;
  if (!c.checks) return `No check is covered by more than one reference yet (${REFERENCES.map((r) => r.name).join(", ")}): the references cover different GPUs and models. The comparison between references is implemented and tested on synthetic records (\`conformance/__tests__/references.test.ts\`).`;
  const rows = ["| Scenario / check | References | Standing |", "|---|---|---|", ...c.entries.map((e) => `| \`${e.scenario}\` / \`${e.check}\` | ${e.references.map(nameOf).join(", ")} | ${e.agreement.replace(/_/g, " ")} |`)];
  const gaps: string[] = [];
  for (const id of scenarioIds())
    for (const check of loadScenario(id).checks) if (check.referenceGap) gaps.push(`- **\`${id}\` / \`${check.id}\`.** ${oneLine(check.referenceGap.reason)}`);
  return [...rows, "", ...gaps].join("\n");
}

export function renderNotVerifiable(s: Summary): string {
  return s.notVerifiable.map((n) => `- **\`${n.approach}\`.** ${n.reason}`).join("\n");
}

/** The fitted timing parameters per pair, beside the site's defaults, and how far the fit leaves each calibration scenario from the reference. */
export function renderCalibration(ref: string): string {
  const fitted = loadFitted().references[ref];
  if (!fitted) return "No timing parameters are fitted to this reference.";
  const pctSigned = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const rows = ["| Pair | MBU | MFU | Host ms, fixed | Host ms, per sequence | Loss at defaults, at fit | Worst residual, time to first token | Worst residual, time per token |", "|---|---|---|---|---|---|---|---|"];
  for (const [key, p] of Object.entries(fitted.pairs)) {
    const worst = (f: (r: (typeof p.residuals)[number]) => number): string => pctSigned(p.residuals.map(f).reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)));
    const cell = (v: number, d: number): string => `${v} (default ${d})`;
    rows.push(
      `| \`${key}\` | ${cell(p.timing.mbu, p.defaults.mbu)} | ${cell(p.timing.mfu, p.defaults.mfu)} | ${cell(p.timing.hostMsBase, p.defaults.hostMsBase)} | ${cell(p.timing.hostMsPerSeq, p.defaults.hostMsPerSeq)} | ${p.lossAtDefaults}, ${p.lossAtFit} | ${worst((r) => r.ttftMean)} | ${worst((r) => r.tpotMean)} |`
    );
  }
  const name = nameOf(ref);
  const extras = Object.entries(fitted.pairs).flatMap(([key, p]) => [
    ...(p.specCost ? [`- \`${key}\`: draft cost \`specCost\` ${p.specCost.value} (default ${p.specCost.defaultValue}); time per token ${pctSigned(p.specCost.residualTpot)} from ${name}'s on \`${p.specCost.scenario}\`. BLIS prices its n-gram drafter at nothing, so the fit goes to the lower bound.`] : []),
    ...(p.linkGbps ? [`- \`${key}\`: link rate \`linkGbps\` ${p.linkGbps.value} Gbit/s (default ${p.linkGbps.defaultValue}); hand-over time ${pctSigned(p.linkGbps.residualKvTransfer)} from ${name}'s on \`${p.linkGbps.scenario}\`. BLIS's fabric is 400 Gbit/s InfiniBand at 0.811 of line rate, which is 324 Gbit/s.`] : [])
  ]);
  return [...rows, "", ...extras].join("\n");
}

export type { ReferenceSummary };
