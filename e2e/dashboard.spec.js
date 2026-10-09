import { test, expect } from "@playwright/test";
import { gotoDashboard } from "./helpers.js";

// React Dashboard view (/dashboard): renders server rows + model, and the
// /api/supervisor/status response must never contain secrets.

const SECRET_KEYS = [
  "LLM_API_KEY",
];

test.describe("React dashboard view", () => {
  test("renders server rows + current model", async ({ page }) => {
    await gotoDashboard(page);
    // At least the server-js row renders.
    await expect(page.getByTestId("server-row").filter({ hasText: "Platform backend" })).toBeVisible();
    // Current model is displayed. The sidebar chip is gone, so assert it on
    // the Active Configuration row of the page under test rather than on a
    // shell element this spec does not own.
    await expect(page.getByTestId("config-row-value").first()).not.toBeEmpty();
  });

  test("supervisor status response contains no secrets", async ({ page }) => {
    // Navigate first so the request context has the right origin, then fetch
    // via Playwright's request API (baseURL-aware).
    await gotoDashboard(page);
    const r = await page.request.get("/api/supervisor/status");
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    for (const key of SECRET_KEYS) {
      expect(body, `response must not contain ${key}`).not.toHaveProperty(key);
    }
  });

  test("manual refresh works", async ({ page }) => {
    await gotoDashboard(page);
    await page.getByTestId("system-status-refresh").click();
    // Refresh button toggles back from "Refreshing…" - row still visible.
    await expect(page.getByTestId("server-row").first()).toBeVisible();
  });
});
