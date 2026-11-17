/**
 * The generated parts of `docs/parity.md` (one block set per reference) and of the root README's
 * parity section. The rest of those pages is prose. `pnpm docs:sync` rewrites them; a test fails
 * when they are out of date.
 */
import { loadFitted } from "./calibration/fitted.js";
import { REFERENCES, referenceById } from "./refs/index.js";
import { GROUPS, GROUP_LABEL, type Distribution } from "./deviation.js";
import { loadScenario, scenarioIds, SPAN } from "./scenario.js";
import type { ReferenceSummary, Summary } from "./summary.js";

const pct = (x: number): string => `${(x * 100).toFixed(1)} percent`;

/** `Check -> text`: the sentence that names a recorded value pair, with the references' real names. */
const nameOf = (id: string): string => (id === "typescript" ? "TypeScript" : id === SPAN ? "span" : referenceById(id).name);

const fmtPct = (x: number | null): string => (x === null ? "unbounded" : x === 0 ? "0%" : x * 100 < 0.1 ? `${(x * 100).toPrecision(1)}%` : `${(x * 100).toFixed(1)}%`);

/** The table of distributions: one row per group, then all groups together. */
function distributionTable(r: ReferenceSummary): string[] {
  const d = r.deviations;
  const row = (label: string, g: Distribution) => `| ${label} | ${g.n} | ${fmtPct(g.median)} | ${fmtPct(g.max)} | ${g.within["1"]} | ${g.within["5"]} | ${g.within["10"]} | ${g.within["25"]} |`;
  return [
    "| Group | Comparisons | Median deviation | Largest deviation | Within 1% | Within 5% | Within 10% | Within 25% |",
    "|---|---|---|---|---|---|---|---|",
    ...GROUPS.filter((g) => d.groups[g].n).map((g) => row(GROUP_LABEL[g], d.groups[g])),
    // pooling a reading before the fit with one after it would answer neither question
    ...(d.groups.timings_defaults.n ? [] : [row("**All**", d.overall)])
  ];
}

/** The sentence the READMEs quote: the median deviation and how many comparisons are within 5%. A test keeps them in step with summary.json. */
export function readmeHeadline(s: Summary, ref: string): string {
  const d = s.references[ref]!.deviations;
  const g = d.groups;
  // a reference with a reading before any fit keeps it apart from the one after: the two answer different questions
  if (g.timings_defaults.n) return `median timing deviation ${fmtPct(g.timings_defaults.median)} over ${g.timings_defaults.n} comparisons with the site's default parameters, ${fmtPct(g.timings.median)} over ${g.timings.n} comparisons on held-out requests after fitting`;
  return `median deviation ${fmtPct(d.overall.median)} over ${d.overall.n} comparisons, ${d.overall.within["5"]} of them within 5%`;
}

export function renderHeadline(s: Summary, ref: string): string {
  const r = s.references[ref]!;
  const k = r.checks.byKind;
  const row = (name: string, c: (typeof k)["exact"], agree: number, how: string) => `| ${name} | ${c.total} | ${agree} | ${c.known_difference ?? 0} | ${how} |`;
  const disputed = r.checks.disputed ? ` ${r.checks.disputed} checks it shares with another reference that disagrees with it are in the cross-reference section, not here.` : "";
  return [
    `**How far the model is from ${r.name}: ${readmeHeadline(s, ref)}.** ${r.deviations.definition} Regenerate with \`pnpm conformance:summary\`; the figures are in \`conformance/summary.json\` with the deviation of every check, kept in step with the scenarios by a test.`,
    "",
    ...distributionTable(r),
    "",
    `Groups: ${GROUPS.map((g) => `**${GROUP_LABEL[g]}**: ${GROUP_DEFINITION[g]}`).join(" ")}${r.deviations.overall.unbounded ? ` ${r.deviations.overall.unbounded} comparison(s) have no finite deviation (the reference value is zero) and are in no "within" column.` : ""}`,
    "",
    `The count of checks is secondary, because a tolerance is a line the suite drew: **${r.headline.agree} of ${r.headline.total} checks hold as written (${pct(r.headline.share)}), with ${r.headline.knownDifferences} known differences.**${disputed}`,
    "",
    "| Kind of check | Checks | Agree | Known difference | Agree means |",
    "|---|---|---|---|---|",
    row("Exact", k.exact, k.exact.exact ?? 0, "every key of an integer or decision equal"),
    row("Capacity", k.capacity, k.capacity.within_tolerance ?? 0, "a size derived from estimates within a relative tolerance set on principle"),
    row("Calibrated", k.calibrated, k.calibrated.within_tolerance ?? 0, "within the scenario's relative tolerance"),
    row("Directional", k.directional, k.directional.directional_agree ?? 0, "same direction, effect within the scenario's factor band"),
    "",
    `Approaches in the registry: ${r.verified.length} of ${s.approaches.total} are named by at least one scenario this reference covers; ${s.approaches.notVerifiable} are named by none and say why (below). Being named by a scenario means checked, not agreeing: several approaches appear in a check that is a known difference. Approaches that cannot be verified are not in the figure at all, in either direction.`,
    "",
    `Scenarios this reference covers: ${r.scenarios.total}, of which ${r.scenarios.calibration} are calibration data (they carry no checks; the fit uses them) and ${r.scenarios.withChecks} carry the ${r.checks.total + r.checks.disputed} checks. ${r.name} ${r.kind === "simulator" ? "commit" : "revision"}: \`${r.lock.slice(0, 8)}\`.`
  ].join("\n");
}

