import { expect, test, type Page } from "@playwright/test";

interface LiveHandle {
  world: () => {
    t: number;
    startedAt: number | null;
    pods: { state: string; loadProgress: number; usedBlocks: number; dramBlocks: number; ssdBlocks: number }[];
    sessions: Map<number, unknown>;
    reqs: Map<number, unknown>;
    params: { maxNumSeqs: number };
    m: { completed: number; evictions: number; drops: number; tokensOut: number };
  };
}
/** [seconds since the first request, tokens out, completed, requests in flight]: what a step's world is compared by. */
const snapshotOf = (page: Page) => world(page, (w) => [w.t - (w.startedAt ?? w.t), w.m.tokensOut, w.m.completed, w.reqs.size]);
const world = <T>(page: Page, fn: (w: ReturnType<LiveHandle["world"]>) => T) => page.evaluate(`(${fn.toString()})(window.__live.world())`) as Promise<T>;

interface LiveWin {
  __live: {
    world: () => unknown;
    scene: {
      cam: { s: number };
      manual: boolean;
      guide: { target: { type: string }; free: { l: number; t: number; r: number; b: number } } | null;
      lit: { target: { type: string; part?: string }; rect: { x: number; y: number; w: number; h: number } } | null;
      toScreen: (p: { x: number; y: number }) => { x: number; y: number };
      rectOf: (w: unknown, t: unknown) => { x: number; y: number; w: number; h: number } | null;
    };
  };
}
/** The target the canvas currently outlines, or null. */
const lit = (page: Page) => page.evaluate(() => (window as unknown as LiveWin).__live.scene.lit?.target ?? null);
/** Whether the guided target's screen rectangle lies inside the free area of the current step. */
const guideFits = (page: Page) =>
  page.evaluate(() => {
    const l = (window as unknown as LiveWin).__live;
    const g = l.scene.guide;
    const r = g && l.scene.rectOf(l.world(), g.target);
    if (!g || !r) return false;
    const a = l.scene.toScreen({ x: r.x, y: r.y });
    const b = l.scene.toScreen({ x: r.x + r.w, y: r.y + r.h });
    const e = 2;
    return a.x >= g.free.l - e && a.y >= g.free.t - e && b.x <= g.free.r + e && b.y <= g.free.b + e;
  });

