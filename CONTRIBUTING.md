# Contributing to LLM Serving Explorer

Thank you for contributing! This project keeps **all simulation physics inside BLIS (`engine/`)** and **all replay/rendering in TypeScript (`web/`)**. Follow the workflows below when updating scenarios, the event schema, or BLIS patches.

---

## 1. Adding or Modifying a Guided Scenario

Each guided scenario lives in `scenarios/<slug>/` (sorted lexicographically, e.g. `01-single-request` … `09-autoscaling`) and contains:

| File | Purpose |
|---|---|
| `scenario.yaml` | BLIS `kind: Scenario` / `kind: Deployment` configuration (model, hardware, TP, KV block size, offload, P/D pools). |
| `flags.json` | UI metadata (`title`, `subtitle`, `recommended_views`), BLIS CLI/run parameters (`rate`, `num_requests`, `seed`, `cli_flags`, etc.), and an optional `compare_variant` block for side-by-side comparison. |
| `narrative.md` | Guided explanation and key takeaways displayed in the scenario drawer. |
| `expectations.ts` | Exports `assertExpectations(timeline, baseline?)` asserting the teaching invariants on the replayed `ReplayTimeline`. |

### Regenerating & Validating Scenarios

1. Edit or create the files in `scenarios/<slug>/`.
2. If you add a brand-new scenario directory (rather than modifying an existing one), update the scenario count assertion in [`scenarios/scenarios.test.ts`](scenarios/scenarios.test.ts) (`expect(scenarioIds).toHaveLength(...)`).
3. Regenerate the deterministic `.ndjson.gz` trace(s) and [`scenarios/manifest.json`](scenarios/manifest.json):
   ```bash
   # Regenerate a single scenario (fast iteration)
   pnpm gen:scenarios --only <slug>

   # Or regenerate all scenarios (pass --rebuild if engine/ Go code changed)
   pnpm gen:scenarios --rebuild
   ```
   `tools/gen-scenarios` builds BLIS into `/tmp/blis-gen`, runs each scenario (and `compare_variant` baseline if present), validates every line against `@llm-viz/schema`, and writes deterministic RFC-1952 gzipped NDJSON traces.
4. Run the scenario test suite:
   ```bash
   pnpm test scenarios
   ```

---

## 2. Extending the NDJSON Event Schema & Event Registry

All simulation event streams conform to the Draft 2020-12 JSON Schema in [`schema/events.schema.json`](schema/events.schema.json).

### Adding or Updating an Event Type

1. **Update the schema:** Edit [`schema/events.schema.json`](schema/events.schema.json) to define or update the event record under `$defs` and include new record types in the top-level `oneOf`. Every non-header event must include `seq` (monotonic integer), `t_us` (non-decreasing microsecond timestamp), and `type`.
2. **Regenerate TypeScript types & test schema validation:**
   ```bash
   pnpm gen:types
   pnpm test:schema
   ```
   `pnpm gen:types` runs [`schema/scripts/generate-types.mjs`](schema/scripts/generate-types.mjs) and overwrites [`schema/src/types.ts`](schema/src/types.ts) (do not edit `types.ts` by hand).
3. **Update the Event Registry (`web/src/registry/eventRegistry.ts`):**
   - `EVENT_REGISTRY` in [`web/src/registry/eventRegistry.ts`](web/src/registry/eventRegistry.ts) is statically typed as `{ [K in SimEventType]: EventPresentation<EventByType<K>> }`.
   - Add an entry via `defineEvent("<type>", { badge, category, color, shortSummary, details })` so TypeScript `typecheck` passes and the Event Log & views format the event cleanly.
   - **Fallback behavior:** At runtime, `getEventPresentation(event)` falls back to `FALLBACK_PRESENTATION` (`UNKNOWN` badge, `"unknown"` category, `"neutral"` tone, raw event payload in `details`) whenever an unrecognized `type` appears in a stream, ensuring forward compatibility without UI crashes.
4. **Update engine emission & replay state (if applicable):**
   - Emit the new/updated fields in `engine/sim/` (documented in `engine/PATCHES.md`).
   - Handle the event in [`web/src/replay/`](web/src/replay/) if it mutates replay state (`SimState`), and add unit tests in `web/src/replay/__tests__/replay.test.ts` and `web/src/registry/__tests__/eventRegistry.test.ts`.

---

## 3. Changing the BLIS Patch (`engine/` and `engine-patches/`)

`engine/` is a git submodule of [`github.com/inference-sim/inference-sim`](https://github.com/inference-sim/inference-sim), pinned to an upstream commit. This repository does not commit anything inside the submodule. The `--events-output` instrumentation is carried as [`engine-patches/0001-events-output.patch`](engine-patches/0001-events-output.patch):

```bash
pnpm engine:patch          # apply the patch to engine/ (does nothing if already applied)
# ... edit files in engine/ ...
pnpm engine:export-patch   # rewrite the patch from the current state of engine/
```

Commit the regenerated patch file. `engine/PATCHES.md` (part of the patch) lists every added and modified file.

To move to a newer upstream commit: reset `engine/` to a clean state, check out the new commit, run `pnpm engine:patch`, resolve any conflicts by hand, then `pnpm engine:export-patch` and commit both the new submodule pin and the patch.

### Rules & Invariants

- **INV-6 Determinism & Zero Behavioral Perturbation:** Attaching `sim.EventSink` (`--events-output`) must remain purely observational. It must **never** mutate RNG streams, request scheduling order, gateway routing/admission decisions, or instance state transitions.
- **Stdout Purity:** `blis run` and `blis replay` write only the `Result` JSON to stdout; NDJSON events go solely to `--events-output`.
- **DEV-13 Output Length Isolation:** Arrival and routing hooks may read `req.MaxOutputLen`, never `req.OutputTokens`.
- **Keep `blis-vllm` and `blis-substrate` un-forked:** Observe engine state at `EngineDriver`, `ClusterSimulator`, `GatewayHost`, and `cmd/` boundaries rather than forking upstream modules.
- **Document every change:** Update `engine/PATCHES.md` whenever files in `engine/` are added or modified, then re-export the patch.

### Testing BLIS Changes

Run Go tests inside `engine/`:

```bash
cd engine
go vet ./...
go test ./sim/...
# Full module suite (match engine/go.mod toolchain if needed):
GOTOOLCHAIN=go1.27.2 go test ./...
```

Verify INV-6 determinism before committing:
1. Run `blis run` with and without `--events-output` on the same scenario and confirm stdout `Result` JSON (excluding `runtime`) is byte-identical.
2. Rebuild browser WASM (`pnpm build:wasm`) and regenerate scenarios (`pnpm gen:scenarios --rebuild`) to confirm identical schemas and reproducible outputs.

---

## 4. Pre-PR Verification Checklist

Run the full local validation suite before opening a pull request:

```bash
# 1. Ensure the engine patch, schema types and browser WASM artifacts are up to date
#    (web/src/wasm/blisWorker.test.ts requires web/public/wasm/blis.wasm.gz)
pnpm engine:patch
pnpm gen:types
pnpm build:wasm

# 2. Run Go engine tests
(cd engine && go test ./sim/...)

# 3. Run Vitest unit & integration suite (schema, local-runner, scenarios, replay, wasm)
pnpm test

# 4. Typecheck frontend
pnpm --filter @llm-viz/web typecheck

# 5. Run Playwright E2E suite (first time only: pnpm --filter @llm-viz/web exec playwright install chromium)
pnpm --filter @llm-viz/web test:e2e

# 6. Verify production bundle builds cleanly (including subpath mode)
VITE_BASE_PATH="/llm-serving-explorer/" pnpm build
```
