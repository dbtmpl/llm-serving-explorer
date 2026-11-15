import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARCHITECTURES, CITATIONS } from "../../sim/index.js";
import { calloutFor } from "../../live/callouts.js";
import { newScript, stepsFor } from "../../live/walkthrough.js";
import { TOUR } from "../../live/Tutorial.js";
import { run, world } from "../../sim/testing.js";
import { evictIdleNow, spawnBurst } from "../../sim/index.js";
import { typeset } from "../../live/Rich.js";
import { ALL_DOCS, DIVE_DEEPER, STEP_THROUGH, diveConcepts, blocks, citationKeys, fill, fillEntry, parseDoc, parseInline, placeholders, stepText } from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../..");

const liveSource = (): string => {
  const dir = path.join(srcDir, "live");
  return readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
};

const withoutMath = (text: string): string => text.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g, "");
/** The text must split into blocks and every formula in it must typeset (KaTeX throws on a mistake in the TeX). */
const checkMarkup = (text: string): void => {
  blocks(text);
  for (const m of text.matchAll(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g)) typeset(m[0].startsWith("$$") ? m[0].slice(2, -2) : m[0].slice(1, -1), m[0].startsWith("$$"));
};

const docs = Object.entries(ALL_DOCS);

describe("content files", () => {
  for (const [name, doc] of docs) {
    describe(name, () => {
      it("has a title, a description and at least one entry", () => {
        expect(doc.title.length).toBeGreaterThan(2);
        expect(doc.description.length).toBeGreaterThan(40);
        expect(doc.entries.size).toBeGreaterThan(0);
      });
      it("every entry has an id, a headline, a _Where:_ line and at least one field", () => {
        for (const e of doc.entries.values()) {
          expect(e.id, name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/);
          expect(e.headline.length, e.id).toBeGreaterThan(2);
          expect(e.where.length, e.id).toBeGreaterThan(10);
          expect(Object.keys(e.fields).length, e.id).toBeGreaterThan(0);
        }
      });
      it("every [@key] resolves, every plain link is https, every placeholder is a word", () => {
        for (const e of doc.entries.values()) {
          for (const [field, text] of Object.entries(e.fields)) {
            for (const key of citationKeys(text)) expect(CITATIONS, `${e.id}.${field} cites @${key}`).toHaveProperty(key);
            for (const m of text.matchAll(/\]\((\S+?)\)/g)) expect(m[1], `${e.id}.${field}`).toMatch(/^https:\/\//);
            expect(() => parseInline(text), `${e.id}.${field}`).not.toThrow();
            // head-* and row-* fields are pieces of a table that the code assembles
            if (!/^(head|row)-/.test(field)) expect(() => checkMarkup(text), `${e.id}.${field}`).not.toThrow();
            expect(withoutMath(text), `${e.id}.${field}`).not.toMatch(/\{[^}]*[^a-zA-Z0-9}][^}]*\}/);
          }
        }
      });
      it("never mentions internal sources", () => {
        const raw = JSON.stringify([...doc.entries.values()]).toLowerCase();
        expect(raw).not.toContain("book" + "6");
        expect(raw).not.toContain("inference systems at" + "las");
      });
    });
  }

  it("the files themselves are free of internal sources", () => {
    for (const f of readdirSync(path.join(srcDir, "content")).filter((x) => x.endsWith(".md"))) {
      const raw = readFileSync(path.join(srcDir, "content", f), "utf8").toLowerCase();
      expect(raw, f).not.toContain("book" + "6");
      expect(raw, f).not.toContain("inference systems at" + "las");
    }
  });
});

