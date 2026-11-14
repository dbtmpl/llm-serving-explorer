import { expect, test, type Page } from "@playwright/test";

interface LiveHandle {
  world: () => {
    t: number;
    pods: { state: string; usedBlocks: number; dramBlocks: number; ssdBlocks: number }[];
    sessions: Map<number, unknown>;
    reqs: Map<number, unknown>;
    params: { maxNumSeqs: number };
    m: { completed: number; evictions: number; drops: number; tokensOut: number };
  };
}
const world = <T>(page: Page, fn: (w: ReturnType<LiveHandle["world"]>) => T) => page.evaluate(`(${fn.toString()})(window.__live.world())`) as Promise<T>;

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
    await expect(box).toContainText("A request starts as text");
    const t0 = await world(page, (w) => w.t);
    await page.waitForTimeout(400);
    expect(await world(page, (w) => w.t)).toBe(t0);
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      await expect(box).toBeVisible({ timeout: 20_000 });
      seen.push((await box.locator("b").innerText()).trim());
      if (seen.at(-1) === "Finished") break;
      await page.getByTestId("step-next").click();
      await page.waitForTimeout(150);
    }
    expect(seen.some((s) => s.startsWith("Routed to pod-"))).toBe(true);
    expect(seen).toContain("Prefill");
    expect(seen).toContain("Decode: one token per step");
    expect(seen.at(-1)).toBe("Finished");
    // Back re-reads earlier steps without moving the clock; Next returns to the latest
    await page.getByTestId("step-back").click();
    await page.getByTestId("step-back").click();
    await expect(box).toContainText("earlier step");
    await expect(box.locator("b")).toHaveText(seen.at(-3)!);
    await page.getByTestId("step-next").click();
    await page.getByTestId("step-next").click();
    await expect(box.locator("b")).toHaveText("Finished");
  });

  test("the trace button on the empty page starts a step-through of one request", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("trace-first").click();
    await expect(page.getByTestId("step-box")).toContainText("A request starts as text");
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
