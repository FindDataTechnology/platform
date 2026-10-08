import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// App shell: the React SPA is the sole frontend. `/` is served by the SPA
// which routes to /chat; Documents/Dashboard are React routes.
// No legacy vanilla page exists anymore.

test.describe("app shell", () => {
  test("root serves the SPA and routes to /chat", async ({ page }) => {
    const response = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBeLessThan(400);
    // The SPA's client router redirects `/` -> `/chat`; wait for it to settle.
    await expect(page).toHaveURL(/\/chat\/?$/, { timeout: 10000 });
  });

  test("/chat loads and shows sidebar + composer + status", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("session-list-section")).toBeVisible();
    await expect(page.getByTestId("status-text")).toHaveText("Connected");
  });

  test("sidebar shows the React nav entries", async ({ page }) => {
    await gotoChat(page);
    for (const id of ["nav-chat", "nav-knowledge", "nav-agents", "nav-bots", "nav-trace"]) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    // Configuration is not nav any more — it lives behind the gear.
    for (const id of ["nav-mcp", "nav-skills", "nav-models"]) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
    await expect(page.getByTestId("settings-btn")).toBeVisible();
  });

  test("deep links resolve via the SPA fallback", async ({ page }) => {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/settings\/status$/);
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
  });
});
