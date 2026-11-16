/**
 * The committed form of the measurements: what was reduced from LLMServingSim's `bench/examples/<GPU>/<model>/vllm/`
 * files (real vLLM runs of 300 ShareGPT requests at about 10 requests per second). One JSON file per example under `data/`,
 * written by `extract.ts` from a clone at the commit in `lock`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(DIR, "data");
export const LOCK_FILE = path.join(DIR, "lock");

export interface MeasuredRequest {
  /** The benchmark's id (`bench-0`). */
  id: string;
  /** Seconds after the first request was sent, as the client sent it. */
  arrivalS: number;
  inputTokens: number;
  outputTokens: number;
  /** Seconds after the first request was sent, in the same clock: the engine's monotonic timestamps moved to it by one offset (see `clockOffsetS`). */
  firstTokenS: number;
  lastTokenS: number;
}

export interface Measured {
  /** `<gpu>-<model>`: the file name. Neutral names of the scenario vocabulary. */
  id: string;
  gpu: string;
  model: string;
  source: {
    repository: string;
    commit: string;
    licence: string;
    copyright: string;
    /** Path inside the repository to the SHA-256 of that file at the commit. */
    files: Record<string, string>;
  };
  /** What the run was: engine version, flags and the memory it saw. All read from `meta.json`. */
  engine: {
    vllmVersion: string;
    deviceName: string;
    /** `device_total_memory_bytes`: what the driver reported. */
    deviceTotalMemoryBytes: number;
    gpuMemoryUtilisation: number;
    maxNumSeqs: number;
    maxNumBatchedTokens: number;
    maxModelLen: number;
    blockSize: number;
    enablePrefixCaching: boolean;
    tensorParallelSize: number;
    /** The KV blocks the engine reported (`num_gpu_blocks`). */
    numGpuBlocks: number;
    /** Settings the model has no counterpart for, as the run recorded them (null where the vLLM version does not record it). */
    asyncScheduling: boolean | null;
    schedulerReserveFullIsl: boolean | null;
    cudagraphMode: string | null;
  };
  workload: {
    dataset: string;
    datasetSha256: string;
    requests: number;
    startedAt: string;
  };
  /**
   * Seconds subtracted from the engine's monotonic timestamps (`first_token_ts`, `last_token_ts`) to put them in the client's epoch
   * clock: the smallest `queued_ts - arrival_time` over the run, as LLMServingSim's validator estimates it, so that the least-delayed request's
   * pickup delay is zero and every other request's first-token time includes the wait before the engine took it up.
   */
  clockOffsetS: number;
  /** Per-second engine statistics reduced to totals; null where the run did not record the column. */
  timeseries: {
    ticks: number;
    promptTokens: number;
    /** Prompt tokens the engine served from its prefix cache. */
    cachedPromptTokens: number | null;
    /** Largest value of the `preempted` column. */
    preemptedMax: number | null;
    runningMax: number;
    waitingMax: number;
    kvCachePctMax: number;
  };
  requests: MeasuredRequest[];
}

export function loadMeasured(id: string): Measured {
  return JSON.parse(readFileSync(path.join(DATA_DIR, `${id}.json`), "utf8")) as Measured;
}

/** The commit named by `lock`. */
export function lockedCommit(): string {
  const line = readFileSync(LOCK_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line || !/^[0-9a-f]{40}$/.test(line)) throw new Error(`${LOCK_FILE}: the first non-comment line must be a full 40-character commit hash`);
  return line;
}
