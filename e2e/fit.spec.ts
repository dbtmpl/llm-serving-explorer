import { expect, test, type Page } from "@playwright/test";

const world = <T>(page: Page, fn: (w: any) => T) => page.evaluate(`(${fn.toString()})(window.__live.world())`) as Promise<T>;
const openGroup = (page: Page, title: string) => page.locator("details.lv-group", { has: page.locator("summary", { hasText: title }) }).evaluate((d) => ((d as HTMLDetailsElement).open = true));
const pick = (page: Page, label: string, option: string) => page.locator(".lv-choice", { hasText: label }).getByRole("button", { name: option }).first().click();

test.describe("a configuration that does not fit", () => {
  test.setTimeout(90_000);
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("lv-tour-seen", "1"));
  });

  test("shows a lasting box with the numbers and buttons that fix it, and recovers", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto("/");
    await expect(page.getByTestId("fit-banner")).toHaveCount(0);
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    await openGroup(page, "Model and GPU");
    // the menu warns before the choice is made
    await expect(page.locator(".lv-choice", { hasText: "model" }).getByRole("button", { name: /70B/ })).toHaveAttribute("data-fit", "no");
    await pick(page, "model", "Llama 3.1 70B");
    const banner = page.getByTestId("fit-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("cannot serve requests");
    await expect(banner).toContainText("GB");
    await page.screenshot({ path: "test-results/shots/fit-desktop.png" });
    // it stays: not a toast
    await page.waitForTimeout(11_000);
    await expect(banner).toBeVisible();
    expect(await world(page, (w) => w.pods.some((p: any) => p.state === "failed"))).toBe(true);
    expect(await world(page, (w) => w.gatewayQueue.length)).toBeGreaterThan(0);
    await expect(page.getByTestId("fit-fix-tp")).toBeVisible();
    await expect(page.getByTestId("fit-fix-precision")).toBeVisible();
    await page.getByTestId("fit-fix-tp").click();
    await expect(banner).toHaveCount(0);
    await expect.poll(() => world(page, (w) => w.pods.some((p: any) => p.state === "ready")), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => world(page, (w) => w.m.completed), { timeout: 30_000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("the restart note says what happens next, and says so when nothing fits", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    await expect.poll(() => world(page, (w) => w.reqs.size)).toBeGreaterThan(3);
    await openGroup(page, "Model and GPU");
    await pick(page, "precision", "FP8");
    await expect(page.getByTestId("callout").filter({ hasText: "Fleet restarted" })).toContainText(/go back to the queue|goes back to the queue|keep waiting/);
    await pick(page, "model", "Llama 3.1 70B");
    await pick(page, "precision", "BF16");
    await expect(page.getByTestId("callout").filter({ hasText: "Fleet restarted" })).toContainText("none can start");
  });

  test("a very small pool is announced with its size", async ({ page }) => {
    await page.goto("/");
    await openGroup(page, "Model and GPU");
    await pick(page, "model", "Llama 3.1 70B");
    await pick(page, "precision", "FP8");
    const banner = page.getByTestId("fit-banner");
    await expect(banner).toContainText("KV pool is very small");
    await expect(banner).toContainText("10,600 tokens");
  });

  test("at phone width the box and its buttons are reachable", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/");
    await page.getByTestId("send-1").click().catch(() => {});
    await page.evaluate(() => (window as any).__live.world().params && 0);
    await page.evaluate(() => {
      // the right menu is hidden on a phone, so change the model through the world as the menu would
      const l = (window as any).__live;
      l.world().params.model = "llama-3.1-70b";
    });
    await expect(page.getByTestId("fit-banner")).toBeVisible();
    await page.screenshot({ path: "test-results/shots/fit-phone.png" });
    const box = await page.getByTestId("fit-banner").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.getByTestId("fit-fix-model").click();
    await expect(page.getByTestId("fit-banner")).toHaveCount(0);
  });
});
