import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/** The commit the replay files were generated from, as conformance/refs/blis/lock pins it. */
const COMMIT = readFileSync("conformance/refs/blis/lock", "utf8")
  .split("\n")
  .map((l) => l.trim())
  .find((l) => l && !l.startsWith("#"))!;

interface Handle {
  run: () => { kind: string; detail: string; world: { t: number; reqs: Map<number, unknown>; m: { completed: number; failed: number; tokensOut: number }; gatewayQueue: number[] } };
  world: () => { pods: unknown[]; m: { tokensOut: number } };
  scene: { anchor: (w: unknown, t: unknown) => { x: number; y: number }; toScreen: (p: unknown) => { x: number; y: number } };
}
const run = <T>(page: Page, fn: (r: ReturnType<Handle["run"]>) => T) => page.evaluate(`(${fn.toString()})(window.__live.run())`) as Promise<T>;

function guard(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Click a node of the graph: the canvas has no DOM, so aim with the scene's own geometry. */
async function clickNode(page: Page, target: { type: string; id?: number; part?: string }, dy: number) {
  const at = await page.evaluate(
    ([t, d]) => {
      const l = (window as unknown as { __live: Handle }).__live;
      const a = l.scene.anchor(l.run().world, t);
      return l.scene.toScreen({ x: a.x, y: a.y + (d as number) });
    },
    [target, dy] as const
  );
  await page.mouse.click(at.x, at.y);
}

test.describe("calibrated mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("lv-tour-seen", "1"));
  });

  test("replays a BLIS scenario, names its commit, and leaves Explore intact", async ({ page }) => {
    const errors = guard(page);
    await page.goto("/");
    await expect(page.getByTestId("blis-badge")).toHaveCount(0);

    await page.getByTestId("more").click();
    await page.getByTestId("mode-calibrated").click();
    const badge = page.getByTestId("blis-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("BLIS replay");
    await expect(page.getByTestId("blis-commit")).toHaveText(COMMIT.slice(0, 7));
    await expect(page.getByTestId("blis-commit")).toHaveAttribute("href", `https://github.com/inference-sim/inference-sim/commit/${COMMIT}`);
    expect(await run(page, (r) => [r.kind, r.detail])).toEqual(["calibrated", "aggregate"]);

    // the settings are the scenario's and cannot be edited
    await expect(page.getByTestId("param-max-num-seqs")).toContainText("12");
    await expect(page.getByTestId("param-replicas")).toContainText("4");
    expect(await page.locator(".lv-right input").count()).toBe(0);

    // requests flow: they appear, are routed and finish
    await page.getByTestId("speed-10").click();
    await expect.poll(() => run(page, (r) => r.world.reqs.size), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => run(page, (r) => r.world.m.completed), { timeout: 20_000 }).toBeGreaterThan(3);
    await expect(page.getByTestId("hud")).toContainText("4 GPUs");

    // the inspector for the router shows BLIS's per-endpoint scores
    await clickNode(page, { type: "gateway" }, 60);
    await expect(page.getByTestId("inspector")).toContainText("Router");
    await expect(page.getByTestId("decision-table")).toBeVisible();
    await expect(page.getByTestId("decision-table")).toContainText("chosen");
    await expect(page.getByTestId("decision-table")).toContainText("prefix");

    // another scenario restarts the clock and shows its own settings
    await page.getByTestId("scenario").selectOption("overload-shedding");
    await expect(page.getByTestId("param-max-num-seqs")).toContainText("4");
    await expect(page.getByTestId("param-deadline")).toContainText("4 s");
    expect(await run(page, (r) => r.world.t)).toBeLessThan(3);
    await expect(page.getByTestId("scenario-text")).toContainText("shed");
    await expect.poll(() => run(page, (r) => r.world.m.failed), { timeout: 30_000 }).toBeGreaterThan(0);

    // pause stops the clock
    await page.getByTestId("play-toggle").click();
    const t0 = await run(page, (r) => r.world.t);
    await page.waitForTimeout(300);
    expect(await run(page, (r) => r.world.t)).toBe(t0);

    // back to Explore: the live model works as before
    await page.getByTestId("mode-explore").click();
    await expect(badge).toHaveCount(0);
    await expect(page.getByTestId("arch")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __live: Handle }).__live.run().kind)).toBe("explore");
    await expect(page.getByTestId("send-first")).toBeVisible();
    await page.getByTestId("send-10").click();
    await page.getByTestId("speed-1").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __live: Handle }).__live.world().pods.length)).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __live: Handle }).__live.world().m.tokensOut), { timeout: 20_000 }).toBeGreaterThan(5);
    await expect(page.getByTestId("step-toggle")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the step-through and the tour are not offered while replaying", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("step-toggle")).toBeVisible();
    await page.getByTestId("more").click();
    await page.getByTestId("mode-calibrated").click();
    await expect(page.getByTestId("step-toggle")).toHaveCount(0);
    await expect(page.getByTestId("tour-start")).toHaveCount(0);
  });

  test("a KV-pressure replay shows a preemption", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = guard(page);
    await page.goto("/");
    await page.getByTestId("more").click();
    await page.getByTestId("mode-calibrated").click();
    await page.getByTestId("scenario").selectOption("kv-pressure");
    await page.getByTestId("speed-10").click();
    await expect(page.getByTestId("hud")).toContainText("1 preempted", { timeout: 30_000 });
    expect(errors).toEqual([]);
  });

  test("an unreachable replay file says so instead of hanging", async ({ page }) => {
    await page.route("**/replay/prefix-followups.json", (r) => r.fulfill({ status: 404, body: "no" }));
    await page.goto("/");
    await page.getByTestId("more").click();
    await page.getByTestId("mode-calibrated").click();
    await expect(page.getByTestId("replay-failed")).toContainText("could not be loaded");
    await page.getByTestId("mode-explore").click();
    await expect(page.getByTestId("arch")).toBeVisible();
  });

  test("a phone-width screen does not scroll sideways in either mode", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByTestId("more").click();
    await page.getByTestId("mode-calibrated").click();
    await expect(page.getByTestId("blis-badge")).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await overflow()).toBeLessThanOrEqual(0);
    const box = await page.getByTestId("blis-badge").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  });
});
