import { test, expect } from "@playwright/test";
import { gotoChat, openSettings } from "./helpers.js";

// i18n: the locale switcher (Settings -> General) re-renders the shell in the
// chosen locale, and the choice survives a reload. The switcher moved out of
// the sidebar footer, but what it does is unchanged. These don't need an LLM
// call, so they run in the fast suite (no @smoke tag).

test.describe("i18n locale switching", () => {
  test("switching locale re-renders visible strings", async ({ page }) => {
    await gotoChat(page); // pinned to en when unset
    await expect(page.getByTestId("status-text")).toHaveText("Connected");
    await openSettings(page, "general");
    await expect(page.getByTestId("locale-select")).toBeVisible();

    // en -> zh-CN
    await page.getByTestId("locale-select").selectOption("zh-CN");
    await expect(page.getByTestId("status-text")).toHaveText("已连接");

    // zh-CN -> en (round trip)
    await page.getByTestId("locale-select").selectOption("en");
    await expect(page.getByTestId("status-text")).toHaveText("Connected");
  });

  test("locale choice persists across reload", async ({ page }) => {
    await gotoChat(page);
    await openSettings(page, "general");
    await page.getByTestId("locale-select").selectOption("ja");
    await expect(page.getByTestId("status-text")).toHaveText("接続済み");

    await page.reload();
    // After reload the stored locale (ja) is re-applied; the en-pin helper
    // only sets when nothing is stored, so it must NOT clobber "ja".
    await expect(page.getByTestId("status-text")).toHaveText("接続済み");
  });
});
