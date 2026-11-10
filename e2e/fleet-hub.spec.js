import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Fleet hub faces (openspec: agent-teams-overview + agent-teams-management).
//   - /fleets defaults to the cross-team overview: summary strip + cards, the
//     abnormal team sorts first (spec: 异常上浮与排序沉睡)
//   - ?view=manage: inline rename round-trips through PATCH /:id
//   - batch with one archived fleet → per-item receipt, partial failure named
//   - /fleets/:id deep link lands in the cockpit, never in a switch state;
//     returning to /fleets shows the overview again

const ABNORMAL = "fleet_abnormal";
const OK = "fleet_ok";
const BUSY = "fleet_busy";
const PAUSED = "fleet_paused";

const roster = [
  { id: OK, name: "OK Team", state: "active", memberCount: 3, openDecisions: 1, defaultModel: null, statusCounts: { on_duty: 3 }, spend: { windows: { "24h": { runs: 5, turns: 5 } } } },
  { id: ABNORMAL, name: "Sick Team", state: "active", memberCount: 2, openDecisions: 0, defaultModel: null, statusCounts: { on_duty: 1, missing: 1 }, spend: { windows: { "24h": { runs: 2, turns: 2 } } } },
  { id: PAUSED, name: "Paused Team", state: "paused", memberCount: 1, openDecisions: 0, defaultModel: null, statusCounts: {}, spend: { windows: { "24h": { runs: 0, turns: 0 } } } },
];

const formationOf = (members, edges) => ({ members, edges, truncated: false });
const overview = {
  v: 1,
  sampledAt: Date.now(),
  fleets: [
    { id: OK, counts: { onDuty: 3, paused: 0, missing: 0, vacant: 0, passive: 0, failing: 0, total: 3 }, openDecisions: { count: 1, top: [{ question: "Renew the vendor contract?", severity: "high", memberTitle: "Ops" }] }, formation: formationOf([{ id: "o1", title: "Ops", status: "on_duty" }, { id: "o2", title: "Writer", status: "on_duty" }], [{ kind: "handoff", from: "o1", to: "o2", implicit: false }]) },
    { id: ABNORMAL, counts: { onDuty: 1, paused: 0, missing: 1, vacant: 0, passive: 0, failing: 0, total: 2 }, openDecisions: { count: 0, top: [] }, formation: formationOf([{ id: "a1", title: "Scanner", status: "on_duty" }, { id: "a2", title: "Recorder", status: "missing" }], [{ kind: "handoff", from: "a1", to: "a2", implicit: false }]) },
    { id: PAUSED, counts: { onDuty: 0, paused: 1, missing: 0, vacant: 0, passive: 0, failing: 0, total: 1 }, openDecisions: { count: 0, top: [] }, formation: formationOf([{ id: "p1", title: "Paused Post", status: "paused" }], []) },
  ],
};

// Owner-board rows render counts.onDuty and all three spend windows
// unconditionally (OwnerBoardFleet type carries them); the fixture mirrors the
// real board payload.
const spendWindows = (runs, turns) => ({
  windows: { "24h": { runs, turns }, "7d": { runs, turns }, "30d": { runs, turns } },
});
const board = {
  v: 1,
  sampledAt: Date.now(),
  fleets: [
    { id: OK, name: "OK Team", state: "active", sourceTemplate: null, counts: { onDuty: 3, paused: 0, missing: 0, vacant: 0, passive: 0, failing: 0, total: 3 }, openDecisions: 1, failing: 0, lastActivityAt: Date.now() - 60_000, spend: spendWindows(5, 5) },
    { id: ABNORMAL, name: "Sick Team", state: "active", sourceTemplate: null, counts: { onDuty: 1, paused: 0, missing: 1, vacant: 0, passive: 0, failing: 0, total: 2 }, openDecisions: 0, failing: 0, lastActivityAt: Date.now() - 600_000, spend: spendWindows(2, 2) },
    { id: PAUSED, name: "Paused Team", state: "paused", sourceTemplate: null, counts: { onDuty: 0, paused: 1, missing: 0, vacant: 0, passive: 0, failing: 0, total: 1 }, openDecisions: 0, failing: 0, lastActivityAt: null, spend: spendWindows(0, 0) },
  ],
};

