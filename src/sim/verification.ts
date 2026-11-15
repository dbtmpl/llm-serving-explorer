/**
 * How each approach is checked against BLIS, the discrete-event simulator that embeds the llm-d
 * router and a translation of vLLM's scheduler (`conformance/`, `docs/blis-parity.md`).
 *
 * An approach names the conformance scenarios that check it, or says why none can. The registry test
 * enforces that every approach does one or the other, that every scenario named exists in
 * `conformance/scenarios/`, and that every scenario is named by at least one approach.
 */

/** Scenario ids (file names in `conformance/scenarios/` without `.yaml`), or the reason BLIS cannot check this. */
export type Verification = readonly string[] | { readonly notVerifiable: string };

export const isVerifiable = (v: Verification): v is readonly string[] => Array.isArray(v);

/** The scenarios that fit and check the cost model's timing, by (model, GPU) pair; the calibration ones feed the fit, the others are held out. */
const CALIBRATION = ["isolated", "batch4", "batch16", "batch48", "batch16-long"] as const;
const calibration = (pair: string): string[] => CALIBRATION.map((r) => `calib-${pair}-${r}`);

export const TIMING_8B_H100 = [...calibration("8b-h100"), "timing-8b-h100-chat", "timing-8b-h100-heavy", "timing-8b-h100-burst"] as const;
export const TIMING_8B_B200 = [...calibration("8b-b200"), "timing-8b-b200-chat"] as const;
export const TIMING_70B_H200 = [...calibration("70b-h200"), "timing-70b-h200-chat"] as const;

/** Every scenario that checks time to first token, time per token or throughput after calibration. */
export const TIMING = [...TIMING_8B_H100, ...TIMING_8B_B200, ...TIMING_70B_H200] as const;
