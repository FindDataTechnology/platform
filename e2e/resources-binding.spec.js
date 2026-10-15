import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { gotoResources, tempStoreDirs } from "./helpers.js";

// Bound charts on the resources page (openspec: add-chart-data-binding 4.2-4.4,
// 6.2).
//
// The upstream is the fake open-data MCP from the webServer command (a real
// streamable-http server on a fixed port), installed here as an ordinary
// registry-origin extension: the refresh path then runs END TO END — resolve
// the endpoint from the installed config, mint the bearer from the stored
// credential, call the tool, diff, write, broadcast, redraw — with no model and
// no network.
//
// The fake carries one scenario at a time (it is one process), so this file
// runs serially and rewinds the scenario between tests.

const FAKE_MCP_PORT = Number(process.env.E2E_FAKE_MCP_PORT) || 3199;
const FAKE_MCP = `http://127.0.0.1:${FAKE_MCP_PORT}`;

const M0_POINTS = [
  { date: "2026-01-01", value: 7.1, unit: "%", source_used: "pboc" },
  { date: "2026-02-01", value: 6.6, unit: "%", source_used: "pboc" },
  { date: "2026-03-01", value: 6.9, unit: "%", source_used: "pboc" },
];
const _M0_PLUS_APRIL = [...M0_POINTS, { date: "2026-04-01", value: 7.4, unit: "%", source_used: "pboc" }];

// The chart the model "drew" from the call: its values are NOT the call's, so
// nothing is inferred and the binding comes from the user's confirmation.
const CHART_OPTION = {
  title: { text: "E2E 绑定图表" },
  xAxis: { type: "category", data: ["2026-01", "2026-02", "2026-03"] },
  yAxis: { type: "value" },
  series: [{ name: "M0", type: "line", data: [1, 2, 3] }],
};
const CANDIDATE = {
  name: "mcp__fd-open-data-mcp__read_series",
  args: { concept_id: "M0_YOY", entity_type: "country", entity_id: "CN" },
  result: JSON.stringify({ concept_id: "M0_YOY", points: M0_POINTS }),
};

test.describe.configure({ mode: "serial" });

function db() {
  return new Database(tempStoreDirs().db);
}

let chartId = null;
let bindingId = null;

