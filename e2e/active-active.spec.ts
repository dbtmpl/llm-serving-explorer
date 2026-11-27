import { expect, test, type Page } from "@playwright/test";

interface LiveWin {
  __live: {
    world: () => {
      t: number;
      params: {
        routing: string;
        routerReplicas: number;
        syncIntervalS: number;
        sharedPrefixTokens: number;
      };
      pods: { id: number; state: string }[];
      lastRoute: { routerReplica?: number; peerStateAgeS?: number } | null;
      m: { completed: number; cachedTokens: number };
    };
    scene: {
      anchor: (w: unknown, t: unknown) => { x: number; y: number } | null;
      rectOf: (w: unknown, t: unknown) => { x: number; y: number; w: number; h: number } | null;
      toScreen: (p: { x: number; y: number }) => { x: number; y: number };
    };
  };
}

function guard(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test.describe("active-active stale-state routing", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("lv-tour-seen", "1"));
  });

  test("boots from ?arch=active-active, renders R0..R3 and sync readout, opens router inspector, and switches mitigations", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = guard(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?arch=active-active");

    await expect(page.getByTestId("arch")).toHaveValue("active-active");
    expect(await page.evaluate(() => (window as unknown as LiveWin).__live.world().params)).toMatchObject({
      routerReplicas: 4,
      syncIntervalS: 0.2,
      sharedPrefixTokens: 1536,
      routing: "prefix-aware"
    });

    await page.getByTestId("speed-1").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as LiveWin).__live.world().pods.filter((p) => p.state === "ready").length), { timeout: 20_000 }).toBe(4);

    // Send 20 sessions and verify multi-replica routing + sync window activity
    await page.getByTestId("send-20").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as LiveWin).__live.world().lastRoute?.routerReplica !== undefined), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as LiveWin).__live.world().m.completed), { timeout: 30_000 }).toBeGreaterThan(2);

    // Click the Router (gateway) node on the canvas to open the Router Inspector
    const gwScreen = await page.evaluate(() => {
      const l = (window as unknown as LiveWin).__live;
      const r = l.scene.rectOf(l.world(), { type: "gateway" });
      return r ? l.scene.toScreen({ x: r.x + r.w / 2, y: r.y + r.h / 2 }) : null;
    });
    expect(gwScreen).not.toBeNull();
    await page.mouse.click(gwScreen!.x, gwScreen!.y);

    const inspector = page.getByTestId("inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText("Router");
    await expect(inspector).toContainText("4× active-active");
    await expect(inspector).toContainText("200 ms");
    await expect(inspector).toContainText("obs (o+p)");

    // Switch policies and sync lag live in the Infrastructure menu
    await page.getByText("Routing and autoscaling", { exact: true }).click();
    await page.locator(".lv-choice", { hasText: "routing policy" }).getByRole("button", { name: "bounded-load affinity" }).click();
    expect(await page.evaluate(() => (window as unknown as LiveWin).__live.world().params.routing)).toBe("bounded-load-affinity");
    await expect(inspector).toContainText("bounded-load cap");

    await page.locator(".lv-choice", { hasText: "routing policy" }).getByRole("button", { name: "age-discounted" }).click();
    expect(await page.evaluate(() => (window as unknown as LiveWin).__live.world().params.routing)).toBe("age-discounted");

    await page.locator(".lv-choice", { hasText: "peer sync lag" }).getByRole("button", { name: "20 ms" }).click();
    expect(await page.evaluate(() => (window as unknown as LiveWin).__live.world().params.syncIntervalS)).toBe(0.02);

    expect(errors).toEqual([]);
  });
});