function guard(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test.describe("live graph view", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("lv-tour-seen", "1"));
  });

  test("opens on an empty graph and builds it up from one request", async ({ page }) => {
    const errors = guard(page);
    await page.goto("/");
    await expect(page.getByTestId("live-canvas")).toBeVisible();
    await expect(page.getByTestId("send-first")).toBeVisible();
    expect(await world(page, (w) => w.pods.length + w.sessions.size)).toBe(0);

    await page.getByTestId("send-first").click();
    await page.getByTestId("speed-1").click();
    await expect(page.getByTestId("callout").first()).toBeVisible();
    await expect.poll(() => world(page, (w) => w.pods.filter((p) => p.state === "ready").length)).toBe(1);
    await expect.poll(() => world(page, (w) => w.m.tokensOut)).toBeGreaterThan(5);
    await expect.poll(() => world(page, (w) => w.m.completed), { timeout: 20_000 }).toBe(1);
    expect(errors).toEqual([]);
  });

  test("pause stops the clock; 100 requests at once scale out to 9 pods", async ({ page }) => {
    const errors = guard(page);
    await page.goto("/");
    await page.getByTestId("send-100").click();
    await page.getByTestId("speed-1").click();
    await expect.poll(() => world(page, (w) => w.pods.length)).toBe(9);
    await expect(page.getByTestId("hud")).toContainText("9 GPUs");
    await page.getByTestId("play-toggle").click();
    const t0 = await world(page, (w) => w.t);
    await page.waitForTimeout(300);
    expect(await world(page, (w) => w.t)).toBe(t0);
    expect(errors).toEqual([]);
  });

  test("parameters change while requests run, and clicking a pod opens the dive-in panel", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("send-20").click();
    await page.getByTestId("speed-1").click();
    await expect.poll(() => world(page, (w) => w.pods.filter((p) => p.state === "ready").length)).toBe(2);
    await page.getByText("Engine", { exact: true }).click();
    await page.getByTestId("max-num-seqs").fill("4");
    expect(await world(page, (w) => w.params.maxNumSeqs)).toBe(4);
    await expect.poll(() => world(page, (w) => w.pods.length)).toBeGreaterThan(2);

    await page.getByTestId("toggle-panels").click();
    await page.getByTestId("play-toggle").click();
    await page.waitForTimeout(2500);
    // pods can be replaced while the slot limit changes: wait until one is on the graph before aiming at it
    await expect.poll(() => world(page, (w) => w.pods.length)).toBeGreaterThan(0);
    const anchor = await page.evaluate(() => {
      const l = (window as unknown as { __live: { world: () => { pods: { id: number }[] }; scene: { anchor: (w: unknown, t: unknown) => { x: number; y: number }; toScreen: (p: unknown) => { x: number; y: number } } } }).__live;
      const w = l.world();
      return l.scene.toScreen(l.scene.anchor(w, { type: "pod", id: w.pods[0]!.id, part: "gpu" }));
    });
    await page.mouse.click(anchor.x, anchor.y + 40);
    await page.getByTestId("toggle-panels").click();
    await expect(page.getByTestId("inspector")).toContainText("pod-");
    await expect(page.getByTestId("inspector")).toContainText("Memory tiers and eviction");
  });

  test("eviction scenario moves idle sessions' KV from HBM to DRAM to SSD", async ({ page }) => {
    test.setTimeout(90_000);
    const errors = guard(page);
    await page.goto("/");
    await page.getByText("Scenarios", { exact: true }).click();
    await page.getByTestId("preset-evict").click();
    await page.getByTestId("speed-1").click();
    await expect.poll(() => world(page, (w) => w.m.evictions), { timeout: 60_000 }).toBeGreaterThan(3);
    await expect.poll(() => world(page, (w) => w.pods[0]?.ssdBlocks ?? 0), { timeout: 60_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId("callout").filter({ hasText: /Evicted|Pushed down|Cache dropped|Reloaded/ }).first()).toBeVisible({ timeout: 20_000 });
    expect(errors).toEqual([]);
  });

  test("step-through follows one session and stops the clock until Next is pressed", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("step-toggle").click();
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    const box = page.getByTestId("step-box");
    await expect(box).toContainText("A user sends a message");
    const t0 = await world(page, (w) => w.t);
    await page.waitForTimeout(400);
    expect(await world(page, (w) => w.t)).toBe(t0);
    const seen: string[] = [];
    const steps: number[][] = [];
    for (let i = 0; i < 24; i++) {
      await expect(box).toBeVisible({ timeout: 20_000 });
      seen.push((await box.locator("b").innerText()).trim());
      steps.push(await snapshotOf(page));
      if (seen.at(-1) === "The user has the whole reply") break;
      await page.getByTestId("step-next").click();
      await page.waitForTimeout(150);
    }
    expect(seen.some((s) => s.startsWith("Routed to pod-"))).toBe(true);
    expect(seen).toContain("Prefill: the prompt is read");
    expect(seen).toContain("Decode: one token per step");
    expect(seen.at(-1)).toBe("The user has the whole reply");
    // every step says where in the system it happens
    await expect(page.getByTestId("step-at")).toBeVisible();
    // Back rewinds the graph: the clock and the world are those of the earlier step (after the
    // animation that leads up to it has played again). Next returns.
    const at = (i: number) => steps[i]!;
    await page.getByTestId("step-back").click();
    await page.getByTestId("step-back").click();
    await expect(box.locator("b")).toHaveText(seen.at(-3)!);
    await expect(page.getByTestId("step-where")).toContainText(`Step ${seen.length - 2} of ${seen.length}`);
    await expect.poll(() => snapshotOf(page), { timeout: 10_000 }).toEqual(at(seen.length - 3));
    await expect(page.getByTestId("step-where")).toContainText(`${at(seen.length - 3)[0]!.toFixed(2)} s`);
    // the clock stays stopped while a rewound step is showing
    await page.waitForTimeout(300);
    expect(await snapshotOf(page)).toEqual(at(seen.length - 3));
    await page.getByTestId("step-next").click();
    await expect.poll(() => snapshotOf(page), { timeout: 10_000 }).toEqual(at(seen.length - 2));
    await page.getByTestId("step-next").click();
    await expect(box.locator("b")).toHaveText("The user has the whole reply");
    await expect.poll(() => snapshotOf(page), { timeout: 10_000 }).toEqual(at(seen.length - 1));
  });

  test("Next to a step already seen plays the animation that leads to it again: the weights fill anew", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("step-toggle").click();
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    const box = page.getByTestId("step-box");
    // Next until the walkthrough reaches the pod's weights
    for (let i = 0; i < 12 && (await box.locator("b").innerText()) !== "Weights load into GPU memory"; i++) {
      await page.getByTestId("step-next").click();
      await page.waitForTimeout(200);
    }
    await expect(box.locator("b")).toHaveText("Weights load into GPU memory", { timeout: 20_000 });
    const loading = await world(page, (w) => (w.pods[0]?.loadProgress ?? 0));
    expect(loading).toBeLessThan(0.5);
    await page.getByTestId("step-next").click();
    await expect(box.locator("b")).toHaveText("GPU memory is split in four; the KV pool is what remains", { timeout: 20_000 });
    expect(await world(page, (w) => (w.pods[0]?.loadProgress ?? 0))).toBe(1);
    await page.getByTestId("step-back").click();
    await expect(box.locator("b")).toHaveText("Weights load into GPU memory");
    // Back plays the lead-up to the loading step, which starts with no pod bar filled
    await expect.poll(() => world(page, (w) => (w.pods[0]?.loadProgress ?? 0)), { timeout: 10_000 }).toBeLessThan(0.5);
    await page.getByTestId("step-next").click();
    await expect(box.locator("b")).toHaveText("GPU memory is split in four; the KV pool is what remains");
    // right after Next the bar is being filled again; it ends full
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      samples.push(await world(page, (w) => (w.pods[0]?.state === "ready" ? 1 : (w.pods[0]?.loadProgress ?? 0))));
      await page.waitForTimeout(100);
    }
    expect(samples.some((v) => v > 0.02 && v < 0.98), `samples ${samples.join(",")}`).toBe(true);
    expect(samples.at(-1)).toBe(1);
  });

  /** Follow one request to the end of the walkthrough, returning every step title. */
  async function walkToEnd(page: Page, opts: { until?: RegExp } = {}): Promise<string[]> {
    const box = page.getByTestId("step-box");
    const titles: string[] = [];
    for (let i = 0; i < 80; i++) {
      await expect(box).toBeVisible({ timeout: 30_000 });
      const title = (await box.locator("b").innerText()).trim();
      titles.push(title);
      if (/^End of this session/.test(title) || (opts.until && opts.until.test(title))) break;
      await page.getByTestId("step-next").click();
      await page.waitForTimeout(60);
    }
    return titles;
  }

  const startTrace = async (page: Page, params: Record<string, number | boolean | string>) => {
    await page.goto("/");
    await page.evaluate((p) => Object.assign((window as unknown as { __live: { world: () => { params: object } } }).__live.world().params, p), params);
    await page.getByTestId("trace-first").click();
    await page.getByTestId("speed-1").click();
  };

  test("a single traced request with no follow-up goes reply received, idle, eviction walkthrough, end; there is no Finished after idle", async ({ page }) => {
    test.setTimeout(90_000);
    await startTrace(page, { returnProb: 0 });
    const titles = await walkToEnd(page);
    const at = (re: RegExp) => titles.findIndex((t) => re.test(t));
    const order = [/^A user sends a message/, /tokens: the prompt is counted$/, /^Routed to pod-/, /^The request takes a batch slot/, /^Prefill/, /^Decode/, /^The last token is generated/, /^The user has the whole reply/, /^The turn is saved/, /^The user does not reply: session \d+ goes idle/, /^Idle KV stays/, /^Forcing an eviction/, /^Evicted: HBM/, /^Where evicted KV goes/, /^If the user comes back/, /^End of this session/];
    const idx = order.map(at);
    expect(idx.every((i) => i >= 0), titles.join(" | ")).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(titles.some((t) => /^Finished/.test(t))).toBe(false);
    expect(titles.at(-1)).toMatch(/^End of this session/);
    expect(titles.filter((t) => /^End of this session/.test(t))).toHaveLength(1);
    await expect(page.getByTestId("step-next")).toHaveText(/Follow another session/);
  });

  test("the reply is announced only once its output tokens have visibly arrived", async ({ page }) => {
    test.setTimeout(60_000);
    await startTrace(page, { returnProb: 0 });
    const box = page.getByTestId("step-box");
    const done = await walkToEnd(page, { until: /^The last token is generated/ });
    expect(done.at(-1)).toMatch(/^The last token/);
    // the last tokens are still on their way when the engine has finished
    expect(await page.evaluate(() => (window as unknown as { __live: { scene: { repliesInFlight: (s: number) => boolean } } }).__live.scene.repliesInFlight(1))).toBe(true);
    await page.getByTestId("step-next").click();
    await expect(box.locator("b")).toHaveText("The user has the whole reply");
    expect(await page.evaluate(() => (window as unknown as { __live: { scene: { repliesInFlight: (s: number) => boolean } } }).__live.scene.repliesInFlight(1))).toBe(false);
  });

  test("a follow-up turn starts with a headline of its own, not the first turn's", async ({ page }) => {
    test.setTimeout(90_000);
    await startTrace(page, { returnProb: 1, thinkTimeS: 1, maxTurns: 2 });
    const titles = await walkToEnd(page);
    expect(titles[0]).toBe("A user sends a message");
    const follow = titles.find((t) => /^Same user, same conversation/.test(t));
    expect(follow).toBeDefined();
    expect(follow).not.toBe(titles[0]);
    const i = titles.indexOf(follow!);
    // the history is explained and the second turn takes the short path: a cache hit, no second tour of the pod
    expect(titles[i + 1]).toMatch(/^Why all of the history/);
    expect(titles.slice(i)).toContain("Prefix cache hit");
    expect(titles.slice(i).some((t) => /^The request takes a batch slot/.test(t))).toBe(false);
  });

  test("the forced eviction moves the followed session's KV out of HBM", async ({ page }) => {
    test.setTimeout(90_000);
    await startTrace(page, { returnProb: 0 });
    const box = page.getByTestId("step-box");
    await walkToEnd(page, { until: /^Forcing an eviction/ });
    const tier = () => world(page, (w) => (w.pods[0] as unknown as { entries: Map<number, { tier: string }> }).entries.get(1)?.tier ?? "none");
    expect(await tier()).toBe("hbm");
    const before = await world(page, (w) => w.m.evictions);
    await page.getByTestId("step-next").click();
    await expect(box.locator("b")).toHaveText(/^Evicted: HBM/);
    expect(await tier()).toBe("dram");
    expect(await world(page, (w) => w.m.evictions)).toBe(before + 1);
    expect(await world(page, (w) => w.pods[0]!.usedBlocks)).toBe(0);
    expect(await world(page, (w) => w.pods[0]!.dramBlocks)).toBeGreaterThan(0);
  });

  test("a held step highlights what it is about and frames it clear of the box", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("step-toggle").click();
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    const box = page.getByTestId("step-box");
    await expect(box).toContainText("A user sends a message");
    await expect.poll(() => lit(page)).toMatchObject({ type: "session" });
    // walk to a pod step: the highlight names the pod and the camera frames it left of the box
    for (let i = 0; i < 12 && !(await lit(page))?.part; i++) {
      await page.getByTestId("step-next").click();
      await expect(box).toBeVisible({ timeout: 20_000 });
    }
    const target = await lit(page);
    expect(target?.type).toBe("pod");
    await expect.poll(() => guideFits(page), { timeout: 10_000 }).toBe(true);
    const clear = await page.evaluate(() => {
      const l = (window as unknown as LiveWin).__live;
      const r = l.scene.lit!.rect;
      const a = l.scene.toScreen({ x: r.x, y: r.y });
      const b = l.scene.toScreen({ x: r.x + r.w, y: r.y + r.h });
      const bx = document.querySelector('[data-testid="step-box"]')!.getBoundingClientRect();
      return b.y <= bx.top + 1 || a.y >= bx.bottom - 1 || b.x <= bx.left + 1 || a.x >= bx.right - 1;
    });
    expect(clear).toBe(true);
  });

  test("moving the camera by hand stops the framing until the next step", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("step-toggle").click();
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    await expect(page.getByTestId("step-box")).toContainText("A user sends a message");
    await expect.poll(() => guideFits(page), { timeout: 10_000 }).toBe(true);
    await page.mouse.move(700, 400);
    await page.mouse.wheel(0, 600);
    const s1 = await page.evaluate(() => (window as unknown as LiveWin).__live.scene.cam.s);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as unknown as LiveWin).__live.scene.cam.s)).toBeCloseTo(s1, 6);
    await page.getByTestId("step-next").click();
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as LiveWin).__live.scene.manual)) === false).toBe(true);
  });

  test("the trace button on the empty page starts a step-through of one request", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("trace-first").click();
    await expect(page.getByTestId("step-box")).toContainText("A user sends a message");
    expect(await world(page, (w) => w.sessions.size)).toBe(1);
  });

  test("switching the serving architecture changes the running system", async ({ page }) => {
    const errors = guard(page);
    await page.goto("/");
    await page.getByTestId("send-20").click();
    await page.getByTestId("speed-1").click();
    await page.getByTestId("arch").selectOption("static");
    await expect(page.getByText("The baseline.")).toBeVisible();
    expect(await world(page, (w) => (w.params as unknown as { batching: string }).batching)).toBe("static");
    await page.getByTestId("arch").selectOption("disagg");
    await expect.poll(() => world(page, (w) => new Set((w.pods as unknown as { role: string }[]).map((p) => p.role)).size), { timeout: 20_000 }).toBe(2);
    await expect.poll(() => world(page, (w) => w.m.completed), { timeout: 40_000 }).toBeGreaterThan(5);
    await page.getByTestId("arch").selectOption("full");
    await expect.poll(() => world(page, (w) => w.m.completed), { timeout: 40_000 }).toBe(20);
    expect(errors).toEqual([]);
  });

  test("sources named in the architecture panel are links that open in a new tab", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("arch").selectOption("orca");
    const link = page.getByRole("link", { name: "Orca (Yu et al., OSDI 2022)" });
    await expect(link).toHaveAttribute("href", /usenix\.org/);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  });

  test("1,000 and 10,000 sessions at once render and keep the page responsive", async ({ page }) => {
    const errors = guard(page);
    await page.goto("/");
    await page.getByTestId("send-10000").click();
    await page.getByTestId("speed-1").click();
    await expect.poll(() => world(page, (w) => w.sessions.size), { timeout: 20_000 }).toBe(10000);
    await expect.poll(() => world(page, (w) => w.m.completed), { timeout: 30_000 }).toBeGreaterThan(50);
    const fps = await page.evaluate(
      () =>
        new Promise<number>((res) => {
          let n = 0;
          const t0 = performance.now();
          const f = () => (++n, performance.now() - t0 < 1000 ? requestAnimationFrame(f) : res(n));
          requestAnimationFrame(f);
        })
    );
    expect(fps).toBeGreaterThan(15);
    expect(errors).toEqual([]);
  });
});

