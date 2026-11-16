/**
 * Produce the committed reference records, `conformance/reference/<ref>/<scenario>.json`.
 *
 *     BLIS_BIN=/path/to/blis pnpm conformance:reference [--ref <id>] [--only <scenario>] [--keep <dir>] [--blis /path/to/blis]
 *
 * A reference is a simulator that is run (BLIS) or measured data that is reduced; each one's
 * `prepare` says what it needs and fails with a clear message when it is missing. Without `--ref`
 * every reference is regenerated. Settings come from the environment (`BLIS_BIN`, `BLIS_SRC`,
 * `BLIS_UPSTREAM`, and the measured references' own, documented in their modules).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REFERENCES, referenceById, referencesOf } from "../refs/index.js";
import { loadScenario, referenceFile, scenarioIds } from "../scenario.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function die(msg: string): never {
  console.error(`conformance:reference: ${msg}`);
  process.exit(1);
}

const settings: Record<string, string | undefined> = { ...process.env };
if (arg("blis")) settings.BLIS_BIN = arg("blis");
for (const [flag, name] of [["clone", "LLMSERVINGSIM_DIR"]] as const) if (arg(flag)) settings[name] = arg(flag);

const wanted = arg("ref") ? [referenceById(arg("ref")!)] : REFERENCES;
const only = arg("only");
for (const ref of wanted) {
  try {
    ref.prepare({ settings });
  } catch (e) {
    die(`${ref.id}: ${(e as Error).message}`);
  }
  for (const id of only ? [only] : scenarioIds()) {
    const scenario = loadScenario(id);
    if (!referencesOf(scenario).some((r) => r.id === ref.id)) {
      if (only) die(`${ref.id} cannot answer ${id}`);
      continue;
    }
    const file = ref.generate(scenario, { settings, ...(arg("keep") ? { keep: path.join(arg("keep")!, ref.id, id) } : {}) });
    const out = referenceFile(ref.id, id);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
  }
}
