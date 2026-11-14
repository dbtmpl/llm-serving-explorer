/**
 * Concept: batching. When may a request join the set of sequences a pod is running?
 *
 * To add an approach: implement `BatchingMode` in its own file with its citation, add it to
 * `BATCHING.approaches`, and add a unit test. See README.md in this directory.
 */
import { selectApproach, type ApproachMeta, type Concept } from "../approach.js";
import { continuousBatching } from "./continuous.js";
import { staticBatching } from "./static.js";

export interface BatchingMode extends ApproachMeta {
  /** May new requests be admitted while `running` sequences are still in the batch? */
  admitsInto(running: number): boolean;
  /**
   * Whether admission stops once the step's token budget is used up. Engines that fill a batch
   * before it starts are not bound by a per-step budget when admitting.
   */
  admissionHonoursTokenBudget: boolean;
}

export const BATCHING: Concept<BatchingMode> = {
  module: "batching",
  title: "Batching",
  question: "When may a request join the batch a pod is running?",
  approaches: [staticBatching, continuousBatching]
};

export type BatchingId = "static" | "continuous";
export const batchingMode = (id: BatchingId): BatchingMode => selectApproach(BATCHING, id);
