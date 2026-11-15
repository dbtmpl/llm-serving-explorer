/** The scenarios the site offers, in the order of the picker. Each has a file `public/replay/<id>.json` and an entry in `src/content/replay.md`. */
export const REPLAY_IDS = ["prefix-followups", "steady-chat-70b", "overload-shedding", "kv-pressure"] as const;

export type ReplayId = (typeof REPLAY_IDS)[number];

export const DEFAULT_REPLAY: ReplayId = "prefix-followups";

/** Names for the picker; each equals the `title` of the replay file (a test checks). */
export const REPLAY_TITLES: Record<ReplayId, string> = {
  "prefix-followups": "Follow-up turns return to their pod",
  "steady-chat-70b": "Steady chat, Llama 3.1 70B",
  "overload-shedding": "Overload: queueing, then shedding",
  "kv-pressure": "KV pressure: preemption"
};
