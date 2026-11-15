import { createWorld } from "../sim/index.js";
import type { Run } from "../live/run.js";

/** What the graph shows between asking for a replay and receiving its file: nothing, and a clock that does not move. */
export function blankRun(): Run {
  const world = createWorld();
  return {
    kind: "calibrated",
    detail: "aggregate",
    world,
    advance() {}
  };
}
