/**
 * The generated parts of `docs/blis-parity.md`: the headline numbers, the known differences with their
 * reasons, and the approaches that cannot be verified. The rest of the page is prose.
 * `pnpm docs:sync` rewrites them; a test fails when they are out of date.
 */
import { loadFitted } from "./calibration/fitted.js";
import { loadScenario, scenarioIds } from "./scenario.js";
import type { Summary } from "./summary.js";

const pct = (x: number): string => `${(x * 100).toFixed(1)} percent`;

export function renderHeadline(s: Summary): string {
  const k = s.checks.byKind;
  const row = (name: string, c: (typeof k)["exact"], agree: number, how: string) => `| ${name} | ${c.total} | ${agree} | ${c.known_difference ?? 0} | ${how} |`;
  return [
    `**${s.headline.definition}: ${s.headline.agree} of ${s.headline.total} (${pct(s.headline.share)}), with ${s.headline.knownDifferences} known differences.** Regenerate with \`pnpm conformance:summary\`; the figures below are in \`conformance/summary.json\`, kept in step with the scenarios by a test.`,
    "",
    "| Kind of check | Checks | Agree | Known difference | Agree means |",
    "|---|---|---|---|---|",
    row("Exact", k.exact, k.exact.exact ?? 0, "every key of an integer or decision equal"),
    row("Calibrated", k.calibrated, k.calibrated.within_tolerance ?? 0, "within the scenario's relative tolerance, after the fit"),
    row("Directional", k.directional, k.directional.directional_agree ?? 0, "same direction, effect within the scenario's factor band"),
    "",
    `Approaches in the registry: ${s.approaches.verified} of ${s.approaches.total} are named by at least one scenario; ${s.approaches.notVerifiable} cannot be verified (below). Being named by a scenario means checked, not agreeing: several approaches appear in a check that is a known difference. Approaches that cannot be verified are not in the figure at all, in either direction.`,
    "",
    `Scenarios: ${s.scenarios.total}, of which ${s.scenarios.calibration} are calibration data (they carry no checks; the fit uses them) and ${s.scenarios.withChecks} carry the ${s.checks.total} checks. BLIS commit: \`${s.blisCommit.slice(0, 8)}\`.`
  ].join("\n");
}

/** The one figure the root README quotes in prose; a test fails if the README says anything else. */
export function readmeFigure(s: Summary): string {
  return `${s.headline.agree} of ${s.headline.total} checks agree (${pct(s.headline.share)})`;
}

/** The table of the README's parity section. */
export function renderReadmeParity(s: Summary): string {
  const k = s.checks.byKind;
  const row = (name: string, what: string, c: (typeof k)["exact"], agree: number) => `| ${name} | ${what} | ${c.total} | ${agree} | ${c.known_difference ?? 0} |`;
  return [
    "| Kind of check | What must hold | Checks | Agree | Known difference |",
    "|---|---|---|---|---|",
    row("Exact", "Integers and decisions are equal: KV blocks per replica, cached prefix tokens, the pod chosen, which requests are shed or preempted", k.exact, k.exact.exact ?? 0),
    row("Calibrated", "A timing or rate is within the tolerance written in the scenario, after the cost model's efficiency factors are fitted to BLIS on separate scenarios", k.calibrated, k.calibrated.within_tolerance ?? 0),
    row("Directional", "The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling)", k.directional, k.directional.directional_agree ?? 0),
    `| **All** | | **${s.checks.total}** | **${s.headline.agree}** | **${s.headline.knownDifferences}** |`,
    "",
    `${s.approaches.verified} of the ${s.approaches.total} approaches in the table above are covered by at least one check; ${s.approaches.notVerifiable} have no counterpart in BLIS and are counted neither way. BLIS commit \`${s.blisCommit.slice(0, 8)}\`; regenerate with \`pnpm conformance:summary && pnpm docs:sync\`.`
  ].join("\n");
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export function renderKnownDifferences(): string {
  const out: string[] = [];
  for (const id of scenarioIds()) {
    const scenario = loadScenario(id);
    for (const check of scenario.checks) {
      if (!check.knownDifference) continue;
      const diffs = Object.entries(check.knownDifference.differences);
      const shown = diffs
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${String(v.typescript)} / ${String(v.blis)}`)
        .join("; ");
      const values = diffs.length > 3 ? `${diffs.length} values differ, for example ${shown}` : shown;
      out.push(`- **\`${id}\` / \`${check.id}\`** (${check.kind}). ${check.claim} TypeScript / BLIS: ${values}. ${oneLine(check.knownDifference.reason)}`);
    }
  }
  return out.join("\n\n");
}

export function renderNotVerifiable(s: Summary): string {
  return s.notVerifiable.map((n) => `- **\`${n.approach}\`.** ${n.reason}`).join("\n");
}

/** The fitted timing parameters per pair, beside the site's defaults, and how far the fit leaves each calibration scenario from BLIS. */
export function renderCalibration(): string {
  const fitted = loadFitted();
  const pct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  const rows = ["| Pair | MBU | MFU | Host ms, fixed | Host ms, per sequence | Loss at defaults, at fit | Worst residual, time to first token | Worst residual, time per token |", "|---|---|---|---|---|---|---|---|"];
  for (const [key, p] of Object.entries(fitted.pairs)) {
    const worst = (f: (r: (typeof p.residuals)[number]) => number): string => pct(p.residuals.map(f).reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)));
    const cell = (v: number, d: number): string => `${v} (default ${d})`;
    rows.push(
      `| \`${key}\` | ${cell(p.timing.mbu, p.defaults.mbu)} | ${cell(p.timing.mfu, p.defaults.mfu)} | ${cell(p.timing.hostMsBase, p.defaults.hostMsBase)} | ${cell(p.timing.hostMsPerSeq, p.defaults.hostMsPerSeq)} | ${p.lossAtDefaults}, ${p.lossAtFit} | ${worst((r) => r.ttftMean)} | ${worst((r) => r.tpotMean)} |`
    );
  }
  const extras = Object.entries(fitted.pairs).flatMap(([key, p]) => [
    ...(p.specCost ? [`- \`${key}\`: draft cost \`specCost\` ${p.specCost.value} (default ${p.specCost.defaultValue}); time per token ${pct(p.specCost.residualTpot)} from BLIS's on \`${p.specCost.scenario}\`. BLIS prices its n-gram drafter at nothing, so the fit goes to the lower bound.`] : []),
    ...(p.linkGbps ? [`- \`${key}\`: link rate \`linkGbps\` ${p.linkGbps.value} Gbit/s (default ${p.linkGbps.defaultValue}); hand-over time ${pct(p.linkGbps.residualKvTransfer)} from BLIS's on \`${p.linkGbps.scenario}\`. BLIS's fabric is 400 Gbit/s InfiniBand at 0.811 of line rate, which is 324 Gbit/s.`] : [])
  ]);
  return [...rows, "", ...extras].join("\n");
}
