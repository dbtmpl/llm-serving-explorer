/**
 * Regenerate `conformance/reference/<id>.json` by running the real BLIS binary.
 *
 *     BLIS_BIN=/path/to/blis pnpm conformance:reference [--blis /path/to/blis] [--only <id>] [--keep <dir>]
 *
 * Fails with a clear message when the binary is missing. When `BLIS_SRC` names a checkout of
 * inference-sim, its HEAD must equal the commit in `conformance/blis.lock`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lockedCommit, runBlis } from "../run/blis.js";
import { CONFORMANCE_DIR, REFERENCE_DIR, loadScenario, scenarioIds } from "../scenario.js";
import { ALL_EPP_FILES } from "../translate/toBlis.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function die(msg: string): never {
  console.error(`conformance:reference: ${msg}`);
  process.exit(1);
}

const binary = arg("blis") ?? process.env.BLIS_BIN;
if (!binary) die("name the BLIS binary with --blis <path> or BLIS_BIN=<path>. Build it from the commit in conformance/blis.lock (see conformance/README.md).");
if (!existsSync(binary)) die(`the BLIS binary ${binary} does not exist. Build it from the commit in conformance/blis.lock (see conformance/README.md).`);

const src = process.env.BLIS_SRC;
if (src) {
  const head = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // the weekly upstream job builds a newer commit on purpose (BLIS_UPSTREAM=1) and the references it writes name that commit
  if (process.env.BLIS_UPSTREAM) process.env.BLIS_COMMIT = head;
  else if (head !== lockedCommit()) die(`BLIS_SRC is at ${head} but conformance/blis.lock names ${lockedCommit()}`);
}

// the router configurations the translators ship must be the ones this binary's llm-d router ships
for (const file of ALL_EPP_FILES) {
  const shipped = execFileSync(binary, ["router-configs", "--file", file], { encoding: "utf8" });
  const ours = readFileSync(path.join(CONFORMANCE_DIR, "translate", "epp", file), "utf8");
  if (shipped !== ours) die(`conformance/translate/epp/${file} differs from the file this BLIS ships (blis router-configs --file ${file}); copy the new one and re-run`);
}

const only = arg("only");
const ids = only ? [only] : scenarioIds();
for (const id of ids) {
  const scenario = loadScenario(id);
  const { reference } = runBlis(scenario, binary, arg("keep") ? path.join(arg("keep")!, id) : undefined);
  const out = path.join(REFERENCE_DIR, `${id}.json`);
  writeFileSync(out, JSON.stringify(reference, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}
