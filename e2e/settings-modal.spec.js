import { test, expect } from "@playwright/test";
import { gotoChat, openSettings, pinLocaleEn } from "./helpers.js";

// Settings modal — the surface that replaced the sidebar's settings popover.
//
// The first five tests carry forward what settings-menu.spec.js asserted (open
// on click, reach System Status, reach Models, dismiss on outside click,
// dismiss on Escape). The rest cover what the popover could not do: routing,
// deep links, back-button history, and the legacy redirects.
//
// The popover's "help" entry is gone — the help center's remaining entry point
// is the composer, covered by composer-stop.spec.js.

test.describe("settings modal", () => {
  test("opens on gear click and reaches System Status", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("settings-panel")).toBeHidden();

    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();

    await page.getByTestId("settings-section-status").click();
    await expect(page).toHaveURL(/\/settings\/status$/);
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
  });

  test("reaches LLM Models", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("settings-section-models").click();
    await expect(page).toHaveURL(/\/settings\/models$/);
    await expect(page.getByTestId("models-page")).toBeVisible({ timeout: 15000 });
  });

  test("closes on backdrop click", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();

    await page.getByTestId("settings-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("settings-panel")).toBeHidden();
  });

  test("closes on Escape", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-panel")).toBeHidden();
  });

  test("closes via the explicit close control", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("settings-close").click();
    await expect(page.getByTestId("settings-panel")).toBeHidden();
  });

  test("Cmd/Ctrl + , opens it from any view", async ({ page }) => {
    await gotoChat(page);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await expect(page).toHaveURL(/\/settings\//);
  });

  test("dismissing restores the view it was opened from", async ({ page }) => {
    await gotoChat(page);
    await page.goto("/trace");
    await expect(page.getByTestId("trace-page")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    // The underlying view stays mounted — that is the point of a modal.
    await expect(page.getByTestId("trace-page")).toBeAttached();

    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/trace$/);
    await expect(page.getByTestId("trace-page")).toBeVisible();
  });

  test("deep link opens a section over the chat view", async ({ page }) => {
    await openSettings(page, "models");
    await expect(page.getByTestId("models-page")).toBeVisible({ timeout: 15000 });
    // No background location on a cold load, so /chat stands in behind it.
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/chat$/);
  });

  test("switching sections updates the URL and the back button walks it", async ({ page }) => {
    await openSettings(page, "general");

    await page.getByTestId("settings-section-mcp").click();
    await expect(page).toHaveURL(/\/settings\/mcp$/);
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "mcp");

    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "general");
  });

  test("bare /settings and an unknown slug both resolve to General", async ({ page }) => {
    await pinLocaleEn(page);

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "general");

    await page.goto("/settings/nonexistent-section");
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "general");
  });

  test("every legacy configuration route redirects to its section", async ({ page }) => {
    await pinLocaleEn(page);
    const cases = [
      ["/models", "models"],
      ["/mcp", "mcp"],
      ["/skills", "skills"],
      ["/extensions", "mcp"],
      ["/extensions/mcp", "mcp"],
      ["/extensions/skills", "skills"],
      ["/dashboard", "status"],
    ];
    for (const [legacy, section] of cases) {
      await page.goto(legacy);
      await expect(page).toHaveURL(new RegExp(`/settings/${section}$`));
      await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", section);
    }
  });

  test("a Manage link to another section switches panes without closing", async ({ page }) => {
    await openSettings(page, "status");
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("mcp-manage-link").click();
    await expect(page).toHaveURL(/\/settings\/mcp$/);
    // Still open, just a different pane.
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "mcp");
  });

  test("a Manage link to a work surface closes the modal", async ({ page }) => {
    await gotoChat(page);
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("settings-section-status").click();
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });

    // The Agents link targets /agents, which is a nav tab, not a section.
    await page.getByTestId("config-row-manage").last().click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByTestId("settings-panel")).toBeHidden();
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
  });

  test("a section Manage link preserves what the modal was covering", async ({ page }) => {
    await gotoChat(page);
    await page.goto("/trace");
    await expect(page.getByTestId("trace-page")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("settings-btn").click();
    await page.getByTestId("settings-section-status").click();
    await page.getByTestId("mcp-manage-link").click();
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "mcp");

    // Closing must still return to Trace — the Manage link has to carry the
    // background location forward or this lands on /chat.
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/trace$/);
  });

  test("only the active section is mounted", async ({ page }) => {
    await openSettings(page, "status");
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
    // The Models section is listed but not rendered until selected.
    await expect(page.getByTestId("models-page")).toHaveCount(0);
  });
});
