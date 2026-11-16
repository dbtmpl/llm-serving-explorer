/**
 * Reduce LLMServingSim's two Llama 3.1 8B bench examples to `data/<gpu>-<model>.json`: the cluster configuration and the prefix
 * structure of the workload's token ids (see `data.ts`).
 *
 *     LLMSERVINGSIM_DIR=/path/to/LLMServingSim pnpm conformance:extract-llmservingsim
 *
 * The clone must be at the commit in `lock`. The workload is the one the example's `vllm/meta.json` names, the same 300 ShareGPT
 * requests as `refs/vllm-measured`.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, lockedCommit, type PrefixData } from "./data.js";

const EXAMPLES = [
  { gpu: "rtx-pro-6000", model: "llama-3.1-8b", dir: "bench/examples/RTXPRO6000/Llama-3.1-8B" },
  { gpu: "rtx-4090", model: "llama-3.1-8b", dir: "bench/examples/RTX4090/Llama-3.1-8B" }
];

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

interface Node {
  next: Map<number, Node>;
  owner: number;
}

/** For every request, the earlier one that shares the longest prefix with it and how long that prefix is. */
export function prefixStructure(inputs: number[][]): { parent: number; shared: number }[] {
  const root: Node = { next: new Map(), owner: -1 };
  return inputs.map((ids, i) => {
    let node = root;
    let depth = 0;
    let owner = -1;
    for (const t of ids) {
      const n = node.next.get(t);
      if (!n) break;
      node = n;
      depth++;
      owner = n.owner;
    }
    node = root;
    for (const t of ids) {
      let n = node.next.get(t);
      if (!n) {
        n = { next: new Map(), owner: i };
        node.next.set(t, n);
      }
      node = n;
    }
    return { parent: depth ? owner : -1, shared: depth };
  });
}

export function extract(clone: string, ex: (typeof EXAMPLES)[number]): PrefixData {
  const meta = JSON.parse(readFileSync(path.join(clone, ex.dir, "vllm", "meta.json"), "utf8"));
  const workload = path.join(clone, meta.dataset_path as string);
  const rows = readFileSync(workload, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(0, meta.num_requests)
    .map((l) => JSON.parse(l) as { input_toks: number; output_toks: number; input_tok_ids: number[] });
  for (const r of rows) if (r.input_tok_ids.length !== r.input_toks) throw new Error(`${meta.dataset_path}: a request's token ids are not its input length`);
  const structure = prefixStructure(rows.map((r) => r.input_tok_ids));
  const files: Record<string, string> = {
    [`${ex.dir}/config.json`]: sha256(path.join(clone, ex.dir, "config.json")),
    [meta.dataset_path]: sha256(workload),
    [`${ex.dir}/outputs/sim.csv`]: sha256(path.join(clone, ex.dir, "outputs", "sim.csv"))
  };
  return {
    id: `${ex.gpu}-${ex.model}`,
    gpu: ex.gpu,
    model: ex.model,
    source: { repository: "https://github.com/casys-kaist/LLMServingSim", commit: lockedCommit(), licence: "MIT", copyright: "Copyright (c) 2024, CASYS Lab at KAIST", files },
    cluster: JSON.parse(readFileSync(path.join(clone, ex.dir, "config.json"), "utf8")),
    requests: rows.map((r, i) => ({ inputTokens: r.input_toks, outputTokens: r.output_toks, ...structure[i]! })),
    committedResultSha256: files[`${ex.dir}/outputs/sim.csv`]!
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const clone = process.env.LLMSERVINGSIM_DIR;
  if (!clone) throw new Error("name a clone of https://github.com/casys-kaist/LLMServingSim at the commit in conformance/refs/llmservingsim/lock with LLMSERVINGSIM_DIR=<path>");
  const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== lockedCommit()) throw new Error(`${clone} is at ${head} but conformance/refs/llmservingsim/lock names ${lockedCommit()}`);
  mkdirSync(DATA_DIR, { recursive: true });
  for (const ex of EXAMPLES) {
    const d = extract(clone, ex);
    writeFileSync(path.join(DATA_DIR, `${d.id}.json`), JSON.stringify(d) + "\n");
    console.log(`wrote data/${d.id}.json: ${d.requests.length} requests, ${d.requests.filter((r) => r.shared >= 16).length} share at least a block`);
  }
}
