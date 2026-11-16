/**
 * How each approach is checked against the references of the conformance suite (BLIS, which embeds
 * the llm-d router and a translation of vLLM's scheduler; measured data): `conformance/`, `docs/parity.md`.
 *
 * An approach names the conformance scenarios that check it, or says why none can. The registry test
 * enforces that every approach does one or the other, that every scenario named exists in
 * `conformance/scenarios/`, and that every scenario is named by at least one approach.
 */

/** Scenario ids (file names in `conformance/scenarios/` without `.yaml`), or the reason no reference can check this. */
export type Verification = readonly string[] | { readonly notVerifiable: string };

export const isVerifiable = (v: Verification): v is readonly string[] => Array.isArray(v);

/** The scenarios that fit and check the cost model's timing, by (model, GPU) pair; the calibration ones feed the fit, the others are held out. */
const CALIBRATION = ["isolated", "batch4", "batch16", "batch48", "batch16-long"] as const;
const calibration = (pair: string): string[] => CALIBRATION.map((r) => `calib-${pair}-${r}`);

export const TIMING_8B_H100 = [...calibration("8b-h100"), "timing-8b-h100-chat", "timing-8b-h100-heavy", "timing-8b-h100-burst"] as const;
export const TIMING_8B_B200 = [...calibration("8b-b200"), "timing-8b-b200-chat"] as const;
export const TIMING_70B_H200 = [...calibration("70b-h200"), ...calibration("70b-h200-tp2"), ...calibration("70b-h200-tp8"), "timing-70b-h200-chat"] as const;

/** Replays of real vLLM runs on two workstation GPUs: timing under default and fitted parameters, and the KV pool the engine reported. */
export const MEASURED = ["measured-8b-rtx-pro-6000", "measured-8b-rtx-4090"] as const;

/** Every scenario that checks time to first token, time per token or throughput after calibration (and, for the measured ones, before it too). */
export const TIMING = [...TIMING_8B_H100, ...TIMING_8B_B200, ...TIMING_70B_H200, ...MEASURED] as const;
