import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Desktop (md+) nav rail: collapsing shrinks it to a 56px icon rail (not a
// full hide). Hovering the rail widens it to the 240px overlay without moving
// the content column; the rail's pin makes that permanent, and Ctrl/Cmd+B
// toggles the permanent state. The collapsed state persists per browser. The
// below-md drawer keeps its own toggle and is unaffected.

const rail = (page) => page.getByTestId("sidebar");

test.describe("sidebar collapse", () => {
  test("header toggle collapses to an icon rail and the pin restores it", async ({ page }) => {
    await gotoChat(page);
    await expect(rail(page)).toBeVisible();
    await expect(page.getByTestId("nav-collapse")).toBeVisible();

    await page.getByTestId("nav-collapse").click();
    // The rail stays mounted in its icon form.
    await expect(rail(page)).toBeVisible();
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("nav-rail-pin")).toBeVisible();
    await expect(page.getByTestId("nav-collapse")).toHaveCount(0);

    await page.getByTestId("nav-rail-pin").click();
    await expect(rail(page)).not.toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("nav-collapse")).toBeVisible();
  });

  test("hovering the icon rail only offers a label — it never expands", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("nav-collapse").click();
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");

    await page.getByTestId("nav-rail").hover();
    // Still the 56px rail: no labels, no family chrome, no width change.
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");
    await expect(page.getByTestId("nav-families-toggle-all")).toHaveCount(0);
    // The label is still reachable for a human: the icon carries a title.
    await expect(page.getByTestId("nav-rail").locator("a[title]").first()).toHaveAttribute("title", /.+/);
  });

  test("Ctrl/Cmd+B toggles the permanent state both ways", async ({ page }) => {
    await gotoChat(page);
    await page.keyboard.press("ControlOrMeta+b");
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");
    await page.keyboard.press("ControlOrMeta+b");
    await expect(rail(page)).not.toHaveAttribute("data-collapsed", "true");
  });

  test("collapsed state persists across reloads", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("nav-collapse").click();
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 15000 });
    await expect(rail(page)).toHaveAttribute("data-collapsed", "true");

    // Leave the suite in the default state for the shared, sequential session.
    await page.getByTestId("nav-rail-pin").click();
    await expect(rail(page)).not.toHaveAttribute("data-collapsed", "true");
  });

  test("below md the drawer keeps its own toggle and no collapse chrome", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await gotoChat(page);
    // The md rail is below-md a CSS-hidden shell: its collapse chrome is never
    // interactable.
    await expect(page.getByTestId("nav-collapse")).toBeHidden();
    await expect(page.getByTestId("nav-rail-pin")).toBeHidden();

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
