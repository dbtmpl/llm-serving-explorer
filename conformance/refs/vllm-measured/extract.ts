/**
 * Reduce LLMServingSim's measured vLLM runs to the committed files in `data/`.
 *
 *     LLMSERVINGSIM_DIR=/path/to/LLMServingSim pnpm conformance:extract
 *
 * The clone must be at the commit in `lock` (checked). Only the Llama 3.1 8B examples are reduced: they are the ones the
 * model can represent. What is kept per run: the engine settings and KV block count from `meta.json`, per-request
 * arrival, token counts and first/last token times from `requests.jsonl`, and totals of `timeseries.csv`; the SHA-256 of
 * each source file is recorded. LLMServingSim is MIT-licensed (`LICENSE-LLMServingSim` is its licence text, kept with the data).
 *
 * Times: `arrival_time` is the client's epoch clock; `queued_ts`, `first_token_ts` and `last_token_ts` are the engine's monotonic
 * clock. The offset between them is estimated, as LLMServingSim's validator does (`bench/core/validate.py`,
 * `bench_epoch_to_monotonic_offset`), as the smallest `queued_ts - arrival_time` of the run. Time to first token is then
 * `first_token_ts - (arrival_time + offset)`, which includes the wait before the engine picked the request up.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, lockedCommit, type Measured, type MeasuredRequest } from "./measured.js";

interface Example {
  gpu: string;
  model: string;
  dir: string;
}

/** Examples the model can represent: one model, one GPU each. */
export const EXAMPLES: Example[] = [
  { gpu: "rtx-pro-6000", model: "llama-3.1-8b", dir: "bench/examples/RTXPRO6000/Llama-3.1-8B" },
  { gpu: "rtx-4090", model: "llama-3.1-8b", dir: "bench/examples/RTX4090/Llama-3.1-8B" }
];

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const us = (x: number): number => Math.round(x * 1e6) / 1e6;

export function extract(clone: string, ex: Example): Measured {
  const root = path.join(clone, ex.dir, "vllm");
  const files = { "meta.json": path.join(root, "meta.json"), "requests.jsonl": path.join(root, "requests.jsonl"), "timeseries.csv": path.join(root, "timeseries.csv") };
  const meta = JSON.parse(readFileSync(files["meta.json"], "utf8"));
  const raw = readFileSync(files["requests.jsonl"], "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { request_id: string; input_toks: number; output_toks: number; arrival_time: number; queued_ts: number; first_token_ts: number; last_token_ts: number });
  const offset = Math.min(...raw.map((r) => r.queued_ts - r.arrival_time));
  const t0 = Math.min(...raw.map((r) => r.arrival_time));
  const requests: MeasuredRequest[] = raw
    .slice()
    .sort((a, b) => a.arrival_time - b.arrival_time)
    .map((r) => ({
      id: r.request_id,
      arrivalS: us(r.arrival_time - t0),
      inputTokens: r.input_toks,
      outputTokens: r.output_toks,
      firstTokenS: us(r.first_token_ts - offset - t0),
      lastTokenS: us(r.last_token_ts - offset - t0)
    }));
  const lines = readFileSync(files["timeseries.csv"], "utf8").trim().split("\n");
  const header = lines[0]!.trim().split(",").map((h) => h.trim());
  const rows = lines.slice(1).map((l) => Object.fromEntries(l.trim().split(",").map((v, i) => [header[i]!, Number(v)])) as Record<string, number>);
  const column = (name: string): number[] | null => (header.includes(name) ? rows.map((r) => r[name]!) : null);
  const sum = (xs: number[] | null): number | null => (xs ? xs.reduce((a, b) => a + b, 0) : null);
  const cfg = meta.resolved_config ?? {};
  const kv = meta.kv_cache;
  return {
    id: `${ex.gpu}-${ex.model}`,
    gpu: ex.gpu,
    model: ex.model,
    source: {
      repository: "https://github.com/casys-kaist/LLMServingSim",
      commit: lockedCommit(),
      licence: "MIT",
      copyright: "Copyright (c) 2024, CASYS Lab at KAIST",
      files: Object.fromEntries(Object.entries(files).map(([name, f]) => [`${ex.dir}/vllm/${name}`, sha256(f)]))
    },
    engine: {
      vllmVersion: meta.vllm_version,
      deviceName: meta.hardware.device_name,
      deviceTotalMemoryBytes: meta.hardware.device_total_memory_bytes,
      gpuMemoryUtilisation: kv.gpu_memory_utilization,
      maxNumSeqs: meta.engine_kwargs.max_num_seqs,
      maxNumBatchedTokens: meta.engine_kwargs.max_num_batched_tokens,
      maxModelLen: cfg.model_config?.max_model_len ?? meta.engine_kwargs.max_model_len,
      blockSize: kv.block_size,
      enablePrefixCaching: kv.enable_prefix_caching,
      tensorParallelSize: meta.engine_kwargs.tensor_parallel_size,
      numGpuBlocks: kv.num_gpu_blocks,
      asyncScheduling: cfg.scheduler_config?.async_scheduling ?? null,
      schedulerReserveFullIsl: cfg.scheduler_config?.scheduler_reserve_full_isl ?? null,
      cudagraphMode: cfg.compilation_config?.cudagraph_mode === undefined ? null : JSON.stringify(cfg.compilation_config.cudagraph_mode)
    },
    workload: { dataset: meta.dataset_path, datasetSha256: meta.dataset_hash, requests: meta.num_requests, startedAt: meta.started_at },
    clockOffsetS: us(offset),
    timeseries: {
      ticks: rows.length,
      promptTokens: sum(column("prompt_throughput"))!,
      cachedPromptTokens: sum(column("prompt_cached_throughput")),
      preemptedMax: column("preempted") ? Math.max(...column("preempted")!) : null,
      runningMax: Math.max(...column("running")!),
      waitingMax: Math.max(...column("waiting")!),
      kvCachePctMax: Math.max(...column("kv_cache_pct")!)
    },
    requests
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const clone = process.env.LLMSERVINGSIM_DIR;
  if (!clone) throw new Error("name a clone of https://github.com/casys-kaist/LLMServingSim at the commit in conformance/refs/vllm-measured/lock with LLMSERVINGSIM_DIR=<path>");
  const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== lockedCommit()) throw new Error(`${clone} is at ${head} but conformance/refs/vllm-measured/lock names ${lockedCommit()}`);
  mkdirSync(DATA_DIR, { recursive: true });
  for (const ex of EXAMPLES) {
    const m = extract(clone, ex);
    writeFileSync(path.join(DATA_DIR, `${m.id}.json`), JSON.stringify(m, null, 1) + "\n");
    console.log(`wrote data/${m.id}.json: ${m.requests.length} requests, ${m.engine.numGpuBlocks} KV blocks`);
  }
}