/** The one count per reference that the root README quotes in prose, beside the deviation headline; a test fails if the README says anything else. */
export function readmeFigure(s: Summary, ref: string): string {
  const h = s.references[ref]!.headline;
  return `${h.agree} of ${h.total} checks agree (${pct(h.share)})`;
}

const GROUP_DEFINITION: Record<(typeof GROUPS)[number], string> = {
  timings_defaults: "the same metrics for checks that run the model with the site's default parameters, before any fit.",
  capacity: "KV blocks per replica, and the prefix-cache and host-tier hit rates; deviation is the relative difference.",
  decisions: "every exact check (pod chosen, requests shed or preempted, cached tokens, requests per pod, discrete counts) and the counts of replicas used, requests completed and preemptions; deviation is the share of the individual values that differ.",
  timings: "time to first token, time per token, end-to-end time, throughput, KV hand-over time and tokens per speculative step; deviation is the relative difference.",
  effects: "the directional checks (an intervention's effect on a metric); deviation is |model effect / reference effect - 1|."
};

/** The checks that do not hold, one row each. */
function failingTable(r: ReferenceSummary): string[] {
  const rows = r.rows.filter((x) => !x.holds);
  if (!rows.length) return ["No check differs."];
  const cell = (t: string): string => t.replace(/\|/g, "\\|");
  return [
    "| Compared | Ours | Reference | Deviation | Missed | Cause |",
    "|---|---|---|---|---|---|",
    ...rows.map((x) => {
      const missed = x.byDesign ? `${x.kind === "exact" ? "different by design" : `${x.tolerance} (different by design)`}` : x.kind === "exact" ? "decision differs" : x.tolerance;
      return `| \`${x.scenario}\`: ${cell(x.what)} | ${cell(x.ours)} | ${cell(x.theirs)} | ${cell(x.deviationText)} | ${cell(missed)} | ${cell(x.cause ?? "")} |`;
    })
  ];
}

export { failingTable };

