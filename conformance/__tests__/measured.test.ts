/**
 * The measured-data reference: its committed reduction is consistent with itself, the scenarios replay it exactly,
 * and a scenario that differs from the run is refused.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR, DIR, loadMeasured, lockedCommit } from "../refs/vllm-measured/measured.js";
import { translate, vllmMeasured } from "../refs/vllm-measured/index.js";
import { loadScenario, mainArm } from "../scenario.js";

const ids = readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json"));

describe("measured vLLM data", () => {
  it("is attributed: MIT licence text kept, repository, pinned commit and a SHA-256 for every source file", () => {
    expect(existsSync(path.join(DIR, "LICENSE-LLMServingSim"))).toBe(true);
    expect(readFileSync(path.join(DIR, "LICENSE-LLMServingSim"), "utf8")).toMatch(/MIT License[\s\S]*CASYS Lab/);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const m = loadMeasured(id);
      expect(m.source).toMatchObject({ repository: "https://github.com/casys-kaist/LLMServingSim", licence: "MIT", commit: lockedCommit() });
      for (const h of Object.values(m.source.files)) expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(m.source.files)).toHaveLength(3);
    }
  });
  it("has 300 requests in arrival order with first token after arrival and last after first", () => {
    for (const id of ids) {
      const m = loadMeasured(id);
      expect(m.requests).toHaveLength(m.workload.requests);
      m.requests.forEach((r, i) => {
        if (i) expect(r.arrivalS, `${id} ${r.id}`).toBeGreaterThanOrEqual(m.requests[i - 1]!.arrivalS);
        expect(r.firstTokenS).toBeGreaterThan(r.arrivalS);
        expect(r.lastTokenS).toBeGreaterThan(r.firstTokenS);
      });
    }
  });
  it("every dataset has a scenario that replays it exactly, and the reference answers it", () => {
    for (const id of ids) {
      const s = loadScenario(`measured-8b-${id.replace("-llama-3.1-8b", "")}`);
      const input = translate(s, "main");
      expect(input.measured.id).toBe(id);
      const rec = vllmMeasured.reduce(s, "main", vllmMeasured.run(input, { settings: {} }));
      expect(rec.kvBlocksPerReplica).toBe(input.measured.engine.numGpuBlocks);
      expect(rec.requests).toHaveLength(300);
    }
  });
  it("refuses a scenario whose requests or engine settings differ from the run", () => {
    const s = loadScenario("measured-8b-rtx-4090");
    mainArm(s).requests[3]!.newTokens += 1;
    expect(() => translate(s, "main")).toThrow(/not the measured run[\s\S]*input tokens/);
    const t = loadScenario("measured-8b-rtx-4090");
    mainArm(t).engine.maxNumSeqs = 128;
    expect(() => translate(t, "main")).toThrow(/max_num_seqs: the scenario says 128, the measured run had 256/);
  });
  it("does not use more of the repository than the measurements: no simulator output among the sources", () => {
    for (const id of ids) for (const f of Object.keys(loadMeasured(id).source.files)) expect(f).toMatch(/\/vllm\/(meta\.json|requests\.jsonl|timeseries\.csv)$/);
  });
});
