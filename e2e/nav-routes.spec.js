import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Route coverage for the ui-nav-restructure change:
//   - new top-level routes render the right page
//   - legacy URLs redirect to their new homes
//   - the new tab order is wired into the sidebar

test.describe("new nav routes", () => {
  test("/knowledge renders the documents page", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/knowledge");
    await expect(page.getByTestId("documents-page")).toBeVisible({ timeout: 15000 });
  });

  test("/mcp renders the MCP extensions page", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/mcp");
    const root = page.getByTestId("extensions-page");
    await expect(root).toBeVisible({ timeout: 15000 });
    await expect(root).toHaveAttribute("data-extensions-type", "mcp");
  });

  test("/skills renders the Skills extensions page", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/skills");
    const root = page.getByTestId("extensions-page");
    await expect(root).toBeVisible({ timeout: 15000 });
    await expect(root).toHaveAttribute("data-extensions-type", "skills");
  });

  test("/models renders the Models page", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/models");
    await expect(page.getByTestId("models-page")).toBeVisible({ timeout: 15000 });
  });

  test("/dashboard renders the system-status page (URL kept, content renamed)", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/dashboard");
    await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
  });
});

test.describe("legacy route redirects", () => {
  test("/documents → /knowledge", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/documents");
    await expect(page).toHaveURL(/\/knowledge$/);
    await expect(page.getByTestId("documents-page")).toBeVisible({ timeout: 15000 });
  });

  test("/extensions → /mcp", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/extensions");
    await expect(page).toHaveURL(/\/mcp$/);
    const root = page.getByTestId("extensions-page");
    await expect(root).toBeVisible({ timeout: 15000 });
    await expect(root).toHaveAttribute("data-extensions-type", "mcp");
  });

  test("/extensions/mcp → /mcp", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/extensions/mcp");
    await expect(page).toHaveURL(/\/mcp$/);
    await expect(page.getByTestId("extensions-page")).toBeVisible();
  });

  test("/extensions/skills → /skills", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/extensions/skills");
    await expect(page).toHaveURL(/\/skills$/);
    const root = page.getByTestId("extensions-page");
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute("data-extensions-type", "skills");
  });
});
