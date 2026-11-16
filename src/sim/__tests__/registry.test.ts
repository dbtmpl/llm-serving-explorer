import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONCEPTS } from "../catalog.js";
import { CITATIONS, type CitationKey } from "../citations.js";
import { loadScenario } from "../../../conformance/scenario.js";
import { referencesOf as coveringReferences } from "../../../conformance/refs/index.js";
import { renderApproachTable, renderCitationList, replaceGenerated } from "../docs.js";
import { ARCHITECTURES } from "../presets/architectures.js";
import { isVerifiable } from "../verification.js";

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
    // every source the site text links with [@key] (src/content/*.md)
    const content = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../content");
    for (const f of readdirSync(content).filter((x) => x.endsWith(".md"))) for (const m of readFileSync(path.join(content, f), "utf8").matchAll(/\[@([A-Za-z0-9]+)\]/g)) used.add(m[1]!);
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

/** The names of the references that cover a scenario. */
const referencesOf = (id: string): string[] => coveringReferences(loadScenario(id)).map((r) => r.name);

/** The conformance scenarios (`conformance/scenarios/*.yaml`), by id. */
const scenarioFiles = (): string[] =>
  readdirSync(path.join(repoRoot, "conformance", "scenarios"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""));

describe("verification against the references", () => {
  const approaches = CONCEPTS.flatMap((c) => c.approaches.map((a) => ({ name: `${c.module}/${a.id}`, a })));
  it("every approach names the scenarios that check it, or says why no reference can", () => {
    for (const { name, a } of approaches) {
      const v = a.verification;
      if (isVerifiable(v)) expect(v.length, `${name}: an empty list is neither a scenario nor a reason`).toBeGreaterThan(0);
      else expect(v.notVerifiable.length, `${name}: the reason is too short to be one`).toBeGreaterThan(40);
    }
  });
  it("every scenario an approach names exists in conformance/scenarios", () => {
    const ids = new Set(scenarioFiles());
    for (const { name, a } of approaches) if (isVerifiable(a.verification)) for (const id of a.verification) expect(ids.has(id), `${name} names ${id}, which is not a scenario`).toBe(true);
  });
  it("every scenario is named by at least one approach", () => {
    const named = new Set<string>();
    for (const { a } of approaches) if (isVerifiable(a.verification)) for (const id of a.verification) named.add(id);
    expect(scenarioFiles().filter((id) => !named.has(id))).toEqual([]);
  });
  it("names no scenario twice in one approach", () => {
    for (const { name, a } of approaches) if (isVerifiable(a.verification)) expect(new Set(a.verification).size, name).toBe(a.verification.length);
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
    { file: path.join(repoRoot, "README.md"), blocks: { approaches: renderApproachTable(CONCEPTS, "src/sim/", referencesOf) } },
    { file: path.join(simDir, "README.md"), blocks: { approaches: renderApproachTable(CONCEPTS, "", referencesOf), citations: renderCitationList(CONCEPTS) } },
    ...modules.map((module) => ({
      file: path.join(simDir, module, "README.md"),
      blocks: { approaches: renderApproachTable(CONCEPTS.filter((c) => c.module === module), null, referencesOf) }
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
