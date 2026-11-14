// Applies or re-exports the patch set that this repository carries on top of the
// pinned inference-sim (BLIS) submodule in engine/.
//
//   node tools/engine-patch.mjs apply    apply engine-patches/*.patch (no-op if already applied)
//   node tools/engine-patch.mjs export   rewrite the patch from the current state of engine/
//   node tools/engine-patch.mjs status   say whether the patch is applied
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = path.join(repoRoot, "engine");
const patchDir = path.join(repoRoot, "engine-patches");
const EXPORT_NAME = "0001-events-output.patch";

function git(args, opts = {}) {
  return execFileSync("git", ["-C", engineDir, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts
  });
}

function succeeds(args) {
  try {
    git(args);
    return true;
  } catch {
    return false;
  }
}

function patches() {
  return readdirSync(patchDir)
    .filter((f) => f.endsWith(".patch"))
    .sort()
    .map((f) => path.join(patchDir, f));
}

function requireEngine() {
  if (!existsSync(path.join(engineDir, "go.mod"))) {
    console.error("[engine-patch] engine/ is empty. Run: git submodule update --init --recursive");
    process.exit(1);
  }
}

function isApplied(patch) {
  return succeeds(["apply", "--reverse", "--check", patch]);
}

function apply() {
  for (const patch of patches()) {
    const name = path.basename(patch);
    if (isApplied(patch)) {
      console.log(`[engine-patch] ${name}: already applied`);
    } else if (succeeds(["apply", "--check", patch])) {
      git(["apply", patch]);
      console.log(`[engine-patch] ${name}: applied`);
    } else {
      console.error(
        `[engine-patch] ${name}: does not apply to engine/. ` +
          "Check that the submodule is at the pinned commit (git submodule update) and has no other edits."
      );
      process.exit(1);
    }
  }
}

function exportPatch() {
  // Stage everything (including new files) only long enough to diff it against the pinned commit.
  git(["add", "-A"]);
  try {
    const diff = git(["diff", "--cached", "--binary", "HEAD"]);
    if (!diff.trim()) {
      console.error("[engine-patch] engine/ has no changes against its pinned commit; nothing exported.");
      process.exit(1);
    }
    writeFileSync(path.join(patchDir, EXPORT_NAME), diff);
    console.log(`[engine-patch] wrote engine-patches/${EXPORT_NAME}`);
  } finally {
    git(["reset", "-q"]);
  }
}

function status() {
  let ok = true;
  for (const patch of patches()) {
    const applied = isApplied(patch);
    ok &&= applied;
    console.log(`[engine-patch] ${path.basename(patch)}: ${applied ? "applied" : "not applied"}`);
  }
  process.exit(ok ? 0 : 1);
}

requireEngine();
const command = process.argv[2];
if (command === "apply") apply();
else if (command === "export") exportPatch();
else if (command === "status") status();
else {
  console.error("usage: node tools/engine-patch.mjs <apply|export|status>");
  process.exit(2);
}
