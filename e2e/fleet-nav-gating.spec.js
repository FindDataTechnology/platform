// ── Fleet nav gating e2e (hide-fleet-nav-on-web, fast lane) ──────────────────
//
// The Wanxing fleet console is a desktop-shell surface: the sidebar entry and
// the page's two read zones (local-runner proxy + registry catalog proxy)
// exist only inside the Electron shell (detected via the preload bridge).
// In a plain browser — which is all this harness has — the nav item must be
// absent and /fleet must land on the desktop-only explanation without
// polling either proxy endpoint.
//
//   npm run test:e2e -- e2e/fleet-nav-gating.spec.js

import { expect, test } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

test.beforeEach(async ({ page }) => {
  await pinLocaleEn(page);
});

test("plain browser: no fleet nav entry and /fleet lands on the desktop-only note", async ({ page }) => {
  // Route-level guard: if the page ever polls from a plain browser, this
  // fails the test with the unmocked-path error — the assertion contract is
  // "no proxy calls at all", not just "no visible zones".
  let polled = 0;
  await page.route("**/api/wanxing/fleet/**", (route) => {
    polled += 1;
    return route.fulfill({ status: 500, body: JSON.stringify({ error: "polled from plain browser" }) });
  });

  await page.goto("/chat");
  await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("nav-fleet")).toHaveCount(0);

  await page.goto("/fleet");
  await expect(page.getByTestId("fleet-desktop-only")).toBeVisible({ timeout: 15_000 });
  // The two read zones (and their guides) stay absent — only the note renders.
  await expect(page.getByTestId("fleet-live")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(polled).toBe(0);
});