const cockpit = (id, name) => ({
  fleet: { id, name, state: "active", createdAt: 0, updatedAt: 0 },
  members: [],
  statusCounts: { on_duty: 1 },
  openDecisions: 0,
  decisions: [],
  health: { failing: 0, missing: 0, vacant: 0, paused: 0 },
  orchestration: null,
  stream: [],
  edgeTraffic: [],
  template: null,
});

test.describe("fleet hub", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ fleets: roster }) });
      }
      return route.fulfill({ status: 405, contentType: "application/json", body: "{}" });
    });
    await page.route("**/api/fleets/overview", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(overview) }),
    );
    await page.route("**/api/fleets/owner/board", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(board) }),
    );
    // add-owner-cross-line-view: 第四路读面 mock——六分组真形状（fleet/market/
    // balance 有数，wanxing 代读 available，lex/wire unconnected）。
    await page.route("**/api/fleets/owner/cross-line-spend", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          sampledAt: Date.now(),
          lines: [
            { line: "fleet", status: "ok", calibre: "owner.fleet", reconciledAt: Date.now(), metrics: { runs: 12, turns: 30, fleets: 2 } },
            { line: "market", status: "ok", calibre: "owner.market", reconciledAt: Date.now(), metrics: { purchases: 3, settled: 2, settled_usd: 15.75 } },
            { line: "wanxing", status: "ok", calibre: "owner.wanxing", reconciledAt: Date.now(), metrics: { available: true, turns: 7, minutes: 9, usd: 1.23, pending: 1 } },
            { line: "lex", status: "ok", calibre: "owner.lex", metrics: { unconnected: "not_connected" } },
            { line: "wire", status: "ok", calibre: "owner.wire", metrics: { unconnected: "not_connected" } },
            { line: "balance", status: "ok", calibre: "owner.balance", reconciledAt: Date.now(), metrics: { balance_usd: 42.1 } },
          ],
        }),
      }),
    );
    for (const [id, name] of [[OK, "OK Team"], [ABNORMAL, "Sick Team"], [PAUSED, "Paused Team"], [BUSY, "Busy Team"]]) {
      await page.route(`**/api/fleets/${id}/cockpit`, (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify(cockpit(id, name)) }),
      );
      await page.route(`**/api/fleets/${id}/runs**`, (route) =>
        route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
      );
    }
    await page.route("**/api/fleets/batch", (route) => {
      const body = route.request().postDataJSON();
      // Fixture: PAUSED is terminal-blocked for resume — the receipt must name it.
      const results = body.ids.map((id) =>
        id === PAUSED && body.action !== "pause"
          ? { id, ok: false, error: "This fleet is archived — archived is terminal" }
          : { id, ok: true, state: body.action === "pause" ? "paused" : body.action === "resume" ? "active" : "archived" },
      );
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ action: body.action, results, summary: { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length } }),
      });
    });
  });

  test("overview is the default face: summary strip + abnormal-first cards", async ({ page }) => {
    await page.goto("/fleets");
    await expect(page.getByTestId("teams-overview")).toBeVisible();
    // 跨线花费第四路（add-owner-cross-line-view 2.2）：六格+总额零渲染+未连接态。
    const xline = page.getByTestId("teams-xline-spend");
    await expect(xline).toBeVisible();
    for (const l of ["fleet", "market", "wanxing", "lex", "wire", "balance"]) {
      await expect(page.getByTestId(`teams-xline-${l}`)).toBeVisible();
    }
    await expect(page.getByTestId("teams-xline-wanxing-value")).toContainText("$1.23");
    await expect(page.getByTestId("teams-xline-lex-unconnected")).toBeVisible();
    await expect(page.getByTestId("teams-xline-lex")).toContainText("Connect");
    await expect(page.getByTestId("teams-xline-fleet-value")).toContainText("12 runs");
    // 无总额：区内不出现 grand/total 合计行
    await expect(xline).not.toContainText("total:");
    await expect(page.getByTestId("teams-summary-strip")).toContainText("3 teams");
    await expect(page.getByTestId("teams-summary-abnormal")).toContainText("1 abnormal");
    // The sick team's card leads (missing post = abnormal), OK Team second.
    const firstCard = page.getByTestId("teams-cards").locator("button").first();
    await expect(firstCard).toHaveAttribute("data-testid", `teams-card-${ABNORMAL}`);
    await expect(page.getByTestId(`teams-card-states-${ABNORMAL}`)).toContainText("missing 1");
    // Cards navigate to the cockpit.
    await page.getByTestId(`teams-card-${OK}`).click();
    await expect(page.getByTestId("fleet-detail")).toContainText("OK Team");
  });

  test("manage face: inline rename round-trips through PATCH", async ({ page }) => {
    let patched = null;
    await page.route(`**/api/fleets/${BUSY}`, (route) => route.fulfill({ contentType: "application/json", body: "{}" }));
    await page.route(`**/api/fleets/${OK}`, async (route) => {
      if (route.request().method() === "PATCH") {
        patched = route.request().postDataJSON();
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ fleet: { ...roster[0], ...patched } }) });
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
    });
    await page.goto("/fleets?view=manage");
    await expect(page.getByTestId("teams-manage-table")).toBeVisible();
    // The switch stays visible on the manage face — it is the way back to the
    // overview (the spec only demands it hide in the cockpit).
    await page.getByTestId(`teams-row-name-${OK}`).click();
    await page.getByTestId(`teams-row-name-input-${OK}`).fill("Renamed Team");
    await page.getByTestId(`teams-row-name-input-${OK}`).press("Enter");
    await expect.poll(() => patched).toBeTruthy();
    expect(patched).toEqual({ name: "Renamed Team" });
  });

  test("batch with a terminal-blocked fleet: per-item receipt names the failure", async ({ page }) => {
    await page.goto("/fleets?view=manage");
    await expect(page.getByTestId("teams-manage-table")).toBeVisible();
    // Select OK (resumes fine) and PAUSED (fixture: resume is refused).
    await page.getByTestId(`teams-row-check-${OK}`).check();
    await page.getByTestId(`teams-row-check-${PAUSED}`).check();
    await page.getByTestId("teams-batch-resume").click();
    const receipt = page.getByTestId("teams-batch-receipt");
    await expect(receipt).toContainText("1 succeeded / 1 failed");
    await expect(receipt.getByTestId("teams-batch-receipt-failure")).toContainText("Paused Team");
    await expect(receipt.getByTestId("teams-batch-receipt-failure")).toContainText("terminal");
  });

  test("deep link lands in the cockpit; the switch stays visible, unhighlighted", async ({ page }) => {
    await page.goto(`/fleets/${OK}`);
    await expect(page.getByTestId("fleet-detail")).toContainText("OK Team");
    // polish-agent-teams-hub-navigation: the switch never hides; a bare deep
    // link has no entry source, so no tab carries the active highlight.
    await expect(page.getByTestId("teams-view-switch")).toBeVisible();
    for (const tab of ["teams-view-overview", "teams-view-manage", "teams-view-owner"]) {
      await expect(page.getByTestId(tab)).not.toHaveClass(/text-primary/);
    }
    await page.goto("/fleets");
    await expect(page.getByTestId("teams-overview")).toBeVisible();
  });

