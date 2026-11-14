import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

function findRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function deterministicGzip(input) {
  const gz = gzipSync(input, { level: 9 });
  // RFC 1952 header: zero MTIME (bytes 4..7) and normalize OS byte (byte 9 = 3 Unix)
  gz[4] = 0;
  gz[5] = 0;
  gz[6] = 0;
  gz[7] = 0;
  gz[9] = 3;
  return gz;
}

function writeIfChanged(destPath, contentBuf) {
  if (existsSync(destPath)) {
    const existing = readFileSync(destPath);
    if (existing.equals(contentBuf)) {
      return false;
    }
  }
  writeFileSync(destPath, contentBuf);
  return true;
}

function main() {
  const repoRoot = findRepoRoot();
  const engineDir = path.join(repoRoot, "engine");
  const outDir = path.join(repoRoot, "web", "public", "wasm");
  mkdirSync(outDir, { recursive: true });

  const goroot = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim();
  const wasmExecSrc = path.join(goroot, "lib", "wasm", "wasm_exec.js");
  if (!existsSync(wasmExecSrc)) {
    throw new Error(`wasm_exec.js not found at ${wasmExecSrc}`);
  }

  const defaultsSrc = path.join(engineDir, "defaults.yaml");
  if (!existsSync(defaultsSrc)) {
    throw new Error(`defaults.yaml not found at ${defaultsSrc}`);
  }

  const scratchDir = mkdtempSync(path.join(tmpdir(), "blis-wasm-build-"));
  const wasmTmpPath = path.join(scratchDir, "blis.wasm");

  try {
    console.log("[build-wasm] Compiling BLIS with GOOS=js GOARCH=wasm...");
    execFileSync("go", ["build", "-ldflags=-s -w", "-o", wasmTmpPath, "."], {
      cwd: engineDir,
      env: { ...process.env, GOOS: "js", GOARCH: "wasm" },
      stdio: "inherit"
    });

    const wasmBytes = readFileSync(wasmTmpPath);
    const gzBytes = deterministicGzip(wasmBytes);

    const gzPath = path.join(outDir, "blis.wasm.gz");
    const wasmExecDest = path.join(outDir, "wasm_exec.js");
    const defaultsDest = path.join(outDir, "defaults.yaml");

    const gzChanged = writeIfChanged(gzPath, gzBytes);
    const execChanged = writeIfChanged(wasmExecDest, readFileSync(wasmExecSrc));
    const defaultsChanged = writeIfChanged(defaultsDest, readFileSync(defaultsSrc));

    const rawMb = (wasmBytes.byteLength / (1024 * 1024)).toFixed(2);
    const gzMb = (gzBytes.byteLength / (1024 * 1024)).toFixed(2);
    console.log(
      `[build-wasm] Ready: ${gzPath} (${gzMb} MB gzipped from ${rawMb} MB raw, ` +
        `updated: wasm=${gzChanged}, wasm_exec=${execChanged}, defaults=${defaultsChanged})`
    );
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

main();
