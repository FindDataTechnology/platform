import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// App-center load-recovery sentinels (openspec: app-center-load-recovery,
// task 2.1).
//
// A: cold failure — /api/catalog aborts. The hook spends its one automatic
// backoff retry (two attempts total), then the product area names the
// failure with a retry control while the brand cards stay (never-a-broken-
// page preserved). Clicking retry with the endpoint restored paints the grid.
//
// B: background failure — the cache is warm, then the endpoint breaks. The
// grid keeps rendering from cache with NO error frame (the silent posture the
// app-center spec reserves for revalidation).

test("cold catalog failure auto-retries once, then shows the error state with retry", async ({
  page,
}) => {
  await pinLocaleEn(page);
  let attempts = 0;
  await page.route("**/api/catalog", (route) => {
    attempts += 1;
    void route.abort();
  });

  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });

  // Initial attempt + one automatic backoff, then the error frame.
  await expect(page.getByTestId("app-center-load-error")).toBeVisible({ timeout: 15000 });
  expect(attempts).toBe(2);
  // The brand cards survived the failure.
  await expect(page.getByTestId("app-card-yizuo")).toBeVisible();
  await expect(page.getByTestId("app-card-facet")).toBeVisible();

  // Restore the endpoint and take the offered exit: the full grid paints.
  await page.unroute("**/api/catalog");
  await page.getByTestId("app-center-load-error").getByRole("button").click();
  await expect(page.getByTestId("app-card-wanxing-token")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("app-center-load-error")).toHaveCount(0);
});

test("warm cache + broken revalidation stays silent on the cached grid", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/apps");
  await expect(page.getByTestId("app-card-wanxing-token")).toBeVisible({ timeout: 15000 });

  // Break the endpoint AFTER a successful first paint, then re-enter the
  // surface (SPA navigation keeps the in-memory cache warm).
  await page.route("**/api/catalog", (route) => void route.abort());
  await page.getByTestId("nav-chat").click();
  await page.getByTestId("nav-apps").click();

  await expect(page.getByTestId("app-card-wanxing-token")).toBeVisible();
  await expect(page.getByTestId("app-center-load-error")).toHaveCount(0);
});