function _pollFor(get) {
  return new Promise((resolve) => {
    const tick = () => {
      const v = get();
      if (v) return resolve(v);
      setTimeout(tick, 50);
    };
    tick();
  });
}

  test("cockpit keeps the switch: source highlight follows the entry view, tab click leaves the fleet", async ({ page }) => {
    await page.goto("/fleets");
    await page.getByTestId(`teams-card-${OK}`).click();
    await expect(page).toHaveURL(/\/fleets\/fleet_ok$/);
    await expect(page.getByTestId("teams-view-switch")).toBeVisible();
    // Entered from the overview board → overview stays highlighted in the cockpit.
    await expect(page.getByTestId("teams-view-overview")).toHaveClass(/text-primary/);
    // Clicking Manage leaves the fleet onto the management table.
    await page.getByTestId("teams-view-manage").click();
    await expect(page).toHaveURL(/\/fleets\?view=manage$/);
    await expect(page.getByTestId("teams-manage-table")).toBeVisible();
  });

  test("browser back from the cockpit returns to the owner face", async ({ page }) => {
    await page.goto("/fleets?view=owner");
    await expect(page.getByTestId("fleet-owner-board")).toBeVisible();
    await page.getByTestId(`fleet-board-row-${OK}`).click();
    await expect(page.getByTestId("fleet-detail")).toContainText("OK Team");
    await expect(page.getByTestId("teams-view-owner")).toHaveClass(/text-primary/);
    await page.goBack();
    await expect(page).toHaveURL(/\/fleets\?view=owner$/);
    await expect(page.getByTestId("fleet-owner-board")).toBeVisible();
  });

  test("formation view: toggle persists, breakage shows on the board, click opens the cockpit", async ({ page }) => {
    await page.goto("/fleets");
    await expect(page.getByTestId("teams-overview")).toBeVisible();
    // Switch to the formation view — the grid renders per-team minis from the
    // SAME overview payload (one round-trip), and the choice persists.
    await page.getByTestId("teams-view-mode-formation").click();
    await expect(page.getByTestId("teams-formation-grid")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("teams-formation-grid")).toBeVisible();
    // Breakage is visible on the board: the sick team's missing post renders
    // its ring on the mini (SVG present) without opening the cockpit.
    const sick = page.getByTestId(`teams-formation-${ABNORMAL}`);
    await expect(sick).toBeVisible();
    await expect(sick.locator("svg circle")).toHaveCount(2);
    // Clicking a mini formation deep-links into that cockpit.
    await page.getByTestId(`teams-formation-${OK}`).click();
    await expect(page).toHaveURL(new RegExp(`/fleets/${OK}$`));
    await expect(page.getByTestId("fleet-detail")).toContainText("OK Team");
  });

  test("formation view degrades independently of the card list (2.3)", async ({ page }) => {
    // Break ONLY the overview read: the formation view names it with a retry,
    // the card list keeps rendering (three-source independent degradation).
    await page.route("**/api/fleets/overview", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await page.goto("/fleets");
    await expect(page.getByTestId("teams-overview")).toBeVisible();
    await page.getByTestId("teams-view-mode-formation").click();
    await expect(page.getByTestId("teams-formation-error")).toBeVisible();
    // Cards still render from the roster source.
    await page.getByTestId("teams-view-mode-cards").click();
    await expect(page.getByTestId("teams-cards")).toBeVisible();
    await expect(page.getByTestId(`teams-card-${OK}`)).toBeVisible();
  });

  test("hub copilot: opens on the fleets line, honestly unfocused without the architect", async ({ page }) => {
    await page.goto("/fleets");
    await expect(page.getByTestId("teams-overview")).toBeVisible();
    // The dock opens on the /fleets route (the hub line). No architect pack is
    // installed in this fixture → the iframe loads WITHOUT a preset override
    // (honest unfocused, spec: 架构师未装如实降级).
    await page.getByTestId("copilot-fab").click();
    await expect(page.getByTestId("copilot-dock")).toBeVisible();
    const src = await page.getByTestId("copilot-frame").getAttribute("src");
    expect(src).toContain("embed=copilot");
    expect(src).toContain("board=fleets");
    expect(src).not.toContain("preset=");
  });
});