/** The README's parity section: one block per reference, led by the deviations, then the checks that do not hold. */
export function renderReadmeParity(s: Summary): string {
  const out: string[] = [];
  for (const r of Object.values(s.references)) {
    if (!r.checks.total) continue;
    const k = r.checks.byKind;
    const row = (name: string, what: string, c: (typeof k)["exact"], agree: number) => `| ${name} | ${what} | ${c.total} | ${agree} | ${c.known_difference ?? 0} |`;
    out.push(
      `**${r.name}** (${r.kind === "simulator" ? "commit" : "revision"} \`${r.lock.slice(0, 8)}\`): ${readmeHeadline(s, r.id)}.`,
      "",
      ...distributionTable(r),
      "",
      `Counting checks instead: ${r.headline.agree} of ${r.headline.total} checks agree (${pct(r.headline.share)}), ${r.headline.knownDifferences} known differences; ${r.verified.length} of the ${s.approaches.total} approaches in the table above are covered by at least one of its scenarios.`,
      "",
      "| Kind of check | What must hold | Checks | Agree | Known difference |",
      "|---|---|---|---|---|",
      row("Exact", "Decisions and discrete counts are equal (the pod chosen, cached prefix tokens, which requests are shed or preempted)", k.exact, k.exact.exact ?? 0),
      row("Capacity", "KV blocks per replica within 0.1%: both sides derive them from estimates", k.capacity, k.capacity.within_tolerance ?? 0),
      row("Calibrated", "A timing or rate is within the tolerance written in the scenario", k.calibrated, k.calibrated.within_tolerance ?? 0),
      row("Directional", "The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling)", k.directional, k.directional.directional_agree ?? 0),
      `| **All** | | **${r.checks.total}** | **${r.headline.agree}** | **${r.headline.knownDifferences}** |`,
      "",
      `Every check that does not hold as written (the scenario files carry the full reasons, [the parity page](docs/parity.md) the numbers):`,
      "",
      ...failingTable(r),
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
  const rows = ["| Pair | MBU | MFU | Host ms, fixed | Host ms, per sequence | All-reduce efficiency, fixed microseconds | Loss at defaults, at fit | Worst residual, time to first token | Worst residual, time per token |", "|---|---|---|---|---|---|---|---|---|"];
  for (const [key, p] of Object.entries(fitted.pairs)) {
    const worst = (f: (r: (typeof p.residuals)[number]) => number): string => pctSigned(p.residuals.map(f).reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)));
    const cell = (v: number, d: number): string => `${v} (default ${d})`;
    rows.push(
      `| \`${key}\` | ${cell(p.timing.mbu, p.defaults.mbu)}${p.atBound.includes("mbu") ? " **at its bound**" : ""} | ${cell(p.timing.mfu, p.defaults.mfu)} | ${cell(p.timing.hostMsBase, p.defaults.hostMsBase)} | ${cell(p.timing.hostMsPerSeq, p.defaults.hostMsPerSeq)} | ${p.timing.commEff === undefined ? "none (one degree)" : `${p.timing.commEff}, ${p.timing.commLatencyUs}`} | ${p.lossAtDefaults}, ${p.lossAtFit} | ${worst((r) => r.ttftMean)} | ${worst((r) => r.tpotMean)} |`
    );
  }
  const name = nameOf(ref);
  const groups = new Map<string, (typeof fitted.pairs)[string]>();
  for (const p of Object.values(fitted.pairs)) if (!groups.has(p.group)) groups.set(p.group, p);
  const profiles = [...groups.entries()].flatMap(([g, p]) =>
    p.identifiability.map((i) => `- \`${g}\` (tensor-parallel degrees ${p.groupTps.join(", ")}): loss with ${i.parameter} held at ${i.held.map((h) => `${h.value}: ${h.loss}`).join(", ")}; at the fit (${i.fitted.value}): ${i.fitted.loss}; spread ${(i.spread * 100).toFixed(0)}%${i.flat ? " **flat: the data does not identify this parameter, and its fitted value is a label, not a measurement**" : ""}.`)
  );
  const extras = Object.entries(fitted.pairs).flatMap(([key, p]) => [
    ...(p.specCost ? [`- \`${key}\`: draft cost \`specCost\` ${p.specCost.value} (default ${p.specCost.defaultValue}); time per token ${pctSigned(p.specCost.residualTpot)} from ${name}'s on \`${p.specCost.scenario}\`. ${ref === "blis" ? "BLIS prices its n-gram drafter at nothing, so the fit goes to the lower bound." : `${name} prices no drafter (it takes an acceptance rate), so the fitted draft cost is close to zero.`}`] : []),
    ...(p.linkGbps ? [`- \`${key}\`: link rate \`linkGbps\` ${p.linkGbps.value} Gbit/s (default ${p.linkGbps.defaultValue}); hand-over time ${pctSigned(p.linkGbps.residualKvTransfer)} from ${name}'s on \`${p.linkGbps.scenario}\`. ${ref === "blis" ? "BLIS's fabric is 400 Gbit/s InfiniBand at 0.811 of line rate, which is 324 Gbit/s." : ""}`] : [])
  ]);
  return [...rows, "", "Loss profiles (the loss when a parameter is held at fixed values and the others are refitted; a profile within 25 percent of the best loss marks a parameter the data does not tell from the others):", "", ...profiles, "", ...extras].join("\n");
}

export type { ReferenceSummary };
