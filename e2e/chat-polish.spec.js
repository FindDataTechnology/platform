// E2E for the chat main-page polish (change C). Covers:
//   - 8.1 welcome state visible on a fresh chat
//   - 8.2 clicking a suggested prompt fills the composer
//   - 8.3 first message hides the welcome and shows the header + log
//   - 8.4 in-session title rename → sidebar updates
//   - 8.5 slash picker: open, filter, arrow + Enter insert
//   - 8.6 Esc dismisses the picker
//
// No real LLM call is required — typing a message and sending it via the
// composer is enough to switch the page from the welcome state to the
// in-session state (the server echoes a done event once the user submits).
// Tests run on the fast project (no PW_LIVE), so we drive the composer but
// don't wait for an actual assistant response.

import { test, expect } from "@playwright/test";
import { gotoChat, waitForIdle } from "./helpers.js";

test.describe("chat main-page polish", () => {
  test.beforeEach(async ({ page }) => {
    await gotoChat(page);
  });

  test("8.1 fresh chat shows the welcome state with 4 prompt cards", async ({ page }) => {
    // Start a brand-new session so the welcome is guaranteed to be the
    // starting surface (a restored session from a prior run could already
    // be in-session).
    await page.getByTestId("new-chat-btn").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible({ timeout: 5000 });
    const cards = page.getByTestId("welcome-prompt-card");
    await expect(cards).toHaveCount(4);
  });

  test("8.2 clicking a suggested prompt prefills the composer", async ({ page }) => {
    await page.getByTestId("new-chat-btn").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    const firstCard = page.getByTestId("welcome-prompt-card").first();
    // The card PREFILLS instead of sending: the composer fills and takes
    // focus, the welcome stays, and nothing goes over the WS (the user is
    // in control of what actually gets sent).
    await firstCard.click();
    const input = page.getByTestId("composer-input");
    await expect(input).not.toHaveValue("");
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    const focused = await page.evaluate(
      () => document.activeElement?.getAttribute("data-testid") || "",
    );
    expect(focused).toBe("composer-input");
  });

  test("8.3 first message hides the welcome and shows the chat header + log", async ({ page }) => {
    await page.getByTestId("new-chat-btn").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
    // A previous test's turn may still be streaming (composer unstable
    // while autogrow re-runs per render) — wait for idle before typing.
    await waitForIdle(page, 30000);
    const input = page.getByTestId("composer-input");
    await input.fill("hello polish-test");
    await page.getByTestId("composer-send").click();
    // The welcome vanishes and the in-session chrome (header + log) appears.
    await expect(page.getByTestId("chat-welcome")).toBeHidden({ timeout: 10000 });
    await expect(page.getByTestId("chat-header")).toBeVisible();
    await expect(page.getByTestId("chat-log")).toBeVisible();
    await waitForIdle(page, 30000);
  });

  test("8.3b header carries a title and an overflow, and no status strip", async ({ page }) => {
    await page.getByTestId("new-chat-btn").click();
    const input = page.getByTestId("composer-input");
    await input.fill("trigger in-session state");
    await waitForIdle(page, 30000);
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("chat-header")).toBeVisible({ timeout: 10000 });
    await waitForIdle(page, 30000);

    await expect(page.getByTestId("chat-header-title")).toBeVisible();
    await expect(page.getByTestId("chat-header-overflow")).toBeVisible();

    // The duplicated `model · agent · status` strip is gone — the control strip
    // reports model and agent, the sidebar footer reports connection status.
    await expect(page.getByTestId("chat-header-status")).toHaveCount(0);
    await expect(page.getByTestId("chat-header-model")).toHaveCount(0);
    await expect(page.getByTestId("chat-header-agent")).toHaveCount(0);

    // The overflow opens the same session menu the sidebar right-click opens.
    await page.getByTestId("chat-header-overflow").click();
    await expect(page.getByTestId("session-menu")).toBeVisible();
    await expect(page.getByTestId("session-menu-clear")).toBeVisible();
    // Delete is disabled on the active session, which this always is.
    await expect(page.getByTestId("session-menu-delete")).toBeDisabled();
  });

  test("8.4 in-session title rename updates the sidebar row", async ({ page }) => {
    await page.getByTestId("new-chat-btn").click();
    const input = page.getByTestId("composer-input");
    await input.fill("trigger in-session state");
    await waitForIdle(page, 30000);
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("chat-header")).toBeVisible({ timeout: 10000 });
    await waitForIdle(page, 30000);

    // The current session id is exposed by the sidebar's data-session-id.
    const currentId = await page
      .locator('[data-testid="session-row"][data-current="true"]')
      .first()
      .getAttribute("data-session-id");
    expect(currentId).toBeTruthy();

    // Click the title → input appears → type → Enter commits.
    await page.getByTestId("chat-header-title").click();
    const titleInput = page.getByTestId("chat-header-title-input");
    await expect(titleInput).toBeVisible();
    await titleInput.fill("renamed-by-test");
    await page.getByTestId("chat-header-title-confirm").click();

    // The sidebar row for this id reflects the new title (broadcast via
    // session_renamed). Match by a partial, case-insensitive substring so
    // the assertion is robust to display truncation.
    await expect
      .poll(
        async () =>
          (await page
            .locator(`[data-testid="session-row"][data-session-id="${currentId}"]`)
            .first()
            .textContent()) || "",
        { timeout: 5000 },
      )
      .toContain("renamed-by-test");
  });

  test("8.5 slash picker: open, filter, arrow + Enter inserts a command", async ({ page }) => {
    await page.getByTestId("new-chat-btn").click();
    const input = page.getByTestId("composer-input");
    await input.click();
    // Type `/` then a substring that matches only /model (no other command
    // starts with "mod"); the picker should narrow to a single item.
    await input.type("/mod");
    const picker = page.getByTestId("slash-picker");
    await expect(picker).toBeVisible();
    const items = page.getByTestId("slash-picker-item");
    await expect(items.first()).toBeVisible();
    // Enter inserts the highlighted label.
    await input.press("Enter");
    const inserted = await input.inputValue();
    expect(inserted).toContain("/model");
    // Picker is gone after the insert.
    await expect(picker).toBeHidden();
  });

  test("8.6 Esc dismisses the slash picker without changing the composer", async ({ page }) => {
    await page.getByTestId("new-chat-btn").click();
    const input = page.getByTestId("composer-input");
    await input.click();
    await input.type("/mo");
    const picker = page.getByTestId("slash-picker");
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    // Composer text is unchanged.
    const value = await input.inputValue();
    expect(value).toBe("/mo");
  });
});
