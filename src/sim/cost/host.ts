/**
 * Host (CPU) time of an engine step: scheduling, tokenisation bookkeeping, sampling, detokenising
 * and streaming. The GPU roofline does not include it, and at small batch sizes it is not small.
 *
 * This is a parameterised stand-in, not a measurement: reported per-step host times range from
 * a few milliseconds to tens of milliseconds under load, so both coefficients are controls.
 */

const MS_PER_SECOND = 1e3;

/**
 * Host seconds for a step with `batch` sequences.
 *
 *     t_host = base + perSequence · batch
 *
 * Example: 1.5 ms + 0.05 ms · 12 sequences = 2.1 ms.
 */
export function hostSeconds(baseMs: number, perSequenceMs: number, batch: number): number {
  return (baseMs + perSequenceMs * batch) / MS_PER_SECOND;
}

/**
 * Wall-clock step time from host and GPU time.
 *
 * Synchronous engines do host work between GPU steps, so the two add. Engines that schedule
 * asynchronously prepare the next step while the GPU runs the current one, so the step takes
 * whichever is longer.
 */
export function stepSeconds(tHost: number, tGpu: number, overlap: boolean): number {
  return overlap ? Math.max(tHost, tGpu) : tHost + tGpu;
}
