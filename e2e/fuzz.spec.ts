import { expect, test, type Page } from "@playwright/test";

/**
 * A seeded fuzz of the interface: requests in flight, then settings changed in random orders with
 * short waits, in explain mode on and off, during the step-through and the tour, paused and at
 * different speeds. After each sequence nothing may have thrown, the frame loop must run, and
 * requests must progress, be shed, or be explained by a visible message.
 */
interface W {
  t: number;
  params: Record<string, unknown>;
  pods: { id: number; state: string }[];
  reqs: Map<number, { stage: string }>;
  gatewayQueue: number[];
  m: { completed: number; failed: number; tokensOut: number };
}
interface Win {
  __live: { world: () => W; scene: { vt: number; selected: unknown; rectOf: (w: unknown, t: unknown) => { x: number; y: number; w: number; h: number } | null; toScreen: (p: { x: number; y: number }) => { x: number; y: number } } };
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEQUENCES = 5;
const STEPS = 9;

test.describe("fuzz: changing settings in every state", () => {
  test.setTimeout(120_000);
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("lv-tour-seen", "1"));
  });

  for (let seq = 0; seq < SEQUENCES; seq++) {
    test(`sequence ${seq}`, async ({ page }) => {
      const rand = rng(1000 + seq);
      const pickOf = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      const log: string[] = [];
      const soft = async (name: string, f: () => Promise<unknown>) => {
        log.push(name);
        await f().catch((e: Error) => {
          // an element that is not on screen in this state (a menu hidden by the tour) is not a defect
          if (!/Timeout|not visible|not attached|detached|intercepts|outside of the viewport/i.test(e.message)) throw e;
        });
      };
      const openAll = () => page.evaluate(() => document.querySelectorAll("details.lv-group").forEach((d) => ((d as HTMLDetailsElement).open = true)));
      const choose = (label: string, option: string) => page.locator(".lv-choice", { hasText: label }).getByRole("button", { name: option }).first().click({ timeout: 800 });
      const slider = (label: string, v: string) => page.locator("label.lv-slider", { hasText: label }).locator("input").fill(v, { timeout: 800 });
      const clickPod = () =>
        page.evaluate(() => {
          const l = (window as unknown as Win).__live;
          const pod = l.world().pods[0];
          if (!pod) return null;
          const r = l.scene.rectOf(l.world(), { type: "pod", id: pod.id });
          if (!r) return null;
          const p = l.scene.toScreen({ x: r.x + r.w / 2, y: r.y + 20 });
          return p;
        });

      await page.goto("/");
      const actions: [string, () => Promise<unknown>][] = [
        ["send", () => page.getByTestId(pickOf(["send-1", "send-10", "send-20", "send-100"])).click({ timeout: 800 })],
        ["model", () => choose("model", pickOf(["Llama 3.1 8B", "Llama 3.1 70B"]))],
        ["gpu", () => choose("GPU", pickOf(["H100", "H200", "B200", "MI300X"]))],
        ["precision", () => choose("precision", pickOf(["BF16", "FP8"]))],
        ["tp", () => choose("GPUs per pod", pickOf(["1", "2", "4", "8"]))],
        ["mem", () => slider("gpu_memory_utilization", pickOf(["0.3", "0.5", "0.9", "0.98"]))],
        ["disagg", () => choose("prefill / decode", pickOf(["one pool", "disaggregated"]))],
        ["routing", () => choose("routing policy", pickOf(["prefix-aware", "least-loaded", "round-robin"]))],
        ["arch", () => page.getByTestId("arch").selectOption({ index: Math.floor(rand() * 8) }, { timeout: 800 })],
        ["mode", async () => {
          const back = page.getByTestId("mode-explore");
          if (await back.isVisible()) return back.click({ timeout: 800 });
          await page.getByTestId("mode-calibrated").click({ timeout: 800 });
        }],
        ["explain", () => page.getByTestId("notes-toggle").click({ timeout: 800 })],
        ["step-through", () => page.getByTestId("step-toggle").click({ timeout: 800 })],
        ["step-next", () => page.getByTestId("step-next").click({ timeout: 800 })],
        ["step-back", () => page.getByTestId("step-back").click({ timeout: 800 })],
        ["tour", async () => {
          await page.getByTestId("more").click({ timeout: 800 });
          await page.getByTestId("tour-start").click({ timeout: 800 });
        }],
        ["tour-skip", () => page.getByTestId("tour-skip").click({ timeout: 800 })],
        ["pause", () => page.getByTestId("play-toggle").click({ timeout: 800 })],
        ["speed", () => page.getByTestId(pickOf(["speed-0.1", "speed-0.5", "speed-1"])).click({ timeout: 800 })],
        ["select-pod", async () => {
          const p = await clickPod();
          if (p) await page.mouse.click(p.x, p.y);
        }],
        ["hover-pod", async () => {
          const p = await clickPod();
          if (p) await page.mouse.move(p.x, p.y + 30);
        }],
        ["reset", () => page.getByTestId("reset").click({ timeout: 800 })]
      ];
      // always start with load in flight
      await page.getByTestId("send-20").click();
      await page.getByTestId("speed-1").click();
      await page.waitForTimeout(500 + rand() * 1500);
      for (let i = 0; i < STEPS; i++) {
        await soft("open menus", openAll);
        const [name, f] = pickOf(actions);
        await soft(name, f);
        await page.waitForTimeout(50 + rand() * 700);
      }
      expect(errors, log.join(" > ")).toEqual([]);

      // settle: back to Explore, no guided mode, running at full speed
      await page.evaluate(() => {
        const q = (sel: string) => document.querySelector<HTMLElement>(sel);
        const btn = (re: RegExp) => [...document.querySelectorAll<HTMLElement>("button")].find((b) => re.test(b.textContent ?? ""));
        if (q('[data-testid="tour-skip"]')) q('[data-testid="tour-skip"]')!.click();
        q('[data-testid="mode-explore"]')?.click();
      });
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const q = (sel: string) => document.querySelector<HTMLElement>(sel);
        if (q('[data-testid="tour-skip"]')) q('[data-testid="tour-skip"]')!.click();
        if (q('[data-testid="step-toggle"]')?.classList.contains("on")) q('[data-testid="step-toggle"]')!.click();
        if (q('[data-testid="play-toggle"]')?.getAttribute("aria-label") === "Play") q('[data-testid="play-toggle"]')!.click();
        q('[data-testid="speed-1"]')?.click();
      });
      await page.getByTestId("send-10").click({ timeout: 3000 });

      // the frame loop runs: the clock advances
      const t0 = await page.evaluate(() => (window as unknown as Win).__live.world().t);
      const v0 = await page.evaluate(() => (window as unknown as Win).__live.scene.vt);
      await page.waitForTimeout(1500);
      const t1 = await page.evaluate(() => (window as unknown as Win).__live.world().t);
      const v1 = await page.evaluate(() => (window as unknown as Win).__live.scene.vt);
      expect(v1, `animation clock stopped after: ${log.join(" > ")}`).toBeGreaterThan(v0);
      expect(t1, `simulation clock stopped after: ${log.join(" > ")}`).toBeGreaterThan(t0);

      // requests progress, or a visible message says why not
      const state = () =>
        page.evaluate(() => {
          const w = (window as unknown as Win).__live.world();
          return { inflight: w.reqs.size, tokens: w.m.tokensOut, done: w.m.completed, failed: w.m.failed, pods: w.pods.map((p) => p.state), queued: w.gatewayQueue.length };
        });
      // up to 20 s: while first explanations wait their turn the clock runs slowed, on purpose
      const a = await state();
      let b = a;
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(1000);
        b = await state();
        if (b.tokens > a.tokens || b.done > a.done || b.failed > a.failed || b.inflight === 0) break;
      }
      const fits = (await page.evaluate(() => document.querySelector('[data-testid="fit-banner"]')?.getAttribute("data-state") ?? null)) !== "blocked";
      if (b.inflight > 0 && fits) {
        const alive = b.pods.some((s) => s === "creating" || s === "loading" || s === "ready");
        expect(alive, `requests in flight, the configuration fits, and no pod is coming up: ${JSON.stringify(b)} after ${log.join(" > ")}`).toBe(true);
        const progressed = b.tokens > a.tokens || b.done > a.done || b.failed > a.failed || b.pods.some((s) => s === "loading" || s === "creating");
        expect(progressed, `no progress in 20 s: ${JSON.stringify({ a, b })} after ${log.join(" > ")}`).toBe(true);
      }
      if (!fits) {
        await expect(page.getByTestId("fit-banner")).toContainText("cannot serve");
        await expect(page.getByTestId("fit-banner").locator("button").first()).toBeVisible();
      }
      expect(errors, log.join(" > ")).toEqual([]);
    });
  }
});
