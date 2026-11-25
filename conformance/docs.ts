/**
 * The generated parts of `conformance/parity.md` (one block set per reference) and of the root README's
 * parity section. The rest of those pages is prose. `pnpm docs:sync` rewrites them; a test fails
 * when they are out of date.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadFitted, type FittedReference } from "./calibration/fitted.js";
import { REFERENCES, referenceById } from "./refs/index.js";
import { GROUPS, GROUP_LABEL, type Distribution } from "./deviation.js";
import { CONFORMANCE_DIR, loadScenario, scenarioIds, SPAN } from "./scenario.js";
import type { ReferenceSummary, Summary } from "./summary.js";

interface PreviousBlis {
  summary: ReferenceSummary;
  calibration: FittedReference;
}

const PREVIOUS_BLIS_FILE = path.join(CONFORMANCE_DIR, "refs", "blis", "previous.json");

function loadPreviousBlis(): PreviousBlis | null {
  if (!existsSync(PREVIOUS_BLIS_FILE)) return null;
  return JSON.parse(readFileSync(PREVIOUS_BLIS_FILE, "utf8")) as PreviousBlis;
}

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

/** Side-by-side comparison between the previous BLIS commit and the current one, so old metrics are not lost. */
function versionComparisonTable(prev: ReferenceSummary, curr: ReferenceSummary): string[] {
  const pHash = `\`${prev.lock.slice(0, 8)}\``;
  const cHash = `\`${curr.lock.slice(0, 8)}\``;
  const kindAgree = (r: ReferenceSummary, kind: keyof ReferenceSummary["checks"]["byKind"]): string => {
    const c = r.checks.byKind[kind];
    const agree = kind === "exact" ? (c.exact ?? 0) : kind === "directional" ? (c.directional_agree ?? 0) : (c.within_tolerance ?? 0);
    return `${agree} / ${c.total}`;
  };
  const withinSummary = (d: Distribution): string => `${d.within["1"]} / ${d.within["5"]} / ${d.within["10"]} / ${d.within["25"]} (of ${d.n})`;
  const groupCell = (g: Distribution): string => `${g.n}, median ${fmtPct(g.median)}, max ${fmtPct(g.max)}, within 5%: ${g.within["5"]}`;
  const rows: [string, string, string][] = [
    ["Scenarios (with checks / calibration)", `${prev.scenarios.withChecks} / ${prev.scenarios.calibration}`, `${curr.scenarios.withChecks} / ${curr.scenarios.calibration}`],
    ["Checks agreeing", `${prev.headline.agree} of ${prev.headline.total} (${pct(prev.headline.share)})`, `${curr.headline.agree} of ${curr.headline.total} (${pct(curr.headline.share)})`],
    ["Known differences", String(prev.headline.knownDifferences), String(curr.headline.knownDifferences)],
    ["Overall median deviation", fmtPct(prev.deviations.overall.median), fmtPct(curr.deviations.overall.median)],
    ["Overall largest deviation", fmtPct(prev.deviations.overall.max), fmtPct(curr.deviations.overall.max)],
    ["Within 1% / 5% / 10% / 25%", withinSummary(prev.deviations.overall), withinSummary(curr.deviations.overall)],
    ...GROUPS.filter((g) => prev.deviations.groups[g].n || curr.deviations.groups[g].n).map((g): [string, string, string] => [
      GROUP_LABEL[g],
      prev.deviations.groups[g].n ? groupCell(prev.deviations.groups[g]) : "—",
      curr.deviations.groups[g].n ? groupCell(curr.deviations.groups[g]) : "—"
    ]),
    ["Exact checks (agree / total)", kindAgree(prev, "exact"), kindAgree(curr, "exact")],
    ["Capacity checks (agree / total)", kindAgree(prev, "capacity"), kindAgree(curr, "capacity")],
    ["Calibrated checks (agree / total)", kindAgree(prev, "calibrated"), kindAgree(curr, "calibrated")],
    ["Directional checks (agree / total)", kindAgree(prev, "directional"), kindAgree(curr, "directional")]
  ];
  return [
    `Comparison with the previous BLIS commit (${pHash} vs ${cHash}):`,
    "",
    `| Metric | ${pHash} | ${cHash} |`,
    "|---|---|---|",
    ...rows.map(([m, p, c]) => `| ${m} | ${p} | ${c} |`)
  ];
}

