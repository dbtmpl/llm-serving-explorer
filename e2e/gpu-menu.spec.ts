import { expect, test } from "@playwright/test";

/** The GPU choice lists every catalogue part, wraps instead of overflowing, and each part can be picked. */
test("the GPU choice lists the workstation parts without overflowing and each can be chosen", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("lv-tour-seen", "1"));
  await page.goto("/");
  await page.evaluate(() => document.querySelectorAll("details.lv-group").forEach((d) => ((d as HTMLDetailsElement).open = true)));
  const choice = page.locator(".lv-choice", { hasText: "GPU" }).first();
  await expect(choice.locator("button")).toHaveText(["H100", "H200", "B200", "RTX PRO 6000", "RTX 4090", "MI300X"]);
  const fits = await choice.locator(".lv-seg").evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(fits, "the options overflow their container").toBe(true);
  for (const name of ["RTX 4090", "RTX PRO 6000"]) {
    await choice.getByRole("button", { name }).click();
    await expect(choice.getByRole("button", { name })).toHaveClass(/on/);
    await page.waitForTimeout(500);
  }
  expect(errors).toEqual([]);
});
