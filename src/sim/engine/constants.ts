/**
 * Numbers that belong to the simulation loop itself rather than to any modelled approach.
 */

/** Clock resolution, seconds. Engine steps end at exact times between ticks, so this only bounds reaction time. */
export const TICK_S = 0.002;

/** Remaining time below this is treated as zero when advancing the clock, seconds. */
export const TIME_EPSILON_S = 1e-9;

/** How long a pod with nothing schedulable waits before trying again, seconds. */
export const IDLE_RETRY_S = 0.002;

/** Upper bound on engine steps one pod may complete inside a single clock tick. */
export const MAX_STEPS_PER_TICK = 64;

/** Pod start-up is split into scheduling the pod and loading weights, as shares of the cold-start time. */
export const COLD_START_SHARES = { creating: 0.25, loading: 0.75 } as const;

/** Seconds a pod spends draining before it terminates. Illustrative. */
export const DRAIN_S = 0.5;

/** Seconds a terminated pod stays in the scene so its disappearance can be seen. */
export const TERMINATED_LINGER_S = 0.25;

/** A latency sample window: the medians shown are over the most recent requests. */
export const LATENCY_WINDOW = 300;

/** Throughput is tokens emitted during the last this-many seconds. */
export const THROUGHPUT_WINDOW_S = 1;

/** Time-series sampling for the interface's charts. */
export const SAMPLE_INTERVAL_S = 0.1;
export const HISTORY_SAMPLES = 240;

/** How often, and from how many sessions on, a summary of session churn is reported. */
export const CHURN_INTERVAL_S = 6;
export const CHURN_MIN_SESSIONS = 8;

/** A step is reported as "prefill sharing a step with decodes" from these sizes on. */
export const MIXED_STEP = { minDecodeTokens: 2, minPrefillTokens: 512 } as const;

const SECONDS_PER_HOUR = 3600;
const TOKENS_PER_MILLION = 1e6;
export const UNITS = { SECONDS_PER_HOUR, TOKENS_PER_MILLION } as const;
