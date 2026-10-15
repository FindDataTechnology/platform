import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// AgentsPage: three sub-tabs (Experts, Market, Apps). Default is Experts;
// the active tab is reflected in ?tab=... and round-trips on reload. Market
// hosts the pack marketplace (moved out of Settings) and only exists on
// deployments that report it (simplify-ia-non-technical).

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

  test("Experts tab embeds the custom-preset management surface", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    // 我的专家 — the preset surface (add-custom-presets) lives under the grid.
    await expect(page.getByTestId("custom-presets-page")).toBeVisible();
    await expect(page.getByTestId("preset-create")).toBeVisible();
  });

  test("deep-link via ?tab=market shows the marketplace", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents?tab=market");
    await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("agents-tab-market")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("packs-page")).toBeVisible();
  });

  test("retired Settings sections redirect into the page", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/presets");
    await expect(page).toHaveURL(/\/agents\?tab=agents$/);
    await expect(page.getByTestId("agents-tab-agents")).toHaveAttribute("aria-selected", "true");

    await page.goto("/settings/packs");
    await expect(page).toHaveURL(/\/agents\?tab=market$/);
    await expect(page.getByTestId("agents-tab-market")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("packs-page")).toBeVisible();
  });
});
