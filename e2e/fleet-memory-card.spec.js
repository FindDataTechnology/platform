import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Memory watermark card on the owner board (openspec:
// harden-platform-memory-carrier 3.1). Three face states pinned via route
// mocks, plus the honest-absence case (no gateway face → no card):
//   - normal水位: bar + ok headroom, no amber
//   - low headroom: amber badge naming pct vs threshold, per-cell rows RSS-desc
//   - metrics unavailable: unavailable marker, no bar
//   - route absent (desktop single-process): the card renders nothing

const CELLS_FACE = {
  available: true,
  sampledAt: Date.now(),
  container: {
    available: true,
    usedBytes: 900 * 1048576,
    limitBytes: 1536 * 1048576,
    headroomPct: 0.414,
    threshold: 0.15,
  },
  cells: [
    {
      cellId: "aaaaaaaaaaaaaaaa",
      ownerEmail: "me@test",
      totalBytes: 220 * 1048576,
      processes: [
        { pid: 11, name: "server.js", rssBytes: 200 * 1048576, role: "cell-server" },
        { pid: 12, name: "delegation-mcp.js", rssBytes: 20 * 1048576, role: "mcp-satellite" },
      ],
    },
  ],
  gateway: { totalBytes: 100 * 1048576, processes: [{ pid: 1, name: "index.js", rssBytes: 100 * 1048576, role: "gateway" }] },
  ungrouped: { totalBytes: 5 * 1048576 },
  buckets: { "cell-server": 1, "dsh-runtime": 0, "mcp-satellite": 1, gateway: 1, ungrouped: 1 },
};

async function setupBoard(page) {
  await pinLocaleEn(page);
  await page.route("**/api/fleets/owner/board", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 1, sampledAt: Date.now(), fleets: [] }) }),
  );
  await page.route("**/api/fleets/owner/cells", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
}

test.describe("owner board memory card", () => {
  test("normal水位: bar renders, headroom ok, no amber", async ({ page }) => {
    await setupBoard(page);
    await page.route("**/api/monitoring/memory", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(CELLS_FACE) }),
    );
    await page.goto("/fleets?view=owner");
    const card = page.getByTestId("fleet-board-memory");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("fleet-board-memory-bar")).toBeVisible();
    await expect(page.getByTestId("fleet-board-memory-ok")).toContainText("headroom 41%");
    await expect(page.getByTestId("fleet-board-memory-low")).toHaveCount(0);
    await expect(page.getByTestId("fleet-board-memory-cell-aaaaaaaaaaaaaaaa")).toContainText("220 MB · 2 processes");
    await expect(page.getByTestId("fleet-board-memory-ungrouped")).toContainText("ungrouped 5 MB");
  });

  test("low headroom: amber badge carries pct vs threshold", async ({ page }) => {
    await setupBoard(page);
    const low = {
      ...CELLS_FACE,
      container: { ...CELLS_FACE.container, usedBytes: 1460 * 1048576, headroomPct: 0.05 },
    };
    await page.route("**/api/monitoring/memory", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(low) }),
    );
    await page.goto("/fleets?view=owner");
    await expect(page.getByTestId("fleet-board-memory-low")).toContainText("headroom below threshold (95% < 15%)");
    // The warning styling rides the badge. Asserted through the SEMANTIC token:
    // the surface moved from the `amber` palette name to `status-waiting` when
    // the design system went semantic, and a literal here fails on the next
    // palette swap while the branch stays correct (same class the platform-ops
    // billing readout had).
    await expect(page.getByTestId("fleet-board-memory-low")).toHaveClass(/status-waiting/);
    await expect(page.getByTestId("fleet-board-memory-ok")).toHaveCount(0);
  });

  test("metrics unavailable: honest marker, no bar", async ({ page }) => {
    await setupBoard(page);
    await page.route("**/api/monitoring/memory", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ available: false, reason: "proc_unavailable: ENOENT" }),
      }),
    );
    await page.goto("/fleets?view=owner");
    await expect(page.getByTestId("fleet-board-memory")).toBeVisible();
    await expect(page.getByTestId("fleet-board-memory-unavailable")).toBeVisible();
    await expect(page.getByTestId("fleet-board-memory-bar")).toHaveCount(0);
  });

  test("route absent (desktop): card renders nothing", async ({ page }) => {
    await setupBoard(page);
    await page.route("**/api/monitoring/memory", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await page.goto("/fleets?view=owner");
    await expect(page.getByTestId("fleet-owner-board")).toBeVisible();
    await expect(page.getByTestId("fleet-board-memory")).toHaveCount(0);
  });
});