export function renderHeadline(s: Summary, ref: string): string {
  const r = s.references[ref]!;
  const prev = ref === "blis" ? loadPreviousBlis()?.summary : null;
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
    ...(prev && prev.lock !== r.lock ? ["", ...versionComparisonTable(prev, r)] : []),
    "",
    `Approaches in the registry: ${r.verified.length} of ${s.approaches.total} are named by at least one scenario this reference covers; ${s.approaches.notVerifiable} are named by none and say why (below). Being named by a scenario means checked, not agreeing: several approaches appear in a check that is a known difference. Approaches that cannot be verified are not in the figure at all, in either direction.`,
    "",
    `Scenarios this reference covers: ${r.scenarios.total}, of which ${r.scenarios.calibration} are calibration data (they carry no checks; the fit uses them) and ${r.scenarios.withChecks} carry the ${r.checks.total + r.checks.disputed} checks. ${r.name} ${r.kind === "simulator" ? "commit" : "revision"}: \`${r.lock.slice(0, 8)}\`.`
  ].join("\n");
}

const GROUP_DEFINITION: Record<(typeof GROUPS)[number], string> = {
  timings_defaults: "the same metrics for checks that run the model with the site's default parameters, before any fit.",
  capacity: "KV blocks per replica, and the prefix-cache and host-tier hit rates; deviation is the relative difference.",
  decisions: "every exact check (pod chosen, requests shed or preempted, cached tokens, requests per pod, discrete counts) and the counts of replicas used, requests completed and preemptions; deviation is the share of the individual values that differ.",
  timings: "time to first token, time per token, end-to-end time, throughput, KV hand-over time and tokens per speculative step; deviation is the relative difference.",
  effects: "the directional checks (an intervention's effect on a metric); deviation is |model effect / reference effect - 1|."
};

