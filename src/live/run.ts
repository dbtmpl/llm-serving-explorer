/**
 * What the canvas, the stats bar and the inspector read from "the thing that is running".
 *
 * Two things implement it: the TypeScript model (Explore mode, `exploreRun` below) and a BLIS replay
 * (Calibrated mode, `src/replay/adapter.ts`). The drawing code is typed against `RunWorld`, a
 * narrow view of the simulation's `World`, so it cannot reach for anything a replay does not have;
 * where the two differ in what they know (a replay has no per-block map), `RunDetail` says so and
 * the canvas draws the aggregate instead.
 */
import { advance, type World } from "../sim/index.js";

/** The fields of `World` that the interface reads. Anything else (random state, workload queues, the trace) stays out of reach. */
export type RunWorld = Pick<
  World,
  "t" | "params" | "sessions" | "reqs" | "pods" | "gatewayQueue" | "events" | "lastRoute" | "routeLog" | "m" | "tokWindow" | "startedAt" | "seen" | "store" | "remote" | "remoteBytes" | "pending" | "routerSync"
>;

/** How much of a pod's inside the run knows: every KV block, or only how full the pool is. */
export type RunDetail = "blocks" | "aggregate";

export interface Run {
  /** Which mode this is; the interface shows different controls and badges for each. */
  readonly kind: "explore" | "calibrated";
  readonly detail: RunDetail;
  /** The state to draw now. Replaced objects are fine: callers read it again every frame. */
  readonly world: RunWorld;
  /** Move the clock forward by `dt` simulated seconds; events produced are appended to `world.events`. */
  advance(dt: number): void;
}

/** The live simulation as a `Run`. `current` is read at every call because the interface replaces the world on a restart. */
export function exploreRun(current: () => World): Run {
  return {
    kind: "explore",
    detail: "blocks",
    get world() {
      return current();
    },
    advance(dt) {
      advance(current(), dt);
    }
  };
}