describe("code and content agree", () => {
  const source = liveSource();
  const refs = (pattern: RegExp): string[] => [...source.matchAll(pattern)].map((m) => m[1]!);

  it("every callout id used by code exists, and every callout entry is used", () => {
    const used = new Set(refs(/\bmake\(\s*"([^"]+)"/g));
    for (const id of used) expect(STEP_THROUGH.entries.has(id), `code uses ${id}`).toBe(true);
    for (const id of STEP_THROUGH.entries.keys()) expect(used.has(id), `step-through.md ${id} is not used by code`).toBe(true);
  });
  it("every inspector id used by code exists, and every inspector entry is used", () => {
    const used = new Set(refs(/<Note id="([^"]+)"/g));
    for (const id of used) expect(ALL_DOCS.inspector.entries.has(id), `code uses ${id}`).toBe(true);
    for (const id of ALL_DOCS.inspector.entries.keys()) expect(used.has(id), `inspector.md ${id} is not used by code`).toBe(true);
  });
  it("every panel id used by code exists, and every panel entry is used", () => {
    const used = new Set([...refs(/panelText\(\s*"([^"]+)"/g), ...refs(/panelFields\(\s*"([^"]+)"/g)]);
    for (const id of used) expect(ALL_DOCS.panels.entries.has(id), `code uses ${id}`).toBe(true);
    for (const id of ALL_DOCS.panels.entries.keys()) expect(used.has(id), `panels.md ${id} is not used by code`).toBe(true);
  });
  it("tutorial entries are the tour steps, in order", () => {
    expect(TOUR.map((t) => t.id)).toEqual([...ALL_DOCS.tutorial.entries.keys()]);
  });
  it("architecture entries are the serving architectures, in order", () => {
    expect([...ALL_DOCS.architectures.entries.keys()]).toEqual(ARCHITECTURES.map((a) => a.id));
  });
  it("every field of a callout entry is one the code can ask for", () => {
    // title/body/detail directly, or a named variant that callouts.ts mentions as a string
    for (const e of STEP_THROUGH.entries.values()) {
      for (const field of Object.keys(e.fields)) {
        if (["title", "body", "detail", "at", "dive"].includes(field)) continue;
        // a variant is named in code either whole or as the end of a computed name such as `detail-${policy}`
        const stem = field.replace(/-(prefix-aware|least-loaded|round-robin)(-chosen)?$/, "-");
        expect(source.includes(`"${field}"`) || (stem !== field && source.includes(`\`${stem}$`)), `${e.id}.${field}`).toBe(true);
      }
    }
  });
});

describe("templates", () => {
  it("fill replaces placeholders", () => {
    expect(fill("Routed to pod-{podId}, {n} left", { podId: 3, n: "2" })).toBe("Routed to pod-3, 2 left");
  });
  it("a missing placeholder throws", () => {
    expect(() => fill("Routed to pod-{podId}", {})).toThrow(/podId/);
  });
  it("an unused value throws", () => {
    const doc = parseDoc("# T\n\nA description of the test document.\n\n## `a.b` Head\n_Where:_ Nowhere in particular.\n\n### text\nHello {name}\n", "t.md");
    expect(fillEntry(doc, "a.b", { text: "text" }, { name: "x" }).text).toBe("Hello x");
    expect(() => fillEntry(doc, "a.b", { text: "text" }, { name: "x", extra: 1 })).toThrow(/extra/);
    expect(() => fillEntry(doc, "a.b", { text: "text" }, {})).toThrow(/name/);
  });
  it("a real entry throws when a value is missing or unused", () => {
    expect(() => stepText("req.new", {}, {})).toThrow(/sid/);
    expect(() => stepText("req.new", {}, { sid: 1, extra: 3 })).toThrow(/extra/);
    expect(stepText("req.new", {}, { sid: 1 }).body).toContain("Session 1 is one conversation");
  });
  it("a malformed file is rejected", () => {
    expect(() => parseDoc("no title", "x.md")).toThrow();
    expect(() => parseDoc("# T\n\nd\n\n## `a` H\n\n### text\nx\n", "x.md")).not.toThrow();
    expect(() => parseDoc("# T\n\nd\n\n## `a` H\n_Where:_ w\n\n### text\nx\n\n## `a` Again\n", "x.md")).toThrow(/duplicate/);
  });
  it("every placeholder in the files is a name the code can fill (letters and digits)", () => {
    for (const [, doc] of docs) for (const e of doc.entries.values()) for (const t of Object.values(e.fields)) placeholders(t);
  });
});

describe("inline markup", () => {
  it("citation shorthand uses the short name, the custom form its own text", () => {
    const [a] = parseInline("[@leviathan2023]");
    expect(a).toEqual({ type: "link", text: CITATIONS.leviathan2023.short, href: CITATIONS.leviathan2023.url });
    const [b] = parseInline("[Orca][@yu2022]");
    expect(b).toEqual({ type: "link", text: "Orca", href: CITATIONS.yu2022.url });
  });
  it("bold, code and plain links", () => {
    expect(parseInline("a **b** `c` [d](https://e.org)").map((n) => n.type)).toEqual(["text", "bold", "text", "code", "text", "link"]);
  });
  it("an unknown key or a non-https link throws", () => {
    expect(() => parseInline("[@nope]")).toThrow(/nope/);
    expect(() => parseInline("[x](http://e.org)")).toThrow(/https/);
  });
});

describe("callouts produced by real simulations", () => {
  const scenarios: [string, Parameters<typeof world>[0], number, number][] = [
    ["defaults", {}, 20, 40],
    ["tiers under pressure", { promptTokens: 10000, outputTokens: 60, maxPods: 1, gpuMemUtil: 0.5, dramGB: 4, ssdGB: 8, returnProb: 0.6, thinkTimeS: 5 }, 40, 120],
    ["preemption", { promptTokens: 4000, outputTokens: 1500, maxPods: 1, gpuMemUtil: 0.3, returnProb: 0 }, 12, 90],
    ["disaggregated and speculative", { disagg: true, specDecode: true, overlap: true, shedAfterS: 1, maxPods: 3 }, 60, 60],
    ["round robin, no prefix cache", { routing: "round-robin", prefixCaching: false, batching: "static", admission: "reserve" }, 20, 40],
    ["model does not fit", { model: "llama-3.1-70b", tp: 1, maxPods: 1 }, 2, 10],
    ["tiny tiers and a remote pool", { promptTokens: 10000, outputTokens: 60, maxPods: 1, gpuMemUtil: 0.5, dramGB: 1, ssdGB: 1, remoteGB: 1, returnProb: 0.8, thinkTimeS: 3 }, 40, 150],
    ["least loaded, churn", { routing: "least-loaded", arrivalRate: 2, returnProb: 0.8, thinkTimeS: 3, maxPods: 12 }, 50, 60]
  ];
  it("every event of every scenario fills its template and renders to parseable markdown", () => {
    const seen = new Set<string>();
    for (const [name, over, burst, seconds] of scenarios) {
      const w = world(over);
      spawnBurst(w, burst, 4);
      run(w, seconds);
      for (const e of w.events) {
        for (const c of calloutFor(e, w)) {
          seen.add(c.content);
          for (const text of [c.title, c.body, c.detail ?? ""]) {
            expect(withoutMath(text), `${name}: ${e.kind}`).not.toMatch(/[{}]/);
            expect(() => checkMarkup(text), `${name}: ${e.kind}`).not.toThrow();
            expect(() => parseInline(text)).not.toThrow();
          }
          expect(c.title.length, `${name}: ${e.kind}`).toBeGreaterThan(0);
          expect(c.body.length, `${name}: ${e.kind}`).toBeGreaterThan(0);
        }
      }
    }
    for (const id of ["req.new", "req.routed", "req.admitted.prefill", "req.firstToken", "req.done", "scale.up", "kv.move.dram", "kv.drop", "pod.failed", "step.tokens.stream"]) expect(seen, id).toContain(id);
  });
});

describe("the step-through script produced from real simulations", () => {
  const scenarios: [string, Parameters<typeof world>[0], number, number][] = [
    ["defaults", { returnProb: 1, thinkTimeS: 2, maxTurns: 3 }, 6, 60],
    ["no follow-up, caching on", { returnProb: 0 }, 2, 30],
    ["prefix caching off", { returnProb: 0, prefixCaching: false }, 2, 30],
    ["least loaded with a deadline", { routing: "least-loaded", shedAfterS: 1, maxPods: 1 }, 30, 30],
    ["round robin", { routing: "round-robin", minPods: 2 }, 8, 30],
    ["disaggregated", { disagg: true, returnProb: 1, maxTurns: 2, thinkTimeS: 1 }, 6, 50],
    ["preemption", { promptTokens: 4000, outputTokens: 1500, maxPods: 1, gpuMemUtil: 0.3, returnProb: 0 }, 12, 90],
    ["tiers under pressure", { promptTokens: 10000, outputTokens: 60, maxPods: 1, gpuMemUtil: 0.5, dramGB: 1, ssdGB: 1, remoteGB: 1, returnProb: 0.8, thinkTimeS: 3 }, 30, 100],
    ["model does not fit", { model: "llama-3.1-70b", tp: 1, maxPods: 1 }, 2, 10]
  ];
  it("every event of every scenario turns into steps whose texts are filled and parseable", () => {
    const ids = new Set<string>();
    for (const [name, over, burst, seconds] of scenarios) {
      const w = world(over);
      spawnBurst(w, burst, 2);
      const script = newScript();
      for (let i = 0; i < seconds / 0.5; i++) {
        run(w, 0.5);
        for (const e of w.events.splice(0)) {
          // follow every session: the script must cope with any order a real run produces
          const ev = e.kind === "step.tokens" ? { ...e, sid: (e.sids as number[])[0] } : e;
          for (const c of stepsFor(ev, w, script)) {
            ids.add(c.content);
            for (const text of [c.at ?? "", c.title, c.body, c.detail ?? ""]) {
              expect(withoutMath(text), `${name}: ${e.kind}`).not.toMatch(/[{}]/);
            expect(() => checkMarkup(text), `${name}: ${e.kind}`).not.toThrow();
              expect(() => parseInline(text)).not.toThrow();
            }
          }
        }
      }
    }
    for (const id of ["req.new", "req.followup", "store.read", "req.tokenized", "walk.cost", "walk.deadline", "req.queued", "scale.up", "pod.loading", "pod.ready", "req.routed", "walk.picked", "walk.arrive", "walk.slot", "req.admitted.prefill", "walk.kvmap", "walk.roofline", "req.admitted.hit", "req.firstToken", "step.tokens.stream", "req.done", "walk.reply", "store.append", "session.idle", "walk.evict.when", "walk.evict.force", "walk.end"]) expect(ids, id).toContain(id);
  });
  it("the forced eviction yields the move, the other cases, the return and the end, once", () => {
    const w = world({ returnProb: 0 });
    spawnBurst(w, 1);
    run(w, 30, () => w.m.completed === 1);
    w.events.length = 0;
    const script = newScript();
    script.forcing = true;
    expect(evictIdleNow(w, 1)).toBe(true);
    const steps = w.events.flatMap((e) => stepsFor(e, w, script)).map((c) => c.content);
    expect(steps).toEqual(["kv.move.dram", "walk.evict.cases", "walk.evict.return", "walk.end"]);
    expect(script.forcing).toBe(false);
  });
});

describe("the router step shows the real arithmetic", () => {
  it("tabulates every candidate with the three terms, says in words why the cached pod wins on a follow-up", () => {
    const w = world({ minPods: 3, maxPods: 3, returnProb: 1, thinkTimeS: 1, maxTurns: 2 });
    run(w, 4);
    w.events.length = 0;
    spawnBurst(w, 1);
    const script = newScript();
    const picked: string[] = [];
    for (let i = 0; i < 120 && picked.length < 2; i++) {
      run(w, 0.25);
      for (const e of w.events.splice(0)) {
        if (e.kind !== "req.routed") continue;
        const c = stepsFor(e, w, script).find((x) => x.content === "walk.picked")!;
        picked.push(`${c.body} ${c.detail}`);
      }
    }
    expect(picked).toHaveLength(2);
    // first turn: nobody holds anything, all three pods score the same, the first wins
    expect(picked[0]).toContain("| pod | cached share $c$ | free KV memory $m$ | free capacity $q$ | score |");
    expect(picked[0]).toMatch(/\| \*\*pod-\d+\*\* \| 0\.00 \| 1\.00 \| 1\.00 \| \*\*4\.00, chosen\*\* \|/);
    expect(picked[0]).toMatch(/\| pod-\d+ \| 0\.00 \| 1\.00 \| 1\.00 \| 4\.00 \|/);
    expect(picked[0]).toContain("$c$ is 0 for every pod because this is the first message of the conversation");
    expect(picked[0]).toContain("All pods are equally free, so the first one wins.");
    expect(picked[0]).toContain("It holds none of this prompt");
    // follow-up: the pod holding the history leads by nearly the full 3 points of the cache term
    expect(picked[1]).toMatch(/\| \*\*pod-\d+\*\* \| 0\.9\d \| .* \| \*\*6\.[89]\d, chosen\*\* \|/);
    expect(picked[1]).toMatch(/holds 9\d% of the prompt, which earns it 2\.[89]\d points/);
    expect(picked[1]).toContain("in its HBM, the GPU's own high-bandwidth memory");
  });
});

describe("dive deeper", () => {
  /** Entries that only the floating callouts of explain mode show; the step-through never does. */
  const explainOnly = new Set(["step.tokens.batch", "step.spec", "step.mixed", "churn", "scale.down", "fleet.restart"]);
  const wordsOf = (t: string) => t.replace(/\$[^$]*\$/g, "X").replace(/\[([^\]]*)\]\[@\w+\]|\[@\w+\]/g, "$1").split(/\s+/).filter(Boolean).length;

  it("every step the step-through shows lists 1 to 4 concepts, and no explain-only entry does", () => {
    for (const e of STEP_THROUGH.entries.values()) {
      const n = diveConcepts(e.id).length;
      if (explainOnly.has(e.id)) expect(n, e.id).toBe(0);
      else {
        expect(n, e.id).toBeGreaterThanOrEqual(1);
        expect(n, e.id).toBeLessThanOrEqual(4);
      }
    }
  });
  it("every concept is used by a step, and its _Where:_ line names exactly those steps", () => {
    const users = new Map<string, string[]>();
    for (const e of STEP_THROUGH.entries.values()) for (const c of diveConcepts(e.id)) users.set(c.id, [...(users.get(c.id) ?? []), e.id]);
    for (const e of DIVE_DEEPER.entries.values()) {
      const steps = users.get(e.id) ?? [];
      expect(steps.length, `${e.id} is not used by any step`).toBeGreaterThan(0);
      const named = [...e.where.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      expect(named, e.id).toEqual(steps);
    }
  });
  it("every concept has a title, a body of 80 to 180 words and at least one citation", () => {
    for (const e of DIVE_DEEPER.entries.values()) {
      expect(e.fields.title, e.id).toBeTruthy();
      const words = wordsOf(e.fields.body!);
      expect(words, `${e.id}: ${words} words`).toBeGreaterThanOrEqual(80);
      expect(words, `${e.id}: ${words} words`).toBeLessThanOrEqual(180);
      expect(citationKeys(e.fields.body!).length, `${e.id} cites nothing`).toBeGreaterThan(0);
      if (e.fields.formula) expect(e.fields.formula, e.id).toMatch(/^\$\$[\s\S]+\$\$$/);
      for (const f of Object.keys(e.fields)) expect(["title", "body", "formula"], `${e.id}.${f}`).toContain(f);
    }
  });
  it("a concept is written once: no two share a title", () => {
    const titles = [...DIVE_DEEPER.entries.values()].map((e) => e.fields.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
  it("every step produced by real simulations carries its concepts into the callout", () => {
    const w = world({ returnProb: 0 });
    spawnBurst(w, 1);
    const script = newScript();
    let shown = 0;
    for (let i = 0; i < 120; i++) {
      run(w, 0.5);
      for (const e of w.events.splice(0)) for (const c of stepsFor(e, w, script)) {
        if (explainOnly.has(c.content)) continue;
        expect(c.dive.length, c.content).toBeGreaterThan(0);
        shown++;
      }
    }
    expect(shown).toBeGreaterThan(10);
  });
});
