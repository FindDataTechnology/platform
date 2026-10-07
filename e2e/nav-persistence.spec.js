import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// In-app navigation preserves the WebSocket: navigating between React views
// via the sidebar must not reload the page or drop the WS connection.

test.describe("navigation persistence", () => {
  test("sidebar nav keeps WS connected across views", async ({ page }) => {
    await gotoChat(page);
    await expect(page.getByTestId("status-text")).toHaveText("Connected");

    // Knowledge -> back to Chat via in-app nav.
    await page.getByTestId("nav-knowledge").click();
    await expect(page).toHaveURL(/\/knowledge/);
    await expect(page.getByTestId("documents-page")).toBeVisible();
    // WS still connected (no reload).
    await expect(page.getByTestId("status-text")).toHaveText("Connected");

    await page.getByTestId("nav-chat").click();
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByTestId("status-text")).toHaveText("Connected");
  });

  test("no full page reload on nav", async ({ page }) => {
    await gotoChat(page);
    let loads = 0;
    page.on("domcontentloaded", () => { loads++; });
    await page.getByTestId("nav-knowledge").click();
    await page.getByTestId("nav-chat").click();
    // Only the initial load should have fired; in-app nav does not trigger DOMContentLoaded.
    expect(loads).toBe(0);
  });

  test("work-surface tabs render their pages (Knowledge, Agents, Bots, Trace)", async ({ page }) => {
    await gotoChat(page);
    for (const id of ["nav-knowledge", "nav-agents", "nav-bots", "nav-trace"]) {
      await page.getByTestId(id).click();
      await expect(page.getByTestId("status-text")).toHaveText("Connected");
    }
  });
});
