import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Below `md` the 240px rail is CSS-hidden and the drawer is the only way to
// navigate. The chat header carries a toggle, but every OTHER work surface had
// none — at 640px the sidebar simply vanished and the user was stranded on
// whatever page they were on (measured 2026-11-09, right after the materials
// market made non-chat surfaces primary destinations).
test.describe("narrow viewport has a way into the drawer", () => {
  test.use({ viewport: { width: 640, height: 760 } });

  test("a non-chat surface renders a drawer toggle and it opens the rail", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=plugins");
    await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15000 });

    const open = page.getByTestId("nav-drawer-open");
    await expect(open).toBeVisible();
    await open.click();
    // Below md BOTH rails exist in the DOM (the desktop one is CSS-hidden), so
    // scope to the drawer or the same testid resolves twice.
    const drawer = page.getByTestId("nav-drawer");
    await expect(drawer).toBeVisible();
    const tuning = drawer.getByTestId("nav-tuning");
    await expect(tuning).toBeVisible();
    await tuning.click();
    await expect(page.getByTestId("tuning-page")).toBeVisible();
    await expect(page.getByTestId("nav-drawer-open")).toBeVisible();
  });

  test("chat keeps its own header toggle and does not double up", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/chat");
    await expect(page.getByTestId("nav-toggle")).toBeVisible({ timeout: 15000 });
    // The shell-level control is suppressed on chat: one affordance, not two.
    await expect(page.getByTestId("nav-drawer-open")).toHaveCount(0);
  });
});
