/** The scenarios the site offers, in the order of the picker. Each has a file `public/replay/<id>.json` and an entry in `src/content/replay.md`. */
export const REPLAY_IDS = ["prefix-followups", "steady-chat-70b", "overload-shedding", "kv-pressure"] as const;

export type ReplayId = (typeof REPLAY_IDS)[number];

export const DEFAULT_REPLAY: ReplayId = "prefix-followups";
