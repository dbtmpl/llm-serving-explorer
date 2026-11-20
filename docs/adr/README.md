# Architecture decision records

Each record states one decision, the context that forced it and its consequences. Records are never edited after acceptance except for their status line; a later record amends or supersedes them.

ADRs 0001 to 0003 belonged to the first version, which replayed BLIS event files: BLIS as the engine, a WebAssembly build or a local runner, and default presets. They were removed with that app in [ADR 0005](0005-remove-blis-replay.md).

| ADR | Decision |
| --- | --- |
| [0004](0004-live-graph-view.md) | A live graph view, driven by an in-browser model, is the landing page |
| [0005](0005-remove-blis-replay.md) | Remove the BLIS replay app; the live graph is the whole product |
| [0006](0006-modular-simulation-with-citations.md) | The simulation is organised by concept, and every approach names its sources |
| [0007](0007-calibrated-replay-mode.md) | A calibrated mode replays BLIS runs of fixed scenarios, at request level |
| [0008](0008-step-time-and-memory-from-measured-vllm.md) | Step time and the memory budget follow the engine's settings and two measured vLLM runs |
| [0009](0009-three-references.md) | Three references, each evidence for something different |
