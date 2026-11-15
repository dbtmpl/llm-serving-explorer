# Site text

Every piece of explanatory text on the website lives in a markdown file here, so it can be reviewed in one place. Code only chooses an entry, fills its `{placeholders}` and renders it. Short control labels (slider names, button captions, table headers, canvas node labels) stay in the code.

| File | What it holds | Used by |
|---|---|---|
| [`step-through.md`](step-through.md) | Floating callouts in "explain" mode and the held box in step-through mode | `src/live/callouts.ts` |
| [`dive-deeper.md`](dive-deeper.md) | The "Dive deeper" drop-downs of the step-through box: the theory behind each step, one entry per concept | `src/content/index.ts` (`diveConcepts`), `src/live/LiveView.tsx` |
| [`tutorial.md`](tutorial.md) | The guided tour cards | `src/live/Tutorial.tsx` |
| [`inspector.md`](inspector.md) | The notes in the "dive in" panel | `src/live/Inspector.tsx` |
| [`panels.md`](panels.md) | Empty-state card, scenario hints, notes in the menus, legend note | `src/live/LiveView.tsx` |
| [`architectures.md`](architectures.md) | Name, what it adds and sources of each serving architecture | `src/live/LiveView.tsx`, by architecture id |

## Entry format

Each file starts with an `# H1` title and one paragraph saying where on the site its texts appear. Then one entry per text:

```
## `entry.id` Human headline
_Where:_ one sentence saying where and when this text is shown on the site.

### title
Routed to pod-{podId}

### body
One or more paragraphs.

### detail
Shown only in step-through mode.
```

- The heading is the id in backticks, then a headline for the reviewer. Ids are unique within a file.
- `_Where:_` is required.
- Fields are `###` subsections with a lower-case name. The names depend on the file (`title`/`body`/`detail`/`at` for callouts, where `at` says where in the system the step happens and only step-through shows it, `title`/`text` for the tour, `text` for single notes, `name`/`adds`/`source` for architectures).
- Where the code picks between variants or adds an optional sentence (plurals, the three routing policies, the disaggregation sentence), each variant is its own field with a clear name (`title-one`, `title-many`, `how-round-robin`, `cap`). The code names the fields it wants; chosen fields are joined with a space.
- Paragraphs are separated by a blank line.

### Dive deeper

`dive-deeper.md` has one entry per concept with fields `title`, `body` (80 to 180 words, at least one `[@key]` citation) and an optional `formula` (a `$$ ... $$` block). Which concepts a step shows is decided in one place: the `### dive` field of the step's entry in `step-through.md`, a comma-separated list of concept ids in the order they are shown (1 to 4). Every step the step-through shows has one; explain-only entries (`step.tokens.batch`, `step.spec`, `step.mixed`, `churn`, `scale.down`, `fleet.restart`) do not. A concept used by several steps is written once, and its `_Where:_` line lists exactly the steps that use it (a test checks both directions). The box renders each concept as a native `<details>`, closed whenever the step changes.

## Placeholders

`{name}` is filled by the code (`name` starts with a letter, then letters and digits). Numbers are formatted by the code (`fmtInt`, `fmtMs`, `fmtGB`), never in the text. A placeholder without a value, or a value that no chosen field uses, throws, so a mistake fails loudly in the tests instead of rendering `{name}`.

## Inline markup

| Write | Renders as |
|---|---|
| `**bold**` | bold |
| `` `code` `` | code |
| `[text](https://example.org)` | a link (https only) |
| `[@key]` | a link whose text is the citation's `short` and whose href is its `url` in `src/sim/citations.ts` |
| `[custom text][@key]` | the same link with your own text |
| `$x_p$` | an inline formula, typeset with [KaTeX](https://katex.org/) (TeX syntax) |

Every paper, project, repository, documentation page or datasheet named in the text is linked this way. If the source is not in `CITATIONS` yet, add it there first (see the rules in [`src/sim/README.md`](../sim/README.md)); an unknown `@key` throws. Links open in a new tab. Never cite or mention internal sources.

## Blocks: formulas and tables

A block is a paragraph of its own (blank lines around it).

A **formula** is a paragraph that starts and ends with `$$`:

```
$$\text{score}(p) = [[wCache]]\,c_p + [[wKv]]\,m_p + [[wQueue]]\,q_p$$
```

It is typeset by KaTeX at runtime (HTML for the eye, MathML for screen readers); the stylesheet and fonts are bundled with the site, nothing is loaded from a CDN. Inside a formula `{...}` is TeX, not a placeholder, so a value that belongs in a formula is written `[[name]]` (this form also works outside formulas). Put the legend of a formula under it as a table, one row per symbol, in beginner terms.

A **table** is a paragraph whose lines all start with `|`: a header row, a `|---|` rule and rows of the same width. Cells take the inline markup above. A table whose rows depend on the simulation is assembled by the code from fields of the entry (a `head-*` field with the header and rule, a `row-*` field per row), filled with `fill` and passed in as one `{table}` value.

Fields chosen together are joined by a space, except around a formula or a table, which keep a paragraph of their own. `pnpm test` typesets every formula, so a TeX mistake fails there.

## Adding or changing text

1. Edit or add the entry in the markdown file. Keep the headline and `_Where:_` line accurate.
2. In code, use the helper for the file: `stepText` (callouts, through `make(...)` in `src/live/callouts.ts`), `inspectorText` / `<Note id=...>` (Inspector), `panelText` / `panelFields` (panels), `tourText` (the tour, ids listed in `TARGETS` in `Tutorial.tsx`), `architectureText` (by architecture id). All are exported from `src/content/index.ts`.
3. Render the result with `<Rich text={...} />` from `src/live/Rich.tsx` (`inline` for titles and text inside an element of your own).
4. `pnpm test` checks that every entry is used by code, every id used by code exists, every `[@key]` resolves and every link is https.
