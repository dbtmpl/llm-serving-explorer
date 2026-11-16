/**
 * What is committed from LLMServingSim's own bench examples (MIT licence, `LICENSE-LLMServingSim`), per example `<gpu>-<model>`:
 * the cluster configuration its authors validated with, and the prefix structure of the workload's token ids.
 *
 * The prefix structure is all of the token ids the simulation needs and nothing more: for each request, the earlier request
 * that shares the longest prefix with it and the length of that shared prefix in tokens. Synthetic ids built from it
 * (`translate.ts`) have exactly the same prefix trie as the real ones, so the block hashes of the simulator's prefix cache
 * match exactly where the real ones do. The real token ids, the text they encode, are not committed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(DIR, "data");
export const LOCK_FILE = path.join(DIR, "lock");

export interface PrefixData {
  id: string;
  gpu: string;
  model: string;
  source: { repository: string; commit: string; licence: string; copyright: string; files: Record<string, string> };
  /** The cluster configuration of the example, verbatim. */
  cluster: Record<string, unknown>;
  /** Per request in dataset order: tokens in and out, and the earlier request sharing the longest prefix (-1: none) with the length shared. */
  requests: { inputTokens: number; outputTokens: number; parent: number; shared: number }[];
  /** LLMServingSim's committed result for the example (`outputs/sim.csv`): SHA-256 of the file, to say which result this was checked against. */
  committedResultSha256: string;
}

export function loadPrefixData(id: string): PrefixData {
  return JSON.parse(readFileSync(path.join(DATA_DIR, `${id}.json`), "utf8")) as PrefixData;
}

export function lockedCommit(): string {
  const line = readFileSync(LOCK_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line || !/^[0-9a-f]{40}$/.test(line)) throw new Error(`${LOCK_FILE}: the first non-comment line must be a full 40-character commit hash`);
  return line;
}
