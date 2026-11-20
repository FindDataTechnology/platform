// ── Market card relation state (polish-material-market-tabs 1.2) ────────────
//
// The market used to render an installed pack exactly like a never-seen one.
// These pin the two facts a card may state — 已装 vN and 可更新 vY — and that a
// failed install read says nothing at all (unknown ≠ "not installed").

import { expect, test } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

async function openMarket(page) {
  await pinLocaleEn(page);
  await page.goto("/packs");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15_000 });
}

function stubMarket(page, packs) {
  return page.route("**/api/packs?**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ total: packs.length, page: 1, pageSize: 50, packs }),
    }),
  );
}

const pack = (id, version) => ({
  id,
  authorEmail: "creator@e2e.test",
  createdAt: Date.now(),
  version,
  name: id,
  description: `pack ${id}`,
  tags: [],
  publishedAt: Date.now(),
  visibility: "public",
  unlisted: false,
  category: "demo",
});

test("an installed pack says so; a newer listing says 可更新", async ({ page }) => {
  await page.route("**/api/mypacks*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        packs: [
          { packId: "rel-installed", name: "rel-installed", version: 3, manifest: {}, installedAt: "", updatedAt: "" },
          { packId: "rel-stale", name: "rel-stale", version: 3, manifest: {}, installedAt: "", updatedAt: "" },
        ],
      }),
    }),
  );
  await stubMarket(page, [pack("rel-installed", 3), pack("rel-stale", 4), pack("rel-fresh", 1)]);
  await openMarket(page);

  // Installed at the listed version: 已装 only.
  await expect(page.getByTestId("pack-installed-badge-rel-installed")).toContainText("Installed v3");
  await expect(page.getByTestId("pack-update-badge-rel-installed")).toHaveCount(0);

  // Installed behind the listing: 已装 + 可更新.
  await expect(page.getByTestId("pack-installed-badge-rel-stale")).toContainText("Installed v3");
  await expect(page.getByTestId("pack-update-badge-rel-stale")).toContainText("Update to v4");

  // Never installed: neither badge.
  await expect(page.getByTestId("pack-installed-badge-rel-fresh")).toHaveCount(0);
  await expect(page.getByTestId("pack-update-badge-rel-fresh")).toHaveCount(0);
});

test("a failed install read shows no relation at all, and the rows still render", async ({ page }) => {
  // Count the hits: without this, the assertions below would also pass when the
  // route simply never matched (a green for the wrong reason).
  let installReads = 0;
  await page.route("**/api/mypacks*", (route) => {
    installReads += 1;
    return route.fulfill({ status: 500, body: "boom" });
  });
  await stubMarket(page, [pack("rel-unknown", 2)]);
  await openMarket(page);

  await expect(page.getByTestId("pack-card-rel-unknown")).toBeVisible();
  expect(installReads).toBeGreaterThan(0);
  await expect(page.getByTestId("pack-installed-badge-rel-unknown")).toHaveCount(0);
  await expect(page.getByTestId("pack-update-badge-rel-unknown")).toHaveCount(0);
});