test("first visit starts the tutorial, which can be stepped and dismissed", async ({ page }) => {
  await page.goto("/");
  const tour = page.getByTestId("tour");
  await expect(tour).toContainText("One live graph");
  await expect(tour.locator("svg")).toBeVisible();
  for (let i = 0; i < 4; i++) await page.getByTestId("tour-next").click();
  await expect(tour).toContainText("Router");
  await page.getByTestId("tour-skip").click();
  await expect(tour).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("live-canvas")).toBeVisible();
  await expect(page.getByTestId("tour")).toHaveCount(0);
  await page.getByTestId("tour-start").click();
  await expect(page.getByTestId("tour")).toBeVisible();
});

test("each tutorial step moves the camera so its target lies in the free area beside the card", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const card = page.getByTestId("tour");
  await expect(card).toBeVisible();
  await page.getByTestId("speed-1").click();
  await expect.poll(() => world(page, (w) => w.pods.filter((p) => p.state === "ready").length), { timeout: 40_000 }).toBeGreaterThan(0);
  let framed = 0;
  for (let i = 0; i < 11; i++) {
    if (i > 0) await page.getByTestId("tour-next").click();
    if (i === 0) continue; // the welcome step has no target and uses the normal fit
    await expect.poll(() => guideFits(page), { timeout: 10_000, message: `step ${i} target lies inside the free area` }).toBe(true);
    const apart = await page.evaluate(() => {
      const l = (window as unknown as LiveWin).__live;
      const r = l.scene.rectOf(l.world(), l.scene.guide!.target)!;
      const a = l.scene.toScreen({ x: r.x, y: r.y });
      const b = l.scene.toScreen({ x: r.x + r.w, y: r.y + r.h });
      const c = document.querySelector('[data-testid="tour"]')!.getBoundingClientRect();
      return a.x >= c.right - 1 || b.x <= c.left + 1 || a.y >= c.bottom - 1 || b.y <= c.top + 1;
    });
    expect(apart, `step ${i} target is not under the card`).toBe(true);
    framed++;
  }
  expect(framed).toBe(10);
  // the menus step points at the menu instead and shows it; the camera is not framing anything
  await page.getByTestId("tour-next").click();
  await expect(page.locator(".lv-right")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as LiveWin).__live.scene.guide)).toBeNull();
});
