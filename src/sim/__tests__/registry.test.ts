import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONCEPTS } from "../catalog.js";
import { CITATIONS, type CitationKey } from "../citations.js";
import { renderApproachTable, renderCitationList, replaceGenerated } from "../docs.js";
import { ARCHITECTURES } from "../presets/architectures.js";

const simDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(simDir, "../..");
const modules = [...new Set(CONCEPTS.map((c) => c.module))];

describe("citation registry", () => {
  it("every source has a short name, a title and an https link", () => {
    for (const [key, c] of Object.entries(CITATIONS)) {
      expect(c.short.length, key).toBeGreaterThan(3);
      expect(c.title.length, key).toBeGreaterThan(5);
      expect(c.url, key).toMatch(/^https:\/\/\S+$/);
    }
  });
  it("papers link to arXiv, a DOI or the proceedings, not to a search page", () => {
    for (const [key, c] of Object.entries(CITATIONS)) {
      if (c.kind === "paper") expect(c.url, key).toMatch(/^https:\/\/(arxiv\.org\/abs\/|doi\.org\/|www\.usenix\.org\/conference\/)/);
    }
  });
  it("every source is used by an approach, a preset or the hardware catalog", async () => {
    const used = new Set<string>();
    for (const concept of CONCEPTS) for (const a of concept.approaches) for (const key of a.citations) used.add(key);
    for (const arch of ARCHITECTURES) for (const key of arch.citations) used.add(key);
    const { GPUS, MODELS } = await import("../hardware/catalog.js");
    for (const entry of [...Object.values(GPUS), ...Object.values(MODELS)]) used.add(entry.source);
    for (const gpu of Object.values(GPUS)) used.add(gpu.memorySource);
    // cited in docstrings as related work that is deliberately not modelled
    const relatedWorkOnly: CitationKey[] = ["yu2023", "sun2024", "zheng2023"];
    for (const key of relatedWorkOnly) used.add(key);
    // named on the website as products or projects, linked from the prose in src/content/
    const namedInProse: CitationKey[] = ["keda", "vllmRepo", "sglangRepo", "tgiRepo", "tfServing", "dynamoRepo", "openaiRateLimits", "envoyAiGatewayRateLimit", "llmdKvCacheIndexer", "vllmOpenAiServer"];
    for (const key of namedInProse) used.add(key);
    expect(Object.keys(CITATIONS).filter((key) => !used.has(key))).toEqual([]);
  });
});

describe("approach registry", () => {
  it("every approach cites at least one registered source and describes itself", () => {
    for (const concept of CONCEPTS) {
      expect(concept.approaches.length, concept.title).toBeGreaterThan(0);
      for (const a of concept.approaches) {
        expect(a.citations.length, a.id).toBeGreaterThan(0);
        for (const key of a.citations) expect(CITATIONS[key], `${a.id} cites ${key}`).toBeDefined();
        expect(a.summary.length, a.id).toBeGreaterThan(20);
      }
    }
  });
  it("approach ids are unique within a concept", () => {
    for (const concept of CONCEPTS) {
      const ids = concept.approaches.map((a) => a.id);
      expect(new Set(ids).size, concept.title).toBe(ids.length);
    }
  });
  it("every architecture preset cites its sources", () => {
    for (const arch of ARCHITECTURES) expect(arch.citations.length, arch.id).toBeGreaterThan(0);
  });
});

describe("module layout", () => {
  it("every module has a README and unit tests", () => {
    for (const module of modules) {
      expect(existsSync(path.join(simDir, module, "README.md")), `${module}/README.md`).toBe(true);
      const tests = path.join(simDir, module, "__tests__");
      expect(existsSync(tests) && readdirSync(tests).some((f) => f.endsWith(".test.ts")), `${module}/__tests__`).toBe(true);
    }
  });
});

/**
 * The tables in the READMEs are generated from the registries. This test fails when they are out
 * of date; `pnpm docs:sync` rewrites them.
 */
describe("generated documentation", () => {
  const targets: { file: string; blocks: Record<string, string> }[] = [
    { file: path.join(repoRoot, "README.md"), blocks: { approaches: renderApproachTable(CONCEPTS, "src/sim/") } },
    { file: path.join(simDir, "README.md"), blocks: { approaches: renderApproachTable(CONCEPTS, ""), citations: renderCitationList(CONCEPTS) } },
    ...modules.map((module) => ({
      file: path.join(simDir, module, "README.md"),
      blocks: { approaches: renderApproachTable(CONCEPTS.filter((c) => c.module === module), null) }
    }))
  ];
  for (const target of targets) {
    it(`${path.relative(repoRoot, target.file)} is in step with the code`, () => {
      const current = readFileSync(target.file, "utf8");
      let expected = current;
      for (const [name, content] of Object.entries(target.blocks)) expected = replaceGenerated(expected, name, content);
      if (process.env.UPDATE_DOCS) writeFileSync(target.file, expected);
      else expect(current, "out of date: run `pnpm docs:sync`").toBe(expected);
    });
  }
});
