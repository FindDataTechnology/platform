import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Plugin catalogue + supply request (openspec: unify-material-market,
// dsh-plugin-supply MODIFIED, plugin-supply-request ADDED).
//
// The catalogue is served by the deployment; the ROSTER (what is actually baked
// in) decides each row's state. The assertions that matter:
//   - an unsupplied row offers 申请供应 and NOT a disabled toggle,
//   - asking twice does not create a second request (the button states it),
//   - nothing here can install anything at runtime.
const CATALOG = {
  plugins: [
    { id: "supplied-one", name: "Supplied One", description: "available locally", licence: "MIT" },
    { id: "missing-one", name: "Missing One", description: "not baked into this deployment", licence: "Apache-2.0" },
  ],
};

test.describe("plugin catalogue", () => {
  test("unsupplied rows offer a request, not a dead toggle", async ({ page }) => {
    await page.route("**/api/plugin-catalog", (route) => route.fulfill({ json: CATALOG }));
    await pinLocaleEn(page);
    await page.goto("/agents?tab=plugins");

    const missing = page.getByTestId("plugin-row-missing-one");
    await expect(missing).toBeVisible({ timeout: 15000 });
    await expect(missing).toHaveAttribute("data-state", "unsupplied");
    // The correct affordance: a request. A grey switch would say "you could
    // click this if your side were fixed", which is not the truth.
    await expect(missing.getByTestId("plugin-request-missing-one")).toBeVisible();
    await expect(missing.getByTestId("plugin-toggle-missing-one")).toHaveCount(0);
  });

  test("a second ask does not fire a second request", async ({ page }) => {
    let posts = 0;
    await page.route("**/api/plugin-catalog", (route) => route.fulfill({ json: CATALOG }));
    await page.route("**/api/plugin-supply-requests", async (route) => {
      if (route.request().method() === "POST") posts += 1;
      return route.fulfill({ status: 201, json: { ok: true, request: { pluginId: "missing-one", state: "requested" } } });
    });
    await pinLocaleEn(page);
    await page.goto("/agents?tab=plugins");

    const button = page.getByTestId("plugin-request-missing-one");
    await expect(button).toBeVisible({ timeout: 15000 });
    await button.click();
    // The row flips to its pending line and the button is gone.
    await expect(page.getByTestId("plugin-request-pending-missing-one")).toBeVisible();
    await expect(page.getByTestId("plugin-request-missing-one")).toHaveCount(0);
    expect(posts).toBe(1);
  });

  test("an empty catalogue explains itself instead of rendering blank", async ({ page }) => {
    await page.route("**/api/plugin-catalog", (route) => route.fulfill({ json: { plugins: [] } }));
    await pinLocaleEn(page);
    await page.goto("/agents?tab=plugins");
    await expect(page.getByTestId("agent-market-panel-plugins")).toContainText(/No plugins ship|未随附/);
  });
});
