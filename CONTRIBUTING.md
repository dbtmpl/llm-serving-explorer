# Contributing

Thanks for your interest in improving LLM Serving Explorer.

## Setup

You need Node.js 22+ and pnpm 12+.

```bash
pnpm install
pnpm dev
```

## Where things are

| Path | What it holds |
|---|---|
| `src/live/model.ts` | The closed-form quantities: FLOPs, KV bytes per token, memory budget, roofline step time. |
| `src/live/sim.ts` | The simulation: sessions, router, autoscaler, engine step, KV blocks, tiers, preemption. |
| `src/live/render.ts` | Canvas drawing of the graph. |
| `src/live/LiveView.tsx`, `Inspector.tsx`, `Tutorial.tsx` | Menus, the dive-in panel and the tutorial. |
| `src/live/callouts.ts` | The explanations shown next to nodes when events happen. |
| `src/live/architectures.ts` | The serving-architecture presets. |
| `e2e/` | Playwright tests. |

## Changing the model

The simulation is a teaching model, so every behaviour should be traceable to a source.

- If you add or change a behaviour, add a row to [docs/design-choices.md](docs/design-choices.md) saying what the sources say and which reading the model takes.
- If a published number or formula exists, add a unit test in `src/live/__tests__/` that checks the model against it.
- If a value is a guess inside a plausible range, make it a parameter with a control in the UI rather than a constant.
- Record structural decisions in [docs/adr/](docs/adr/) and new terms in [GLOSSARY.md](GLOSSARY.md).

## Before opening a pull request

```bash
pnpm typecheck
pnpm test
pnpm test:e2e     # first time: pnpm exec playwright install chromium
pnpm build
```

Keep pull requests small and focused on one change. Say in the description what you changed and how you checked it.
