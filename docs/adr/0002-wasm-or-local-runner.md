# ADR 0002: WebAssembly Build and Local Runner for Custom Runs

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

Facts `static-scenarios` and `custom-runs` require:
1. The hosted site on GitHub Pages must be purely static (no backend server) and play all guided scenarios from pre-generated compressed event files.
2. Locally, changing parameters (request rate, number of requests, pods, GPUs per pod, routing configuration, model/GPU preset, tier sizes) runs a fresh BLIS simulation.
3. If the trial shows BLIS compiles and runs as WebAssembly (`GOOS=js GOARCH=wasm`), custom runs should also work on the hosted static site; otherwise the hosted site states custom runs require the local app.

## Trial Measurements

On `darwin/arm64` with Go `go1.27.3`, Node `v26.13.0`, and headless Google Chrome:

1. **Build:** `GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o blis.wasm .` in `engine/` **succeeded cleanly** with zero patches.
2. **Binary size:**
   - Uncompressed `blis.wasm`: **162 MB** (169 MB without `-ldflags="-s -w"`).
   - Gzip-compressed `blis.wasm.gz`: **27 MB**.
3. **Node execution (`go_js_wasm_exec`):**
   - Full simulation (`gpt-oss-120b-h100-fp4-vllm-tp2.yaml`, `--rate 5 --num-requests 10`): **1.568 s** total wall-clock time.
4. **Browser execution (headless Google Chrome over local HTTP):**
   - Fetch (`blis.wasm` uncompressed locally): **57 ms**
   - `WebAssembly.instantiate`: **72 ms**
   - `go.run` (`blis metrics`): **169 ms**
   - Total end-to-end startup + run: **298 ms**

Note on GitHub Pages limits: GitHub repositories enforce a 100 MB per-file size limit, so an uncompressed 162 MB `.wasm` cannot be committed directly to a static `gh-pages` branch, whereas `blis.wasm.gz` (**27 MB**) fits well under the limit and can be decompressed client-side in a Web Worker using the standard `DecompressionStream("gzip")` API before `WebAssembly.instantiate`.

## Decision

1. **Support both `tools/local-runner` and a browser WebAssembly Web Worker (`blis.wasm.gz`)**:
   - **Local development / local app (`tools/local-runner`):** Runs the native `./blis` binary (~60 ms per run) via a lightweight local HTTP endpoint used automatically when running locally (`vite dev` / local preview).
   - **Hosted static site (GitHub Pages):** Ships a WebAssembly build compiled with a `//go:build js && wasm` entrypoint (`cmd/wasm` or `wasm_main.go`) that exposes an in-memory simulation runner (accepting scenario YAML + CLI options without needing a host filesystem), distributed as `blis.wasm.gz` (~27 MB) and loaded lazily on demand in a Web Worker when the user triggers a custom run on the static site.
   - **Fallback safety:** Guided scenarios never wait on WASM — they load pre-generated `.ndjson.gz` files directly. If WebAssembly initialization fails or is unavailable in an environment, the UI cleanly informs the user that custom runs can use the local runner.

## Consequences

- Guided scenarios load instantaneously with zero WASM download.
- Custom parameter runs and single-request injection work both locally (native speed via `local-runner`) and on the static GitHub Pages deployment (via lazy-loaded `blis.wasm.gz` Web Worker).
