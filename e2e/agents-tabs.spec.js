import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// AgentsPage: two sub-tabs (Agents, Apps). Default is Agents; the active tab
// is reflected in ?tab=... and round-trips on reload.

test.describe("agents page sub-tabs", () => {
  test("default tab is Agents", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-agents")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agents-section")).toBeVisible();
  });

  test("clicking Apps switches the active tab", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("agents-tab-apps").click();
    await expect(page).toHaveURL(/tab=apps/);
    await expect(page.getByTestId("agents-tab-apps")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("apps-section")).toBeVisible();
  });

  test("deep-link via ?tab=apps", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=apps");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-apps")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("apps-section")).toBeVisible();
  });

  test("deep-link via ?tab=agents", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=agents");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-agents")).toHaveAttribute("aria-selected", "true");
  });
});
