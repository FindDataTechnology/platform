import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// add-sidebar-collapse: the desktop (md+) nav rail collapses fully via the
// sidebar header toggle, a pinned affordance, or Ctrl/Cmd+B; the collapsed
// state persists per browser. The below-md drawer keeps its own toggle and is
// unaffected. Note the md rail div stays in the DOM below md (CSS-hidden), so
// narrow-viewport assertions use visibility, not DOM counts.

test.describe("sidebar collapse", () => {
  test("header toggle collapses and the pinned affordance restores the rail", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("nav-expand")).toHaveCount(0);

    await page.getByTestId("nav-collapse").click();
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    await expect(page.getByTestId("nav-expand")).toBeVisible();

    await page.getByTestId("nav-expand").click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("nav-expand")).toHaveCount(0);
  });

  test("Ctrl/Cmd+B toggles the rail both ways", async ({ page }) => {
    await gotoChat(page);
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByTestId("sidebar")).toBeVisible();
  });

  test("collapsed state persists across reloads", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("nav-collapse").click();
    await expect(page.getByTestId("sidebar")).toHaveCount(0);

    await page.reload({ waitUntil: "domcontentloaded" });
    // Collapsed means the rail (and its status row) is unmounted — gate on the
    // composer instead of the WS-connected status text.
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("sidebar")).toHaveCount(0);
    await expect(page.getByTestId("nav-expand")).toBeVisible();

    // Leave the suite in the default state for the shared, sequential session.
    await page.getByTestId("nav-expand").click();
    await expect(page.getByTestId("sidebar")).toBeVisible();
  });

  test("below md the drawer keeps its own toggle and no collapse chrome", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await gotoChat(page);
    // The md rail is below-md a CSS-hidden shell: its collapse toggle is never
    // interactable, and the pinned restore button is not rendered at all.
    await expect(page.getByTestId("nav-collapse")).toBeHidden();
    await expect(page.getByTestId("nav-expand")).toHaveCount(0);

    await page.getByTestId("nav-toggle").click();
    // Two sidebars exist in the DOM now (the hidden md shell + the drawer) —
    // assert on the visible one.
    const visibleSidebar = page.locator('[data-testid="sidebar"]:visible');
    await expect(visibleSidebar).toBeVisible();
    // Backdrop click dismisses (the drawer overlay).
    await page.mouse.click(360, 400);
    await expect(visibleSidebar).toHaveCount(0);
  });
});
