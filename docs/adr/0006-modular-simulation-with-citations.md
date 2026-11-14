# ADR 0006: The simulation is organised by concept, and every approach names its sources

## Status

Accepted (2026-11-14).

## Context

The simulation grew as one file. Batching, admission, routing, tiering, speculative decoding and disaggregation were branches inside the same functions, selected by parameter checks, with constants written inline. Its sources were named in prose documents rather than next to the code, and the tests exercised the whole simulation rather than each mechanism.

Since the project no longer replays a calibrated simulator (ADR 0005), its credibility rests on each mechanism being traceable to a paper, documentation or source code.

## Decision

- `src/sim/` holds the simulation, with no dependency on the user interface. `src/live/` holds the interface and imports only `src/sim/index.ts`.
- One directory per concept (a decision the serving stack makes). Each defines an interface, and each approach implements it in its own file. The engine selects approaches through registries and contains no policy of its own beyond the order of work in a step.
- `src/sim/citations.ts` is the single registry of sources. Every approach must cite at least one entry; tests enforce this, and that paper links are arXiv, DOI or proceedings pages.
- Each approach declares its fidelity (exact, structural or simplified) and documents its source, formula, a worked example and its simplifications in a docstring. Unit tests check it against the source.
- Constants are named and state their origin.
- The tables of concepts, approaches and sources in the READMEs are generated from the registries and checked by a test.
- The refactor was required to leave behaviour unchanged. Fingerprints of the full event stream of ten scenarios, recorded before the change, are kept as a regression test.

## Consequences

- Modelling a new paper means adding a file to one module, a citation and tests, without touching other approaches.
- Concepts with a single approach bind it to a constant; a second approach turns that into a parameter and a control.
- Stateful mechanics of the KV tiers and the engine still operate on shared pod and world state. They are separated by file and responsibility, not by ownership of data.
- The interface's rendering code is outside this decision and keeps its layout constants.
