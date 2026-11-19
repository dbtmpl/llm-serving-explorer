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
| `src/sim/` | The simulation, one module per concept. Start with [`src/sim/README.md`](src/sim/README.md). |
| `src/sim/citations.ts` | Every source the model relies on. |
| `src/content/` | Every piece of explanatory text on the site, as markdown. See [`src/content/README.md`](src/content/README.md). |
| `conformance/` | Tests that compare the model with three references (BLIS, measured vLLM runs, LLMServingSim), and the parity results. A model change can make a recorded difference disappear or a new one appear; see [`conformance/README.md`](conformance/README.md). |
| `src/live/` | The user interface: rendering, menus, inspector, tutorial, callouts. |
| `e2e/` | Playwright tests. |

## Changing the model

The simulation is a teaching model, so every behaviour must be traceable to a source. The rules are in [`src/sim/README.md`](src/sim/README.md#rules); in short:

- **A new approach needs a citation.** A paper with its arXiv or DOI link, project documentation, or source code. Add it to `src/sim/citations.ts`.
- **One approach, one file,** implementing the interface of the module that owns the decision. Do not add a branch to an existing approach.
- **Write the docstring first:** the source, the rule or formula, a worked example with numbers, and what is simplified.
- **Test against the source:** the worked example, the edge cases, and the behaviour inside the engine.
- **No unnamed numbers.** Constants are named and say where they come from; guesses are parameters.
- **Run `pnpm docs:sync`** so the tables in the READMEs match the code.

If your change is meant to leave behaviour alone, `src/sim/engine/__tests__/behaviour.test.ts` must pass unchanged. If it changes the model on purpose, update the snapshots with `pnpm test -u` and explain the change in the commit message.

Where sources disagree, record which reading you took in [docs/design-choices.md](docs/design-choices.md). Record structural decisions in [docs/adr/](docs/adr/) and new terms in [GLOSSARY.md](GLOSSARY.md).

## Before opening a pull request

```bash
pnpm typecheck
pnpm test
pnpm test:e2e     # first time: pnpm exec playwright install chromium
pnpm build
```

`main` is protected: every change goes through a pull request, which merges once the `test` and `conformance` checks pass. Keep pull requests small and focused on one change, and say in the description what you changed and how you checked it.