async function control(body) {
  const res = await fetch(`${FAKE_MCP}/__control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
  return res.json();
}

test.beforeAll(async () => {
  // Install the fake upstream the way a user installs a market server: an
  // extension row pointing at its endpoint plus a registry credential, which is
  // the same pair the dsh child's MCP entries carry.
  const handle = db();
  const now = new Date().toISOString();
  handle
    .prepare(
      `INSERT OR REPLACE INTO extension_configs (id, name, type, config_json, enabled, source, origin, locked, permissions, required_groups, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      "fd-open-data-mcp",
      "mcp",
      JSON.stringify({ url: `${FAKE_MCP}/mcp`, credentialRef: "registry" }),
      1,
      "user",
      "user",
      0,
      null,
      null,
      now,
      now,
    );
  handle
    .prepare(
      `INSERT OR REPLACE INTO user_registry_credentials (email, token, expires_at, stale, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("machine-owner", "e2e-fake-token", null, 0, "paste", now);

  // The chart, with its same-turn call retained as a candidate.
  chartId = crypto.randomUUID();
  const payload = JSON.stringify(CHART_OPTION);
  handle
    .prepare(
      `INSERT INTO resources (id, type, title, source, session_id, session_title, message_id,
         payload, binding_candidates, content_hash, created_at, updated_at, last_seen_at, seeded)
       VALUES (@id, 'chart', @title, 'auto', NULL, 'E2E 会话', NULL,
         @payload, @candidates, @hash, @now, @now, @now, 0)`,
    )
    .run({
      id: chartId,
      title: CHART_OPTION.title.text,
      payload,
      candidates: JSON.stringify([CANDIDATE]),
      hash: crypto.createHash("sha256").update(payload).digest("hex"),
      now,
    });
  handle.close();
  await control({ scenario: "monthly", failAll: false, resetCalls: true });
});

test.afterAll(async () => {
  await control({ failAll: false, scenario: "monthly" }).catch(() => {});
  // Leave the shared store as this spec found it: resources-page.spec.js asserts
  // an empty library and an exact card count, and this file seeds one chart plus
  // its upstream into the same store the webServer owns.
  const handle = db();
  handle.prepare("DELETE FROM resources WHERE id = ?").run(chartId);
  handle.prepare("DELETE FROM chart_bindings WHERE server = ?").run("fd-open-data-mcp");
  handle.prepare("DELETE FROM chart_point_revisions WHERE binding_id NOT IN (SELECT id FROM chart_bindings)").run();
  handle.prepare("DELETE FROM chart_series_points WHERE binding_id NOT IN (SELECT id FROM chart_bindings)").run();
  handle.prepare("DELETE FROM chart_refreshes WHERE binding_id NOT IN (SELECT id FROM chart_bindings)").run();
  handle.prepare("DELETE FROM extension_configs WHERE name = ?").run("fd-open-data-mcp");
  handle.prepare("DELETE FROM user_registry_credentials WHERE email = ?").run("machine-owner");
  handle.close();
});

// Reads the list the page itself is rendering, through the e2e seam.
async function storedResource(page) {
  return page.evaluate((id) => {
    const store = window.__resourcesStore;
    return store?.getState().items.find((item) => item.id === id) ?? null;
  }, chartId);
}

test("an unbound chart offers the confirmation path and shows no binding affordances", async ({ page }) => {
  await gotoResources(page);
  const card = page.locator(`[data-resource-id="${chartId}"]`);
  await expect(card.getByTestId("echart").locator("canvas")).toHaveCount(1, { timeout: 20_000 });
  await expect(card.getByTestId("binding-bar")).toHaveCount(0);
  await expect(card.getByTestId("binding-stale")).toHaveCount(0);
  await expect(card.getByTestId("binding-refresh")).toHaveCount(0);
  await expect(card.getByTestId("binding-bind-open")).toBeVisible();
});

test("confirming a candidate binds the chart, and a manual refresh redraws it", async ({ page }) => {
  await gotoResources(page);
  const card = page.locator(`[data-resource-id="${chartId}"]`);
  await card.getByTestId("binding-bind-open").click();
  // The candidate is offered with its exact tool name and arguments.
  await expect(card.getByTestId("binding-picker")).toContainText("read_series");
  await expect(card.getByTestId("binding-picker")).toContainText("M0_YOY");
  await card.getByTestId("binding-pick-attach-0").click();

  const bar = card.getByTestId("binding-bar");
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId("binding-source")).toContainText("fd-open-data-mcp · read_series");
  await expect(bar.getByTestId("binding-stale")).toHaveCount(0);
  bindingId = await bar.getAttribute("data-binding-id");
  expect(bindingId).toBeTruthy();

  await bar.getByTestId("binding-refresh").click();
  await expect(bar.getByTestId("binding-notice")).toContainText(/Updated|up to date/i);

  // The payload was regenerated from the store: the chart's own values are gone,
  // replaced by the fake's series — and the canvas is still one.
  await expect
    .poll(async () => {
      const resource = await storedResource(page);
      const option = resource?.payload ? JSON.parse(resource.payload) : null;
      return option?.series?.[0]?.data;
    }, { timeout: 20_000 })
    .toEqual([7.1, 6.6, 6.9]);
  const resource = await storedResource(page);
  expect(JSON.parse(resource.payload).xAxis.data).toEqual(["2026-01", "2026-02", "2026-03"]);
  expect(JSON.parse(resource.payload).title).toEqual(CHART_OPTION.title);
  await expect(bar.getByTestId("binding-periods")).toContainText("3");
  await expect(card.getByTestId("echart").locator("canvas")).toHaveCount(1);
});

test("the data-period filter slices the stored series and 全部 renders every period", async ({ page }) => {
  // Grow the stored series to 30 monthly periods, then check the three windows
  // against the count the page actually renders.
  // 30 monthly periods ending at a fixed month, so the windows are exact: the
  // filter measures back from the newest STORED period, not from today.
  const LAST = { year: 2026, month: 9 };
  await control({
    points: Array.from({ length: 30 }, (_, index) => {
      const monthIndex = LAST.year * 12 + (LAST.month - 1) - (29 - index);
      const year = Math.floor(monthIndex / 12);
      const month = String((monthIndex % 12) + 1).padStart(2, "0");
      return { date: `${year}-${month}-01`, value: 5 + index / 10, unit: "%", source_used: "pboc" };
    }),
  });
  await gotoResources(page);
  const card = page.locator(`[data-resource-id="${chartId}"]`);
  await card.getByTestId("binding-refresh").click();
  await expect
    .poll(async () => (await storedResource(page))?.bindings?.[0]?.periods, { timeout: 20_000 })
    .toBe(30);

  const shown = card.getByTestId("binding-periods-shown");
  // Default is the recent window, so the chart opens on a readable slice.
  await expect(shown).toHaveAttribute("data-shown", "12");
  await card.getByTestId("binding-period-6m").click();
  await expect(shown).toHaveAttribute("data-shown", "6");
  await card.getByTestId("binding-period-all").click();
  await expect(shown).toHaveAttribute("data-shown", "30");
  await card.getByTestId("binding-period-1y").click();
  await expect(shown).toHaveAttribute("data-shown", "12");
});

test("a failed refresh keeps the last good render and marks the binding stale", async ({ page }) => {
  await control({ failAll: true });
  await gotoResources(page);
  const card = page.locator(`[data-resource-id="${chartId}"]`);
  const before = await storedResource(page);
  await card.getByTestId("binding-refresh").click();

  const bar = card.getByTestId("binding-bar");
  await expect(bar.getByTestId("binding-stale")).toBeVisible({ timeout: 20_000 });
  // The reason is localized and specific, not a raw server string.
  await expect(bar.getByTestId("binding-stale")).toContainText(/unreachable|不可达|inaccesible|injoignable|到達/);
  const after = await storedResource(page);
  expect(after.payload).toBe(before.payload);
  // The source line still reports the data's age instead of hiding it.
  await expect(bar.getByTestId("binding-source")).toContainText("fd-open-data-mcp");
  await expect(card.getByTestId("echart").locator("canvas")).toHaveCount(1);
  await control({ failAll: false });
});

test("the timeline lists what each refresh did, and as-of view returns in one action", async ({ page }) => {
  await gotoResources(page);
  const card = page.locator(`[data-resource-id="${chartId}"]`);
  await card.getByTestId("binding-timeline-toggle").click();
  const timeline = card.getByTestId("binding-timeline");
  await expect(timeline).toBeVisible();

  // Both refreshes are there: the successful one with its counts, the failed one
  // with its outcome (the timeline is the record of what the chart has been).
  await expect(timeline.locator('[data-testid="timeline-row"][data-outcome="ok"]').first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(timeline.locator('[data-testid="timeline-row"][data-outcome="error"]').first()).toBeVisible();
  const okRow = timeline.locator('[data-testid="timeline-row"][data-outcome="ok"]').first();

  // Observation-time filter: a 24-hour window still contains this run's rows.
  await timeline.getByTestId("timeline-filter-24h").click();
  await expect(timeline.locator('[data-testid="timeline-row"]').first()).toBeVisible();
  await timeline.getByTestId("timeline-filter-all").click();

  // As-of: the historical view is visibly distinguished, and one action returns.
  await okRow.getByTestId("timeline-view-asof").click();
  await expect(card.getByTestId("asof-banner")).toBeVisible();
  await expect(card.getByTestId("echart").locator("canvas")).toHaveCount(1);
  await expect(timeline.getByTestId("timeline-asof-banner")).toBeVisible();
  await card.getByTestId("asof-return").click();
  await expect(card.getByTestId("asof-banner")).toHaveCount(0);
});

test("a scheduled refresh redraws an open chart without a reload", async ({ page, request }) => {
  // Arm the binding from the page's own API (the real path — the rule change
  // resyncs the scheduler), with a seconds-granularity cron the harness can wait
  // for; the fake's next read carries one period the store has never seen.
  await control({
    points: Array.from({ length: 31 }, (_, index) => {
      const monthIndex = 2026 * 12 + 9 - (30 - index); // 2024-04 .. 2026-10
      const year = Math.floor(monthIndex / 12);
      const month = String((monthIndex % 12) + 1).padStart(2, "0");
      return { date: `${year}-${month}-01`, value: 5 + index / 10, unit: "%", source_used: "pboc" };
    }),
  });
  await request.patch(`http://127.0.0.1:${process.env.E2E_PORT || 3100}/api/resources/${chartId}/bindings/${bindingId}/refresh-rule`, {
    data: { refreshRule: { cron: "*/5 * * * * *" } },
  });

  await gotoResources(page);
  const card = page.locator(`[data-resource-id="${chartId}"]`);
  await expect(card.getByTestId("binding-bar")).toBeVisible();
  const before = await storedResource(page);
  const beforeCount = before.bindings[0].periods;

  // No click, no reload: the timer fires and the broadcast refetches the list.
  await expect
    .poll(async () => (await storedResource(page))?.bindings?.[0]?.periods ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(beforeCount);
  const after = await storedResource(page);
  const option = JSON.parse(after.payload);
  expect(option.xAxis.data).toContain("2026-10");
  await expect(card.getByTestId("echart").locator("canvas")).toHaveCount(1);

  // Disarm: a seconds-timer left running would keep the suite noisy.
  await request.patch(`http://127.0.0.1:${process.env.E2E_PORT || 3100}/api/resources/${chartId}/bindings/${bindingId}/refresh-rule`, {
    data: { refreshRule: null },
  });
});

test("an older cell hides the whole bound-chart surface without an error", async ({ page }) => {
  // A cell older than this capability sends resources without `bindings` (and
  // 404s the binding routes). The page must degrade invisibly.
  await page.route("**/api/resources?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const items = (body.items ?? []).map(({ bindings, bindingRefs, ...rest }) => rest);
    await route.fulfill({ response, json: { ...body, items } });
  });
  await page.route("**/api/resources/*/candidates", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));

  await gotoResources(page);
  const card = page.locator(`[data-resource-id="${chartId}"]`);
  await expect(card.getByTestId("echart").locator("canvas")).toHaveCount(1, { timeout: 20_000 });
  await expect(card.getByTestId("binding-bar")).toHaveCount(0);
  await expect(card.getByTestId("binding-bind-open")).toHaveCount(0);
  await expect(page.getByTestId("resources-error")).toHaveCount(0);
  // Rename/delete stay usable: the degradation touches only the new surface.
  await expect(card.getByTestId("resource-rename")).toBeVisible();
});