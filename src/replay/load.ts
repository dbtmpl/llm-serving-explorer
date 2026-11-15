import { REPLAY_DIR, parseReplay, type ReplayFile } from "./schema.js";

/** Fetch and validate one replay file from the site. */
export async function loadReplay(id: string): Promise<ReplayFile> {
  const res = await fetch(`${import.meta.env.BASE_URL}${REPLAY_DIR}/${id}.json`);
  if (!res.ok) throw new Error(`${id}.json: HTTP ${res.status}`);
  return parseReplay(await res.json());
}
