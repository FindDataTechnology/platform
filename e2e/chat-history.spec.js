import { test, expect } from "@playwright/test";
import { gotoChat } from "./helpers.js";

// Chat sessions: session list lives in the React sidebar under /chat/. "+ New"
// starts a fresh session (which becomes current); the list is driven by
// `sessions` events pushed by the server. These tests do not invoke the LLM.

test.describe("chat sessions", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("a current session is shown in the sidebar on load", async ({ page }) => {
    // The server starts a fresh session; the sidebar reflects it as current.
    await expect(
      page.locator('[data-testid="session-row"][data-current="true"]').first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("new chat creates a new current session in the sidebar", async ({ page }) => {
    const currentRow = () =>
      page.locator('[data-testid="session-row"][data-current="true"]').first();

    // Read the current session id (server has already broadcast an initial `sessions`).
    await expect(currentRow()).toBeVisible({ timeout: 5000 });
    const beforeId = await currentRow().getAttribute("data-session-id");

    await page.getByTestId("new-chat-btn").click();

    // Server broadcasts a refreshed session list after new_session; poll until id changes.
    await expect
      .poll(async () => currentRow().getAttribute("data-session-id"), { timeout: 5000 })
      .not.toBe(beforeId);
  });
});
