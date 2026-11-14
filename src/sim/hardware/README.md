# Hardware

Declared facts about models and accelerators. Nothing here is computed.

| File | Contents |
|---|---|
| [`catalog.ts`](catalog.ts) | Model architectures, GPU datasheet values, weight precisions, the replica specification |

## Adding a model or GPU

1. Add the entry to `MODELS` or `GPUS` with values taken from the model's published `config.json` or the vendor's datasheet.
2. Add the source to [`../citations.ts`](../citations.ts) and set the entry's `source` to its key.
3. Use decimal units as on datasheets (1 GB = 1e9 bytes) and the dense peak FLOP/s figure, not one that assumes sparsity.
4. Run `pnpm test`: the catalog tests check that every entry has a source and a consistent shape.
