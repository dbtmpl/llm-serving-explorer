import { expect, test, type Page } from "@playwright/test";

/** The restart paths a visitor can hit: each is checked for errors and for the frame loop still running. */
interface Win {
  __live: { world: () => { t: number; startedAt: number | null; pods: { id: number; state: string }[]; reqs: Map<number, unknown>; params: Record<string, unknown>; m: { completed: number } }; scene: { vt: number; selected: unknown; rectOf: (w: unknown, t: unknown) => { x: number; y: number; w: number; h: number } | null; toScreen: (p: { x: number; y: number }) => { x: number; y: number } } };
}
const guard = (page: Page) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return errors;
};
const openGroups = (page: Page) => page.evaluate(() => document.querySelectorAll("details.lv-group").forEach((d) => ((d as HTMLDetailsElement).open = true)));
const pick = (page: Page, label: string, option: string) => page.locator(".lv-choice", { hasText: label }).getByRole("button", { name: option }).first().click();
const vt = (page: Page) => page.evaluate(() => (window as unknown as Win).__live.scene.vt);
/** The animation still runs, or a step-through box holds it on purpose (a held step stops the clock until Next). */
const alive = async (page: Page) => {
  const a = await vt(page);
  await page.waitForTimeout(400);
  if (await page.getByTestId("step-box").isVisible()) return;
  expect(await vt(page)).toBeGreaterThan(a);
};
const podPoint = (page: Page) =>
  page.evaluate(() => {
    const l = (window as unknown as Win).__live;
    const pod = l.world().pods.find((p) => p.state === "ready" || p.state === "loading");
    const r = pod && l.scene.rectOf(l.world(), { type: "pod", id: pod.id });
    return r ? l.scene.toScreen({ x: r.x + r.w / 2, y: r.y + 24 }) : null;
  });

test.describe("restarting the fleet", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("lv-tour-seen", "1"));
  });

  test("a pod selected in the inspector is terminated by the restart", async ({ page }) => {
    const errors = guard(page);
    await page.goto("/");
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    await expect.poll(() => podPoint(page), { timeout: 15_000 }).not.toBeNull();
    const p = (await podPoint(page))!;
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__live.scene.selected)).not.toBeNull();
    await openGroups(page);
    await pick(page, "GPUs per pod", "2");
    await page.waitForTimeout(1500);
    await pick(page, "model", "Llama 3.1 70B");
    await page.waitForTimeout(1000);
    await alive(page);
    expect(errors).toEqual([]);
  });

  test("a restart while the hover tooltip is open", async ({ page }) => {
    const errors = guard(page);
    await page.goto("/");
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    await expect.poll(() => podPoint(page), { timeout: 15_000 }).not.toBeNull();
    await openGroups(page);
    // hover the weights block of the pod's GPU memory box until the tooltip shows, then restart through the menu with the pointer back on the canvas
    const p = (await podPoint(page))!;
    for (let dy = 20; dy < 140; dy += 6) {
      await page.mouse.move(p.x - 40, p.y + dy);
      if (await page.getByTestId("gpu-tip").isVisible()) break;
    }
    await pick(page, "precision", "FP8");
    await page.mouse.move(p.x - 40, p.y + 60);
    await page.waitForTimeout(800);
    await alive(page);
    expect(errors).toEqual([]);
  });

  test("a restart before the first request, and the clock still starts at the first request", async ({ page }) => {
    const errors = guard(page);
    await page.goto("/");
    await openGroups(page);
    await pick(page, "model", "Llama 3.1 70B");
    await pick(page, "GPUs per pod", "4");
    await expect(page.getByTestId("fit-banner")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Win).__live.world().startedAt)).toBeNull();
    await page.getByTestId("send-1").click();
    await page.getByTestId("speed-1").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__live.world().startedAt)).not.toBeNull();
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__live.world().pods.some((p) => p.state === "ready")), { timeout: 15_000 }).toBe(true);
    expect(errors).toEqual([]);
  });

  test("a restart during a step-through Back and Next", async ({ page }) => {
    const errors = guard(page);
    await page.goto("/");
    await page.getByTestId("trace-first").click();
    await page.getByTestId("speed-1").click();
    const next = page.getByTestId("step-next");
    for (let i = 0; i < 5; i++) {
      await expect(page.getByTestId("step-box")).toBeVisible({ timeout: 15_000 });
      await next.click();
    }
    await page.getByTestId("step-back").click();
    await page.getByTestId("step-back").click();
    await openGroups(page);
    await pick(page, "precision", "FP8");
    await page.waitForTimeout(300);
    await page.getByTestId("step-back").click({ timeout: 2000 }).catch(() => {});
    await next.click({ timeout: 2000 }).catch(() => {});
    await pick(page, "model", "Llama 3.1 70B");
    await page.waitForTimeout(1500);
    await next.click({ timeout: 2000 }).catch(() => {});
    await alive(page);
    expect(errors).toEqual([]);
  });

  test("switching to Calibrated and back restores a working Explore mode", async ({ page }) => {
    const errors = guard(page);
    await page.goto("/");
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    await openGroups(page);
    await pick(page, "model", "Llama 3.1 70B");
    await page.getByTestId("mode-calibrated").click();
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("fit-banner")).toHaveCount(0);
    await page.getByTestId("mode-explore").click();
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__live.world().pods.some((p) => p.state === "ready")), { timeout: 15_000 }).toBe(true);
    await alive(page);
    expect(errors).toEqual([]);
  });
});
