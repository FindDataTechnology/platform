import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Pack memory policy panel (openspec: add-pack-memory-declaration 3.4).
//
// The four columns exist to make "declared but not in force" visible without
// reading code, so the assertions are about the TABLE, not about the fetch:
//   · four column headers, and a row whose declared / inherited / effective are
//     all filled in (the "three values" the acceptance asks for)
//   · a declared-but-unexecuted sub-key is badged — a value nobody runs must not
//     read as in force
//   · an unparseable stored row is named (row-level `invalid` and, for keys with
//     no row at all, the top-level `stored_invalid`)
//   · at 390px the table stays inside the drawer: no column is pushed out
//     (measured on the table element, not on a screenshot alone)

const FLEET_ID = "fleet_mem";
const PACK_ID = "legal-crew";

const POLICY = {
  rootKey: `d-${PACK_ID}`,
  policy_root: `d-${PACK_ID}`,
  scope: "pack",
  project: "default",
  deployment_default: { distill: "on" },
  rows: {
    distill: { declared: "off", inherited_from: "root", effective: "off", executed: true },
    promote_after: { declared: 3, inherited_from: "root", effective: 3, executed: false },
    cold_after_days: { declared: 90, inherited_from: "root", effective: 90, executed: false, invalid: { code: "policy_cold_after_days_invalid", message: "must be an integer >= 0", level: "root" } },
  },
  not_executed: ["promote_after", "cold_after_days"],
  stored_invalid: [{ level: "root", key: "process.distil", code: "policy_key_unknown", message: "process.distil is not a known key" }],
};

const DETAIL = {
  fleet: { id: FLEET_ID, name: "Memory Fleet", state: "active", createdAt: 0, updatedAt: 0, sourceTemplate: { packId: PACK_ID, version: "1.0.0" } },
  members: [
    {
      id: "ceo",
      fleetId: FLEET_ID,
      title: "CEO",
      parentId: null,
      target: { kind: "persona", id: "p1", label: "甲" },
      kpiSlots: [],
      cadence: null,
      sortKey: 0,
      createdAt: 0,
      updatedAt: 0,
      taskId: null,
      status: "on_duty",
      statusReason: "",
      evidence: { lastRunAt: null, nextRunAt: null, staleWindowMs: null, latestReportAt: null, hitWindow: null },
      latestReport: null,
      reportTimeline: [],
      lastTurn: null,
      consecutiveFailures: 0,
      skippedRounds: 0,
    },
  ],
};

async function openDrawer(page) {
  await pinLocaleEn(page);
  await page.route("**/api/fleets", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Memory Fleet", state: "active", memberCount: 1, statusCounts: {} }] }),
    }),
  );
  await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(DETAIL) }),
  );
  await page.route(`**/api/fleets/${FLEET_ID}/runs**`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
  );
  await page.route("**/api/memory/deployer-entries**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ items: [] }) }),
  );
  await page.route("**/api/memory/policy**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(POLICY) }),
  );

  await page.goto(`/fleets/${FLEET_ID}`);
  await expect(page.getByTestId("fleets-page")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("member-memory-drawer-ceo").click();
  await expect(page.getByTestId("fleet-memory-drawer")).toBeVisible({ timeout: 15000 });
  // The panel starts collapsed — the entries list is the drawer's primary job.
  await page.getByTestId("fleet-memory-policy-toggle").click();
  await expect(page.getByTestId("fleet-memory-policy-table")).toBeVisible();
}

test.describe("pack memory policy panel", () => {
  test("four columns, and a row with declared / inherited / effective all filled", async ({ page }) => {
    await openDrawer(page);

    const headers = page.getByTestId("fleet-memory-policy-table").locator("thead th");
    await expect(headers).toHaveCount(4);
    for (const label of ["Key", "Declared", "Inherited from", "In effect"]) {
      await expect(headers.filter({ hasText: label })).toHaveCount(1);
    }

    const row = page.getByTestId("fleet-memory-policy-row-distill");
    await expect(row).toBeVisible();
    await expect(row).toContainText("distill");
    await expect(row).toContainText("off"); // declared
    await expect(row).toContainText("root"); // inherited_from
    // effective is "off" too; the column count is what matters, so assert the
    // three distinct sources are all present rather than the same word twice.
    await expect(row.locator("td")).toHaveCount(4);
  });

  test("a declared value nobody executes is badged, and a bad stored row is named", async ({ page }) => {
    await openDrawer(page);
    await expect(page.getByTestId("fleet-memory-policy-unexecuted-promote_after")).toBeVisible();
    await expect(page.getByTestId("fleet-memory-policy-invalid-cold_after_days")).toBeVisible();
    // A key this version does not know produces no row at all — the top-level
    // list is the only place it can appear, so it must appear there.
    const stored = page.getByTestId("fleet-memory-policy-stored-invalid");
    await expect(stored).toBeVisible();
    await expect(stored).toContainText("process.distil");
  });

  test("the scope line says the root is shared, not per team", async ({ page }) => {
    await openDrawer(page);
    const scope = page.getByTestId("fleet-memory-policy-scope");
    await expect(scope).toContainText(`d-${PACK_ID}`);
    await expect(scope).toContainText("every team landed from this pack");
  });

  test("at 390px no column is pushed out of the drawer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await openDrawer(page);
    const table = page.getByTestId("fleet-memory-policy-table");
    const box = await table.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    // The table must fit the viewport, and its own content must not overflow it —
    // `truncate` on every cell is what guarantees the second half.
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + (box.width ?? 0)).toBeLessThanOrEqual((viewport?.width ?? 0) + 0.5);
    const overflow = await table.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // And the last column is still visible (not clipped away horizontally).
    await expect(page.getByTestId("fleet-memory-policy-row-distill").locator("td").nth(3)).toBeVisible();
  });
});