/** The checks that do not hold, one row each. For BLIS with a previous snapshot, includes columns for both commits and keeps checks that held only after the bump. */
function failingTable(r: ReferenceSummary, prev?: ReferenceSummary | null): string[] {
  const cell = (t: string): string => t.replace(/\|/g, "\\|");
  if (prev && prev.lock !== r.lock) {
    const keyOf = (x: ReferenceSummary["rows"][number]) => `${x.scenario}/${x.check}`;
    const prevByKey = new Map(prev.rows.map((x) => [keyOf(x), x]));
    const currByKey = new Map(r.rows.map((x) => [keyOf(x), x]));
    const shown = r.rows.filter((x) => !x.holds || prevByKey.get(keyOf(x))?.holds === false);
    if (!shown.length) return ["No check differs."];
    const pHash = `\`${prev.lock.slice(0, 8)}\``;
    const cHash = `\`${r.lock.slice(0, 8)}\``;
    return [
      `| Compared | Ours | ${pHash} | ${cHash} | Deviation (${cHash}) | Missed | Cause |`,
      "|---|---|---|---|---|---|---|",
      ...shown.map((x) => {
        const p = prevByKey.get(keyOf(x));
        const c = currByKey.get(keyOf(x))!;
        const missed = c.holds
          ? "holds (resolved)"
          : c.byDesign
            ? `${c.kind === "exact" ? "different by design" : `${c.tolerance} (different by design)`}`
            : c.kind === "exact"
              ? "decision differs"
              : c.tolerance;
        const cause = c.holds ? `Resolved (was: ${p?.cause ?? ""})` : (c.cause ?? "");
        return `| \`${c.scenario}\`: ${cell(c.what)} | ${cell(c.ours)} | ${cell(p ? p.theirs : "—")} | ${cell(c.theirs)} | ${cell(c.deviationText)} | ${cell(missed)} | ${cell(cause)} |`;
      })
    ];
  }
  const rows = r.rows.filter((x) => !x.holds);
  if (!rows.length) return ["No check differs."];
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

/** The parity section of conformance/README.md: one block per reference, led by the deviations, then the checks that do not hold. */
export function renderReadmeParity(s: Summary): string {
  const out: string[] = [];
  const prevBlis = loadPreviousBlis()?.summary ?? null;
  for (const r of Object.values(s.references)) {
    if (!r.checks.total) continue;
    const prev = r.id === "blis" ? prevBlis : null;
    const k = r.checks.byKind;
    const row = (name: string, what: string, c: (typeof k)["exact"], agree: number) => `| ${name} | ${what} | ${c.total} | ${agree} | ${c.known_difference ?? 0} |`;
    out.push(
      `**${r.name}** (${r.kind === "simulator" ? "commit" : "revision"} \`${r.lock.slice(0, 8)}\`): ${readmeHeadline(s, r.id)}.`,
      "",
      ...distributionTable(r),
      "",
      `Counting checks instead: ${r.headline.agree} of ${r.headline.total} checks agree (${pct(r.headline.share)}), ${r.headline.knownDifferences} known differences; ${r.verified.length} of the ${s.approaches.total} approaches in the [approach table](../src/sim/README.md#all-approaches) are covered by at least one of its scenarios.`,
      "",
      "| Kind of check | What must hold | Checks | Agree | Known difference |",
      "|---|---|---|---|---|",
      row("Exact", "Decisions and discrete counts are equal (the pod chosen, cached prefix tokens, which requests are shed or preempted)", k.exact, k.exact.exact ?? 0),
      row("Capacity", "KV blocks per replica within 0.1%: both sides derive them from estimates", k.capacity, k.capacity.within_tolerance ?? 0),
      row("Calibrated", "A timing or rate is within the tolerance written in the scenario", k.calibrated, k.calibrated.within_tolerance ?? 0),
      row("Directional", "The same intervention moves the same metric the same way by a similar factor (memory tiers, eviction, routing policy, autoscaling)", k.directional, k.directional.directional_agree ?? 0),
      `| **All** | | **${r.checks.total}** | **${r.headline.agree}** | **${r.headline.knownDifferences}** |`,
      ...(prev && prev.lock !== r.lock ? ["", ...versionComparisonTable(prev, r)] : []),
      "",
      `Every check that does not hold as written (the scenario files carry the full reasons, [the parity page](parity.md) the numbers):`,
      "",
      ...failingTable(r, prev),
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
  const prevCal = ref === "blis" ? loadPreviousBlis()?.calibration : null;
  const calDiff: string[] = [];
  if (prevCal && prevCal.lock !== fitted.lock) {
    const pHash = `\`${prevCal.lock.slice(0, 8)}\``;
    const cHash = `\`${fitted.lock.slice(0, 8)}\``;
    const worstOf = (p: (typeof fitted.pairs)[string], f: (r: (typeof p.residuals)[number]) => number): string =>
      pctSigned(p.residuals.map(f).reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)));
    calDiff.push(
      "",
      `Calibration against previous BLIS commit (${pHash} vs ${cHash}):`,
      "",
      `| Pair | ${pHash} (MBU, MFU, loss, worst TTFT / TPOT) | ${cHash} (MBU, MFU, loss, worst TTFT / TPOT) |`,
      "|---|---|---|",
      ...Object.entries(fitted.pairs).map(([key, c]) => {
        const p = prevCal.pairs[key];
        const fmtPair = (x: typeof c) => `${x.timing.mbu}, ${x.timing.mfu}, ${x.lossAtFit}, ${worstOf(x, (r) => r.ttftMean)} / ${worstOf(x, (r) => r.tpotMean)}`;
        return `| \`${key}\` | ${p ? fmtPair(p) : "—"} | ${fmtPair(c)} |`;
      })
    );
  }
  return [...rows, ...calDiff, "", "Loss profiles (the loss when a parameter is held at fixed values and the others are refitted; a profile within 25 percent of the best loss marks a parameter the data does not tell from the others):", "", ...profiles, "", ...extras].join("\n");
}

export type { ReferenceSummary };
