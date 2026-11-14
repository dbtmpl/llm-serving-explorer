# ADR 0005: Remove the BLIS replay app; the live graph is the whole product

## Status

Accepted (2026-11-14). Supersedes ADR 0001 to 0003, which are deleted with the code they described and remain in git history.

## Context

The repository held two models of the same serving stack:

- the live graph, driven by a teaching model in the browser (ADR 0004);
- a tabbed app that replayed event files produced by BLIS ([inference-sim](https://github.com/inference-sim/inference-sim)), which needed a pinned BLIS submodule, a patch adding an `--events-output` flag, an event schema, a scenario generator, a local runner and a 27 MB WebAssembly build.

The live graph became the landing page and the thing people use. The replay app carried most of the build and maintenance cost: a Go toolchain, a submodule patch to keep in step with upstream, and generated files to keep in sync.

## Decision

Remove the replay app and everything that existed only to serve it: the `engine/` submodule and its patch, `schema/`, `scenarios/`, `tools/`, the replay state machine, the event registry, the tabbed views and the WebAssembly worker. The remaining app is a single package at the repository root.

The event-stream instrumentation for BLIS is not lost: it is proposed to inference-sim upstream, where it belongs.

## Consequences

- The project is a static site with no build dependency beyond Node.js.
- Nothing in the app is calibrated against a simulator. What is exact and what is illustrative is recorded in ADR 0004 and [design-choices.md](../design-choices.md).
- If calibrated replay is wanted again, the route named in ADR 0004 still holds: drive the same graph from BLIS events once upstream emits them.
