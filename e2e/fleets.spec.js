import { test, expect } from "@playwright/test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pinLocaleEn, spawnTestServer } from "./helpers.js";

// Fleets surface (openspec: agent-fleet-core 3.x + 2.4):
//   - nav reachability + the org-tree board renders from a stubbed detail with
//     every derived badge (on_duty/missing/vacant/passive) and evidence
//   - the composer (编队器) walks three-post creation with correct payloads,
//     including the dense-cadence confirm gate
//   - the real auth-off server answers /api/fleets read+write
//   - a spawned forward-auth server enforces ownership (403 cross-owner, 401
//     anonymous)

// ── shared fixtures ──────────────────────────────────────────────────────────

const FLEET_ID = "fleet_demo";

function memberFixture(id, over = {}) {
  return {
    id,
    fleetId: FLEET_ID,
    title: over.title ?? id,
    parentId: over.parentId ?? null,
    target: over.target ?? { kind: "persona", id: "p1", label: "甲" },
    kpiSlots: over.kpiSlots ?? [],
    cadence: over.cadence ?? null,
    sortKey: over.sortKey ?? 0,
    createdAt: 0,
    updatedAt: 0,
    taskId: over.taskId ?? null,
    status: over.status ?? "on_duty",
    statusReason: over.statusReason ?? "",
    evidence: over.evidence ?? { lastRunAt: null, nextRunAt: null, staleWindowMs: null, latestReportAt: null, hitWindow: null },
    latestReport: over.latestReport ?? null,
    reportTimeline: over.reportTimeline ?? [],
    // Turn outcome + skip evidence (fix-fleet-turn-veracity): null/zero by
    // default so existing fixtures stay byte-identical.
    lastTurn: over.lastTurn ?? null,
    consecutiveFailures: over.consecutiveFailures ?? 0,
    skippedRounds: over.skippedRounds ?? 0,
  };
}

const SHOP_REPORT = {
  id: "r_shop_2",
  at: 1790000000000,
  summary: "Big promo day",
  source: "self",
  sessionId: "cron-shop",
  slots: [
    { key: "sales_week", label: "Sales", unit: "$", value: 309, note: "+1%", trend: { direction: "up", deltaValue: 29 } },
  ],
  undeclaredKeys: [],
  metricsAll: { sales_week: { value: 309 } },
  blockers: [],
};

const DEMO_DETAIL = {
  fleet: { id: FLEET_ID, name: "Demo Fleet", state: "active", createdAt: 0, updatedAt: 0 },
  members: [
    memberFixture("ceo", { title: "CEO", status: "on_duty", statusReason: "recent execution within tolerance" }),
    memberFixture("ops", {
      title: "Ops",
      parentId: "ceo",
      status: "missing",
      statusReason: "no report for over the tolerance window (6h)",
      evidence: { lastRunAt: new Date().toISOString(), nextRunAt: null, staleWindowMs: 21600000, latestReportAt: 1, hitWindow: "report" },
      cadence: { cron: "0 * * * *", tz: null, promptTemplate: "x", enabled: true },
    }),
    memberFixture("shop", {
      title: "Shop",
      parentId: "ceo",
      status: "vacant",
      statusReason: "target object no longer exists",
      cadence: { cron: "0 9 * * *", tz: null, promptTemplate: "x", enabled: true },
      kpiSlots: [{ key: "sales_week", label: "Sales", unit: "$" }],
      latestReport: SHOP_REPORT,
      reportTimeline: [
        { id: "r_shop_2", at: 1790000000000, summary: "Big promo day", metrics: { sales_week: { value: 309 } }, blockers: [], resources: [], source: "self", sessionId: "cron-shop" },
        { id: "r_shop_1", at: 1789900000000, summary: "Slow week", metrics: { sales_week: { value: 280 } }, blockers: [], resources: [], source: "self", sessionId: "cron-shop" },
      ],
    }),
    memberFixture("assist", {
      title: "Assist",
      parentId: "ceo",
      target: { kind: "a2a", id: "remote", label: "Remote" },
      status: "passive",
      statusReason: "no cadence",
      latestReport: { id: "r_a2a", at: 1790000100000, summary: "remote turn ok", source: "derived", sessionId: "cron-a2a", slots: [], undeclaredKeys: [], metricsAll: {}, blockers: [] },
    }),
  ],
  statusCounts: { on_duty: 1, missing: 1, vacant: 1, passive: 1 },
};

// ── board render (stubbed API) ───────────────────────────────────────────────

test.describe("fleets board", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Demo Fleet", state: "active", memberCount: 4, statusCounts: DEMO_DETAIL.statusCounts }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(DEMO_DETAIL) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/runs**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
    );
  });

  test("nav item reaches the fleets page", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByTestId("nav-fleets")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("nav-fleets").click();
    await expect(page.getByTestId("fleets-page")).toBeVisible();
  });

  test("cold load shows placeholders, never the empty copy (polish-web-surfaces)", async ({ page }) => {
    // Same stub as the shared beforeEach, but DELAYED so the loading frame is
    // observable. (continue() would bypass the stub and hit the real server,
    // which has no demo fleet.)
    await page.route("**/api/fleets", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Demo Fleet", state: "active", memberCount: 4, statusCounts: DEMO_DETAIL.statusCounts }] }),
      });
    });
    await page.goto("/fleets");
    await expect(page.getByTestId("fleets-page")).toBeVisible({ timeout: 15000 });
    // In flight: placeholders stand in; the empty copy must not appear.
    await expect(page.getByTestId("fleets-loading")).toBeVisible();
    await expect(page.getByTestId("fleets-empty")).toHaveCount(0);
    // Once it lands: the list replaces the placeholders.
    await expect(page.getByTestId("fleet-card-fleet_demo")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("fleets-loading")).toHaveCount(0);
  });

  test("org tree renders depth-ordered posts with derived badges", async ({ page }) => {
    // Deep link to the cockpit (bare /fleets is the overview now).
    await page.goto(`/fleets/${FLEET_ID}`);
    await expect(page.getByTestId("fleets-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("fleet-card-fleet_demo")).toBeVisible();

    // Undeclared orchestration ⇒ zero canvas noise (agent-fleet-cockpit v2:
    // the orchestration area — canvas included — appears only when declared).
    await expect(page.getByTestId("fleet-canvas")).toHaveCount(0);

    const tree = page.getByTestId("fleets-tree");
    await expect(tree.getByTestId("member-card-ceo")).toBeVisible();
    await expect(tree.getByTestId("member-status-ceo")).toHaveText("OK");
    await expect(tree.getByTestId("member-status-ops")).toHaveText("Overdue");
    await expect(tree.getByTestId("member-status-shop")).toHaveText("Vacant");
    await expect(tree.getByTestId("member-status-assist")).toHaveText("On call");

    // Depth indentation: children of the CEO sit 20px deeper than the CEO.
    const lefts = await tree.evaluate((el) => {
      const ids = ["ceo", "ops", "shop", "assist"];
      return ids.map((id) => el.querySelector(`[data-testid="member-card-${id}"]`)?.getBoundingClientRect().left ?? -1);
    });
    expect(lefts[1] - lefts[0]).toBeGreaterThan(10);
    expect(lefts[2] - lefts[0]).toBeGreaterThan(10);
    expect(lefts[3] - lefts[0]).toBeGreaterThan(10);

    // Evidence rides on the badge title (the "why missing" hover) — the dual
    // window names which one fired.
    await expect(tree.getByTestId("member-status-ops")).toHaveAttribute("title", /no report for over the tolerance window/);

    // Report lane: KPI slot chip with value + system trend, summary line, and
    // the a2a execution-summary badge.
    const slotChip = tree.getByTestId("kpi-slot-shop-sales_week");
    await expect(slotChip).toBeVisible();
    await expect(slotChip).toContainText("309");
    await expect(slotChip.locator(".text-success, .text-destructive")).toContainText("↑+29");
    await expect(tree.getByTestId("member-summary-shop")).toContainText("Big promo day");
    await expect(tree.getByTestId("member-derived-badge-assist")).toContainText("not self-reported");

    // The report drawer: latest block + timeline rows + session jump link.
    await page.getByTestId("member-report-drawer-shop").click();
    const drawer = page.getByTestId("report-drawer-latest");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("Big promo day");
    await expect(page.getByTestId("report-row-r_shop_2")).toContainText("309");
    await expect(page.getByTestId("report-row-r_shop_1")).toContainText("Slow week");
    await expect(page.getByTestId("report-row-r_shop_2").getByRole("button", { name: "Source session" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });
});

// ── composer walkthrough (stubbed API) ───────────────────────────────────────

test.describe("fleet composer", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
  });

  test("creates a fleet and three posts with dense-cadence confirm", async ({ page }) => {
    const created = { fleet: null, members: [] };
    let memberCount = 0;
    await page.route("**/api/fleets", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ fleets: created.fleet ? [{ id: created.fleet.id, name: created.fleet.name, state: "active", memberCount }] : [] }),
        });
      }
      const body = route.request().postDataJSON();
      created.fleet = { id: FLEET_ID, name: body.name, state: "active" };
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ fleet: created.fleet }) });
    });
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleet: created.fleet, members: created.members, statusCounts: {} }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/members`, async (route) => {
      const body = route.request().postDataJSON();
      if (
        body.cadence?.cron === "*/5 * * * *" &&
        body.confirmed !== true
      ) {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "cadence fires more often than every 10 minutes", code: "cadence_confirmation_required" }),
        });
      }
      memberCount += 1;
      const m = memberFixture(`m${memberCount}`, {
        title: body.title,
        target: { kind: body.targetKind, id: body.targetId, label: body.targetId },
        cadence: body.cadence ?? null,
        parentId: body.parentId ?? null,
        status: body.cadence ? "on_duty" : "passive",
      });
      created.members.push(m);
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ member: m, reconcile: {} }) });
    });
    await page.route("**/api/catalog", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          agents: [
            { id: "persona-ecom", mode: "chat", name: "Ecom Agent" },
            { id: "persona-ops", mode: "chat", name: "Ops Agent" },
            { id: "remote-svc", mode: "a2a", name: "Remote Service" },
          ],
        }),
      }),
    );
    await page.route("**/api/clusters/mine", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ clusters: [{ clusterId: "dyn_ops", name: "Ops Cluster" }] }) }),
    );

    await page.goto("/fleets");
    await expect(page.getByTestId("fleets-page")).toBeVisible({ timeout: 15000 });

    // Create the fleet.
    await page.getByTestId("fleet-create").click();
    await page.getByTestId("fleet-name-input").fill("内容工作室");
    await page.getByTestId("fleet-create-submit").click();
    await expect(page.getByTestId("fleet-detail")).toContainText("内容工作室", { timeout: 10000 });

    // Post 1: CEO persona, hourly cadence.
    await page.getByTestId("member-create").click();
    await page.getByTestId("member-title-input").fill("CEO");
    await page.getByTestId("member-kind-select").selectOption("persona");
    await page.getByTestId("member-target-select").selectOption("persona-ops");
    await page.getByTestId("member-cadence-mode").selectOption("hourly");
    await page.getByTestId("member-cadence-prompt").fill("巡视全队并汇总。");
    await page.getByTestId("member-create-submit").click();
    await expect(page.getByTestId("member-create-submit")).toBeHidden({ timeout: 10000 });

    // Post 2: passive cluster post under the CEO.
    await page.getByTestId("member-create").click();
    await page.getByTestId("member-title-input").fill("集群岗");
    await page.getByTestId("member-kind-select").selectOption("cluster");
    await page.getByTestId("member-target-select").selectOption("dyn_ops");
    await page.getByTestId("member-parent-select").selectOption("m1");
    await page.getByTestId("member-create-submit").click();
    await expect(page.getByTestId("member-create-submit")).toBeHidden({ timeout: 10000 });

    // Post 3: dense custom cron (*/5) — the gate fires, confirm re-posts.
    await page.getByTestId("member-create").click();
    await page.getByTestId("member-title-input").fill("高频哨兵");
    await page.getByTestId("member-kind-select").selectOption("a2a");
    await page.getByTestId("member-target-select").selectOption("remote-svc");
    await page.getByTestId("member-cadence-mode").selectOption("custom");
    await page.getByTestId("member-cadence-cron").fill("*/5 * * * *");
    await page.getByTestId("member-cadence-prompt").fill("哨兵巡检");
    await page.getByTestId("member-create-submit").click();
    await expect(page.getByTestId("dense-confirm")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("dense-confirm-submit").click();
    await expect(page.getByTestId("dense-confirm")).toBeHidden({ timeout: 10000 });

    // Payloads landed as the spec pins them.
    expect(created.members).toHaveLength(3);
    expect(created.members[0].title).toBe("CEO");
    expect(created.members[0].target.kind).toBe("persona");
    expect(created.members[0].cadence.cron).toBe("0 * * * *");
    expect(created.members[1].target.kind).toBe("cluster");
    expect(created.members[1].parentId).toBe("m1");
    expect(created.members[1].cadence).toBeNull();
    expect(created.members[2].cadence.cron).toBe("*/5 * * * *");
  });
});

// ── cockpit aggregate view (agent-fleet-templates) ───────────────────────────

test.describe("fleet cockpit", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Demo Fleet", state: "paused", memberCount: 1, openDecisions: 1 }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          fleet: {
            id: FLEET_ID, name: "Demo Fleet", state: "paused",
            sourceTemplate: { packId: "pack_tpl", version: "1.0.0" },
          },
          members: [
            memberFixture("ceo", { title: "CEO", status: "on_duty", kpiSlots: [{ key: "sales_week", label: "Sales" }], latestReport: SHOP_REPORT }),
            memberFixture("shop", { title: "Shop", parentId: "ceo", status: "missing" }),
          ],
          statusCounts: { on_duty: 1, missing: 1 },
          decisions: [
            { id: "d1", question: "Publish early?", severity: "high", state: "open", submittedAt: 1790000000000, options: [], memberTitle: "Shop" },
          ],
          openDecisions: 1,
          stream: [
            { memberId: "shop", title: "Shop", status: "missing", latestReport: null },
            { memberId: "ceo", title: "CEO", status: "on_duty", latestReport: SHOP_REPORT },
          ],
          health: { onDuty: 1, paused: 0, missing: 1, vacant: 0, passive: 0, total: 2 },
          template: { packId: "pack_tpl", instantiatedVersion: "1.0.0", latestVersion: "2.0.0", updateAvailable: true },
        }),
      }),
    );
  });

  test("await-start banner, decision banner, health chips, stream, newer notice", async ({ page }) => {
    // Deep link to the cockpit (bare /fleets is the overview now).
    await page.goto(`/fleets/${FLEET_ID}`);
    await expect(page.getByTestId("fleets-page")).toBeVisible({ timeout: 15000 });
    // The paused template fleet shows the start banner, not the plain resume.
    await expect(page.getByTestId("fleet-await-start")).toBeVisible();
    await expect(page.getByTestId("fleet-start")).toBeVisible();
    await expect(page.getByTestId("fleet-decision-banner")).toContainText("1 awaiting you");
    await expect(page.getByTestId("fleet-decision-banner")).toContainText("Publish early?");
    await expect(page.getByTestId("fleet-health")).toContainText("OK: 1");
    await expect(page.getByTestId("fleet-health")).toContainText("Overdue: 1");
    await expect(page.getByTestId("fleet-template-newer")).toContainText("2.0.0");
    // Stream: the missing post sits first; the reporting post shows its summary.
    await expect(page.getByTestId("fleet-stream")).toBeVisible();
    const rows = page.getByTestId("fleet-stream").locator("[data-testid^='stream-']");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveAttribute("data-testid", "stream-shop");
    await expect(page.getByTestId("stream-ceo")).toContainText("Big promo day");
  });
});

// ── decision queue drawer (agent-fleet-decision-lane) ───────────────────────

test.describe("fleet decision queue", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    const open = [
      {
        id: "d1",
        fleetId: FLEET_ID,
        memberId: "shop",
        memberTitle: "Shop",
        memberDeleted: false,
        pendingDelivery: false,
        question: "Publish the video early?",
        options: [
          { value: "now", label: "Publish now" },
          { value: "fri", label: "Publish Friday" },
        ],
        severity: "high",
        suggestedDeadline: "within 48h",
        recommendation: "fri",
        state: "open",
        resolution: null,
        sourceSessionId: "sess-src",
        submittedAt: 1790000000000,
        resolvedAt: null,
        deliveredAt: null,
      },
    ];
    let current = open;
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Demo Fleet", state: "active", memberCount: 1, openDecisions: current.filter((d) => d.state === "open").length }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          fleet: { id: FLEET_ID, name: "Demo Fleet", state: "active", createdAt: 0, updatedAt: 0 },
          members: [memberFixture("shop", { title: "Shop" })],
          statusCounts: { passive: 1 },
          openDecisions: current.filter((d) => d.state === "open").length,
        }),
      }),
    );
    await page.route(new RegExp(`/api/fleets/${FLEET_ID}/decisions`), (route) => {
      if (route.request().method() === "GET") {
        const all = new URL(route.request().url()).searchParams.get("state") === "all";
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            decisions: all ? current : current.filter((d) => d.state === "open"),
            openCount: current.filter((d) => d.state === "open").length,
            decisionPolicy: { expiryHours: 72, dailyCapPerMember: 10 },
          }),
        });
      }
      const url = route.request().url();
      const approve = url.endsWith("/approve");
      current = current.map((d) =>
        d.id === "d1"
          ? {
              ...d,
              state: approve ? "approved" : d.state,
              pendingDelivery: approve,
              resolution: approve ? { kind: "approve", choice: "fri", note: null, by: "owner@test", at: 1790000001000 } : null,
            }
          : d,
      );
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ decision: current[0] }) });
    });
  });

  test("badge opens the queue; approve flips the item to awaiting delivery", async ({ page }) => {
    // Deep link: the cockpit is the per-fleet face — bare /fleets is now the
    // cross-team overview (agent-teams-first-class).
    await page.goto(`/fleets/${FLEET_ID}`);
    await expect(page.getByTestId("fleets-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("decisions-open")).toContainText("1 awaiting you");
    await page.getByTestId("decisions-open").click();

    const item = page.getByTestId("decision-d1");
    await expect(item).toBeVisible();
    await expect(page.getByTestId("decision-question-d1")).toContainText("Publish the video early?");
    await expect(item).toContainText("high");
    await expect(item).toContainText("within 48h");

    await page.getByTestId("decision-choice-d1").selectOption("fri");
    await page.getByTestId("decision-approve-d1").click();
    // The open-only view drops the decided item (the to-do is done); flip to
    // the all-views to see the approved state.
    await page.getByTestId("decisions-show-all").check();
    await expect(page.getByTestId("decision-resolution-d1")).toContainText("Publish Friday", { timeout: 10000 });
    await expect(page.getByTestId("decision-d1")).toContainText("awaiting delivery");
    await expect(page.getByTestId("decision-execute-d1")).toBeVisible();
  });
});

// ── real server, auth-off (the shared webServer) ─────────────────────────────

test.describe("fleets REST on the auth-off server", () => {
  test("read+write round-trip", async ({ request }) => {
    const list = await request.get("/api/fleets");
    expect(list.ok()).toBeTruthy();
    const before = (await list.json()).fleets ?? [];

    const created = await request.post("/api/fleets", { data: { name: "e2e 临时舰队" } });
    expect(created.status()).toBe(201);
    const { fleet } = await created.json();
    expect(fleet.state).toBe("active");

    const detail = await request.get(`/api/fleets/${fleet.id}`);
    expect(detail.ok()).toBeTruthy();
    expect((await detail.json()).members).toEqual([]);

    // Cleanup: dissolve keeps the row but flips state.
    const gone = await request.delete(`/api/fleets/${fleet.id}`);
    expect(gone.ok()).toBeTruthy();
    expect((await gone.json()).fleet.state).toBe("archived");
    expect(((await (await request.get("/api/fleets")).json()).fleets ?? []).length).toBe(before.length + 1);
  });
});

// ── spawned forward-auth server: ownership semantics ────────────────────────

test.describe("fleets ownership under forward auth", () => {
  test.describe.configure({ timeout: 120_000 });

  let BASE;
  let server;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-fleets-auth-"));

  test.beforeAll(async () => {
    const port = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    BASE = `http://127.0.0.1:${port}`;
    server = spawnTestServer({
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        AUTH_MODE: "forward_auth",
        CATALOG_REFRESH_SECS: "0",
        CHAT_HISTORY_STORE_DIR: path.join(tmpRoot, "chat"),
        DOCUMENTS_STORE_DIR: path.join(tmpRoot, "docs"),
        SESSIONS_STORE_DIR: path.join(tmpRoot, "sessions"),
        DB_PATH: path.join(tmpRoot, "app.db"),
        CRON_STORAGE_PATH: tmpRoot,
        DSH_HOME: path.join(tmpRoot, "dsh-home"),
        DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
      },
      storeRoot: tmpRoot,
    });
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      try {
        const r = await fetch(`${BASE}/api/auth/me`);
        if (r.status === 401 || r.ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  test.afterAll(async () => {
    await server?.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("anonymous is 401; bob owns his fleet; the admin cannot write it", async () => {
    const BOB = { "x-forwarded-email": "bob@corp.com", "x-forwarded-groups": "users" };
    const ADMIN = { "x-forwarded-email": "admin@corp.com", "x-forwarded-groups": "admin" };

    const anon = await fetch(`${BASE}/api/fleets`);
    expect(anon.status).toBe(401);

    const created = await fetch(`${BASE}/api/fleets`, {
      method: "POST",
      headers: { "content-type": "application/json", ...BOB },
      body: JSON.stringify({ name: "Bob's fleet" }),
    });
    expect(created.status).toBe(201);
    const { fleet } = await created.json();

    const mine = await fetch(`${BASE}/api/fleets`, { headers: BOB });
    expect(mine.ok).toBeTruthy();
    expect((await mine.json()).fleets.some((f) => f.id === fleet.id)).toBe(true);

    const cross = await fetch(`${BASE}/api/fleets/${fleet.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...ADMIN },
      body: JSON.stringify({ state: "paused" }),
    });
    expect(cross.status).toBe(403);

    const detail = await fetch(`${BASE}/api/fleets/${fleet.id}`, { headers: BOB });
    expect(detail.ok).toBeTruthy();
    expect((await detail.json()).fleet.state).toBe("active");
  });
});

// ── live canvas (agent-fleet-cockpit v2, add-fleet-cockpit-v2 group B) ───────
//
// The canvas renders from the cockpit aggregate (posts as cards + declared
// edges as kind-colored curves + cron/event virtual sources), weighs edges by
// the 24h edgeTraffic, filters implicit supervisor grants, and lights up from
// the fleet_* WS events: started pulses the node and animates the igniting
// edge, ended retires both. Undeclared fleets render no canvas at all.

const CANVAS_FLEET = {
  fleet: {
    id: FLEET_ID,
    name: "Canvas Fleet",
    state: "active",
    orchestration: { mode: "pipeline", edges: [
      { kind: "trigger", to: "ceo", cron: "0 9 * * *" },
      { kind: "handoff", from: "ceo", to: "inv" },
    ] },
  },
  members: [
    memberFixture("ceo", { title: "CEO" }),
    memberFixture("inv", { title: "Invest", parentId: "ceo" }),
    memberFixture("ops", { title: "Ops", parentId: "ceo" }),
  ],
  statusCounts: { on_duty: 3 },
  orchestration: {
    mode: "pipeline",
    constraints: { maxChainDepth: 4, budgetPerEdgeMin: 10 },
    edges: [
      { kind: "trigger", to: "ceo", cron: "0 9 * * *" },
      { kind: "handoff", from: "ceo", to: "inv" },
      { kind: "dispatch", from: "ceo", to: "ops", implicit: true },
    ],
  },
  edgeTraffic: [{ from: "ceo", to: "inv", kind: "handoff", turns: 4, ok: 4, failed: 0 }],
};

test.describe("fleet canvas", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Canvas Fleet", state: "active", memberCount: 3, statusCounts: { on_duty: 3 } }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(CANVAS_FLEET) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/runs**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
    );
  });

  test("renders posts + virtual sources, filters implicit grants, weighs by traffic", async ({ page }) => {
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas).toBeVisible({ timeout: 15000 });

    // 3 post cards + 1 virtual cron source. Status rings ride each post.
    for (const id of ["ceo", "inv", "ops", "cron:0 9 * * *"]) {
      await expect(canvas.getByTestId(`canvas-node-${id}`)).toBeVisible();
    }
    await expect(canvas.getByTestId("canvas-status-ceo")).toBeVisible();

    // Declared edges only: trigger + handoff; the implicit dispatch grant is
    // never drawn (the aggregate banner carries it above).
    // Edges are laid out asynchronously after the canvas mounts; the default
    // 5s expect timeout read 0 on a loaded runner (CI run 42479789722, flaky).
    await expect(canvas.locator(".react-flow__edge")).toHaveCount(2, { timeout: 15000 });
    await expect(canvas.locator('.react-flow__edge[data-id="cron:0 9 * * *→ceo:trigger"]')).toHaveCount(1);
    const handoff = canvas.locator('.react-flow__edge[data-id="ceo→inv:handoff"]');
    await expect(handoff).toHaveCount(1);

    // Traffic weight: 4 hops in 24h → strokeWidth 2.5 (1.5 + sqrt(4)*0.5).
    const style = await handoff.locator("path").first().getAttribute("style");
    expect(style).toMatch(/stroke-width:\s*2\.5/);

    // Minimap + zoom controls are part of the canvas affordance.
    await expect(canvas.locator(".react-flow__minimap")).toBeVisible();
    await expect(canvas.locator(".react-flow__controls")).toBeVisible();
  });

  test("cockpit first-fetch failure self-heals without a manual reload", async ({ page }) => {
    let calls = 0;
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) => {
      calls += 1;
      if (calls === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(CANVAS_FLEET) });
    });
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-ceo")).toBeVisible({ timeout: 10000 });
    await expect.poll(() => calls, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  });

  test("node drag persists per fleet locally; reset restores the seed layout", async ({ page }) => {
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-ceo")).toBeVisible({ timeout: 15000 });

    const posOf = (id) => canvas.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el) => el.style.transform);
    const before = await posOf("ceo");

    // Drag the CEO card by its header (avoid the drag-handle handles).
    const box = await canvas.getByTestId("canvas-node-ceo").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + 8 + 90, { steps: 6 });
    await page.mouse.up();
    await expect(canvas.locator("[data-testid='canvas-reset-layout']")).toBeVisible({ timeout: 5000 });
    const afterDrag = await posOf("ceo");
    expect(afterDrag).not.toEqual(before);

    // Reload: the archived position wins over the layout seed.
    await page.reload();
    const canvas2 = page.getByTestId("fleet-canvas");
    await expect(canvas2.getByTestId("canvas-node-ceo")).toBeVisible({ timeout: 15000 });
    const afterReload = await posOf("ceo");
    expect(afterReload).toEqual(afterDrag);

    // Reset: back to the seed transform, archive cleared (button disappears).
    await canvas2.getByTestId("canvas-reset-layout").click();
    await expect(canvas2.getByTestId("canvas-reset-layout")).toHaveCount(0);
    await expect.poll(async () => posOf("ceo"), { timeout: 5000 }).toEqual(before);
    await page.reload();
    const canvas3 = page.getByTestId("fleet-canvas");
    await expect(canvas3.getByTestId("canvas-node-ceo")).toBeVisible({ timeout: 15000 });
    expect(await posOf("ceo")).toEqual(before);
  });

  test("fleet_turn_started pulses the node and animates the igniting edge; ended retires both", async ({ page }) => {
    let client = null;
    await page.routeWebSocket(/.*/, (ws) => {
      client = ws;
      const server = ws.connectToServer();
      ws.onMessage((data) => server.send(data));
      server.onMessage((data) => ws.send(data));
    });
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-inv")).toBeVisible({ timeout: 15000 });

    // Before: no live ring on inv, no animated edge.
    await expect(canvas.getByTestId("canvas-node-inv")).not.toHaveClass(/border-blue-500/);
    await expect(canvas.locator('.react-flow__edge[data-id="ceo→inv:handoff"].animated')).toHaveCount(0);

    const push = (msg) => client?.send(JSON.stringify(msg));
    push({
      type: "fleet_turn_started",
      fleetId: FLEET_ID,
      memberId: "inv",
      runId: "run_e2e",
      turnId: "turn_e2e",
      parentTurnId: "turn_ceo",
      parentMemberId: "ceo",
      edgeKind: "handoff",
      source: "delegation",
      sessionId: "cron-inv",
      startedAt: Date.now(),
    });
    await expect(canvas.getByTestId("canvas-node-inv")).toHaveClass(/border-blue-500/, { timeout: 5000 });
    await expect(canvas.locator('.react-flow__edge[data-id="ceo→inv:handoff"].animated')).toHaveCount(1);

    push({
      type: "fleet_turn_ended",
      fleetId: FLEET_ID,
      memberId: "inv",
      runId: "run_e2e",
      turnId: "turn_e2e",
      parentTurnId: "turn_ceo",
      parentMemberId: "ceo",
      edgeKind: "handoff",
      source: "delegation",
      sessionId: "cron-inv",
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      status: "ok",
      errorKind: null,
      model: null,
      usage: { input: 10, output: 2 },
    });
    await expect(canvas.getByTestId("canvas-node-inv")).not.toHaveClass(/border-blue-500/, { timeout: 5000 });
    await expect(canvas.locator('.react-flow__edge[data-id="ceo→inv:handoff"].animated')).toHaveCount(0);
  });
});

// ── run timeline (agent-fleet-runs read face → cockpit v2 face 2) ─────────────
//
// The run list filters and pages; the selected run renders as a swimlane
// waterfall (turn bars, chain hops, tool spans joined from the trace store);
// the replay cursor drives the canvas above — scrub to an instant and the
// turns open at that instant light their nodes/edges, release returns live.
// v1-era turns (no runId) never appear: that's the server's list contract.

const RUNS_BODY = {
  total: 2,
  runs: [
    {
      runId: "run_fail", rootSource: "manual", rootMemberId: "inv", rootMemberTitle: "Invest",
      startedAt: 0, endedAt: 500, durationMs: 500, status: "failed", turns: 1, okCount: 0, failedCount: 1,
      usage: { input: 5, output: 1 },
    },
    {
      runId: "run_ok", rootSource: "cron", rootMemberId: "ceo", rootMemberTitle: "CEO",
      startedAt: 1000, endedAt: 4400, durationMs: 3400, status: "ok", turns: 3, okCount: 3, failedCount: 0,
      usage: { input: 300, output: 60 },
    },
  ],
};

const RUN_DETAIL = {
  run: RUNS_BODY.runs[1],
  turns: [
    { id: 1, memberId: "ceo", source: "cron", status: "ok", errorKind: null, error: null, model: "deepseek", startedAt: 1000, endedAt: 2000, sessionId: "cron-ceo", turnId: "t_ceo", runId: "run_ok", parentTurnId: null, edgeKind: null, usage: { input: 100, output: 20 }, traceTurnId: null },
    { id: 2, memberId: "inv", source: "manual", status: "ok", errorKind: null, error: null, model: "deepseek", startedAt: 2200, endedAt: 3200, sessionId: "task-t_inv", turnId: "t_inv", runId: "run_ok", parentTurnId: "t_ceo", edgeKind: "handoff", usage: { input: 100, output: 20 }, traceTurnId: "tr_inv" },
    { id: 3, memberId: "ops", source: "manual", status: "ok", errorKind: null, error: null, model: "deepseek", startedAt: 3400, endedAt: 4400, sessionId: "task-t_ops", turnId: "t_ops", runId: "run_ok", parentTurnId: "t_inv", edgeKind: "fanout", usage: { input: 100, output: 20 }, traceTurnId: null },
  ],
};

// An open run: the cockpit's stop control only exists while a run is still
// running (explore P2-6 — the backend could always stop one, the UI had no
// entry point).
const RUN_OPEN = {
  runId: "run_open", rootSource: "cron", rootMemberId: "ceo", rootMemberTitle: "CEO",
  startedAt: 1000, endedAt: null, durationMs: null, status: "open", turns: 1, okCount: 0, failedCount: 0,
  usage: { input: 40, output: 8 }, stoppedAt: null, stopReason: null,
};

const RUN_OPEN_DETAIL = {
  run: RUN_OPEN,
  turns: [
    { id: 11, memberId: "ceo", source: "cron", status: "ok", errorKind: null, error: null, model: "deepseek", startedAt: 1000, endedAt: 2000, sessionId: "cron-ceo-open", turnId: "t_open_ceo", runId: "run_open", parentTurnId: null, edgeKind: null, usage: { input: 40, output: 8 }, traceTurnId: null },
    { id: 12, memberId: "inv", source: "manual", status: "interrupted", errorKind: null, error: "interrupted", model: "deepseek", startedAt: 2100, endedAt: 2400, sessionId: "task-t_open_inv", turnId: "t_open_inv", runId: "run_open", parentTurnId: "t_open_ceo", edgeKind: "handoff", usage: { input: 0, output: 0 }, traceTurnId: null },
  ],
};

const TRACE_INV = [
  { seq: 1, ts: 2300, method: "session.event", eventType: "tool/call", summary: "call", payload: { event: { data: { callId: "c1", name: "web_search", arguments: "{}" } } } },
  { seq: 2, ts: 2500, method: "session.event", eventType: "tool/result", summary: "result", payload: { event: { data: { callId: "c1", resultText: "ok" } } } },
  { seq: 3, ts: 2600, method: "session.event", eventType: "tool/call", summary: "call", payload: { event: { data: { callId: "c2", name: "save_file", arguments: "{}" } } } },
  { seq: 4, ts: 2900, method: "session.event", eventType: "tool/result", summary: "result", payload: { event: { data: { callId: "c2", resultText: "ok" } } } },
];

test.describe("fleet run stop", () => {
  let cancelCalls = 0;
  test.beforeEach(async ({ page }) => {
    cancelCalls = 0;
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Canvas Fleet", state: "active", memberCount: 3, statusCounts: { on_duty: 3 } }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(CANVAS_FLEET) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/runs?**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 1, runs: [RUN_OPEN] }) }),
    );
    // The detail read reflects the stop once the cancel landed — the same way
    // the real route reads the stamped header back.
    await page.route(`**/api/fleets/${FLEET_ID}/runs/run_open`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          cancelCalls > 0
            ? { run: { ...RUN_OPEN, status: "interrupted", stoppedAt: 2500, stopReason: "owner stop" }, turns: RUN_OPEN_DETAIL.turns }
            : RUN_OPEN_DETAIL,
        ),
      }),
    );
    // The cancel endpoint: the stub records the call and answers like the real
    // route (stamped run + how many in-flight turns it aborted). The follow-up
    // detail read then shows the stopped run, so the pill is assertable.
    await page.route(`**/api/fleets/${FLEET_ID}/runs/run_open/cancel`, async (route) => {
      cancelCalls += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          cancelled: true,
          alreadyStopped: false,
          abortedTurns: 1,
          run: { ...RUN_OPEN, status: "interrupted", stoppedAt: 2500, stopReason: "owner stop" },
        }),
      });
    });
    await page.route(`**/api/fleets/${FLEET_ID}/runs?status=&source=`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ total: 1, runs: [{ ...RUN_OPEN, status: "interrupted", stoppedAt: 2500, stopReason: "owner stop" }] }),
      }),
    );
  });

  test("an open run offers stop; confirming cancels exactly once and the header reports the stop", async ({ page }) => {
    await page.goto(`/fleets/${FLEET_ID}`);
    const runs = page.getByTestId("fleet-runs");
    await expect(runs).toBeVisible({ timeout: 15000 });
    // The newest run is auto-selected on first load, so the detail panel is
    // already open — clicking the row again would TOGGLE it shut.
    const detail = runs.locator("[data-testid^='run-detail-']");
    await expect(detail).toBeVisible();
    const stop = detail.getByTestId("run-stop");
    await expect(stop).toBeVisible();
    await expect(stop).toHaveText("Stop this run");

    // Confirmation is required — the destructive action is never one click.
    await stop.click();
    const dialog = page.getByTestId("confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-variant", "danger");
    await expect(dialog).toContainText("Stop this run?");
    expect(cancelCalls).toBe(0);

    // Cancelling the dialog changes nothing.
    await dialog.getByTestId("confirm-dialog-cancel").click();
    await expect(dialog).toBeHidden();
    expect(cancelCalls).toBe(0);
    await expect(stop).toBeVisible();

    // Confirming stops it: one call, an honest notice, and the stopped pill
    // replaces the button (the run is no longer stoppable).
    await stop.click();
    await page.getByTestId("confirm-dialog").getByTestId("confirm-dialog-confirm").click();
    await expect.poll(() => cancelCalls).toBe(1);
    await expect(runs.getByTestId("run-stop-notice")).toContainText("interrupted 1 in-flight turn");
    await expect(runs.getByTestId("run-stopped")).toContainText("owner stop");
    await expect(runs.getByTestId("run-stop")).toHaveCount(0);
  });
});

test.describe("fleet budget pressure banner", () => {
  const cockpitWith = (budgetPressure) => ({
    ...CANVAS_FLEET,
    members: [memberFixture("ceo", { title: "CEO" })],
    statusCounts: { on_duty: 1, failing: 1 },
    health: { onDuty: 0, paused: 0, missing: 0, vacant: 0, passive: 0, failing: 1, total: 1, budgetPressure },
  });

  const boot = async (page, cockpit) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Canvas Fleet", state: "active", memberCount: 1, statusCounts: { on_duty: 1 } }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(cockpit) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/runs?**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
    );
  };

  test("多岗额度耗尽时说出人数、次数与起点", async ({ page }) => {
    await boot(page, cockpitWith({ members: 3, failures: 41, since: 1794000000000, windowHours: 24 }));
    await page.goto(`/fleets/${FLEET_ID}`);
    const banner = page.getByTestId("fleet-budget-pressure");
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toContainText("41");
    await expect(banner).toContainText("3 post(s)");
    await expect(banner).toContainText("24h");
  });

  test("没有额度压力时不渲染横幅", async ({ page }) => {
    await boot(page, cockpitWith(null));
    await page.goto(`/fleets/${FLEET_ID}`);
    await expect(page.getByTestId("fleet-health")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("fleet-budget-pressure")).toHaveCount(0);
  });
});

test.describe("fleet runs timeline", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Canvas Fleet", state: "active", memberCount: 3, statusCounts: { on_duty: 3 } }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(CANVAS_FLEET) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/runs?**`, (route) => {
      const url = new URL(route.request().url());
      const status = url.searchParams.get("status") ?? "";
      const runs = status ? RUNS_BODY.runs.filter((r) => r.status === status) : RUNS_BODY.runs;
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: runs.length, runs }) });
    });
    await page.route(`**/api/fleets/${FLEET_ID}/runs/run_ok`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(RUN_DETAIL) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/runs/run_fail`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          run: RUNS_BODY.runs[0],
          turns: [
            { id: 9, memberId: "inv", source: "manual", status: "failed", errorKind: "timeout", error: "timed out", model: null, startedAt: 0, endedAt: 500, sessionId: "task-9", turnId: "t_fail", runId: "run_fail", parentTurnId: null, edgeKind: null, usage: { input: 5, output: 1 }, traceTurnId: null },
          ],
        }),
      }),
    );
    await page.route("**/api/trace/turns/tr_inv", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ turnId: "tr_inv", events: TRACE_INV }) }),
    );
  });

  test("list filters by status; selecting a run renders the waterfall with hops and tool spans", async ({ page }) => {
    await page.goto(`/fleets/${FLEET_ID}`);
    const runs = page.getByTestId("fleet-runs");
    await expect(runs).toBeVisible({ timeout: 15000 });

    await expect(runs.getByTestId("runs-total")).toHaveText("2");
    await expect(runs.getByTestId("run-row-run_fail")).toBeVisible();
    await expect(runs.getByTestId("run-row-run_ok")).toBeVisible();

    // status filter narrows the list server-side (the stub honors it).
    await runs.getByTestId("runs-status-filter").selectOption("failed");
    await expect(runs.getByTestId("runs-total")).toHaveText("1");
    await expect(runs.getByTestId("run-row-run_fail")).toBeVisible();
    await expect(runs.getByTestId("run-row-run_ok")).toHaveCount(0);
    await runs.getByTestId("runs-status-filter").selectOption("");

    // Select the ok run: 3 lanes, 3 bars, 2 chain hops, 2 nested tool spans
    // (only t_inv carries a trace; the other turns show none, honestly).
    await runs.getByTestId("run-row-run_ok").click();
    const wf = runs.getByTestId("run-waterfall");
    await expect(wf).toBeVisible();
    for (const m of ["ceo", "inv", "ops"]) await expect(wf.getByTestId(`run-lane-${m}`)).toBeVisible();
    for (const t of ["t_ceo", "t_inv", "t_ops"]) await expect(wf.getByTestId(`run-bar-${t}`)).toBeVisible();
    await expect(wf.locator("[data-testid^='run-hop-']")).toHaveCount(2);
    await expect(wf.locator("[data-testid^='run-span-']")).toHaveCount(2);
    await expect(wf.getByTestId("run-span-c1")).toHaveAttribute("title", /web_search/);
  });

  test("the replay cursor drives the canvas and releases back to live", async ({ page }) => {
    await page.goto(`/fleets/${FLEET_ID}`);
    const runs = page.getByTestId("fleet-runs");
    await expect(runs).toBeVisible({ timeout: 15000 });
    await runs.getByTestId("run-row-run_ok").click();
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-inv")).toBeVisible();

    // No replay yet: nothing pulses.
    await expect(canvas.getByTestId("canvas-node-inv")).not.toHaveClass(/border-blue-500/);

    // Scrub to 60% of the run window (1000 + 0.6*3400 = 3040): t_inv is the
    // only turn open at that instant (2200..3200) — the inv node replays as
    // running and the hop edge animates.
    const slider = runs.getByTestId("runs-replay-slider");
    await slider.fill("60");
    await expect(runs.getByTestId("runs-replaying")).toBeVisible();
    await expect(canvas.getByTestId("canvas-node-inv")).toHaveClass(/border-blue-500/, { timeout: 5000 });
    await expect(canvas.getByTestId("canvas-node-ceo")).not.toHaveClass(/border-blue-500/);
    // SVG <line> has a zero-area bbox, so assert presence, not visibility.
    await expect(runs.getByTestId("run-cursor")).toHaveCount(1);

    // Release: live again, the pulse clears.
    await slider.dispatchEvent("pointerup");
    await expect(runs.getByTestId("runs-replaying")).toHaveCount(0);
    await expect(canvas.getByTestId("canvas-node-inv")).not.toHaveClass(/border-blue-500/, { timeout: 5000 });
  });

  test("long free-form slot values never blow the node card open", async ({ page }) => {
    const LONG = "5 席已报（开源/投资/助理/电商/内容）；CEO 侧复核：26 条连接全为公开数据源，无 github/店铺/券商，但目录中这些服务均存在可执行";
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...CANVAS_FLEET,
          members: CANVAS_FLEET.members.map((m) =>
            m.id === "ceo"
              ? { ...m, kpiSlots: [{ key: "digest", label: "巡视要点" }], latestReport: { id: "r", at: 1, summary: "s", source: "self", sessionId: null, slots: [{ key: "digest", label: "巡视要点", unit: null, value: LONG, trend: null }], undeclaredKeys: [] } }
              : m,
          ),
        }),
      }),
    );
    await page.goto(`/fleets/${FLEET_ID}`);
    const card = page.getByTestId("canvas-node-ceo");
    await expect(card).toBeVisible({ timeout: 15000 });
    const box = await card.boundingBox();
    expect(box.width).toBeLessThanOrEqual(240); // the card's fixed 220px + slack
    // The chip stays one line; the full text rides the title.
    await expect(card.locator("[title*='5 席已报']")).toHaveCount(1);
  });

  test("runs list filters by post", async ({ page }) => {
    await page.goto(`/fleets/${FLEET_ID}`);
    const runs = page.getByTestId("fleet-runs");
    await expect(runs).toBeVisible({ timeout: 15000 });
    await expect(runs.getByTestId("run-row-run_ok")).toBeVisible();
    // run_fail's root post is inv; picking CEO leaves only run_ok (ceo).
    await runs.getByTestId("runs-member-filter").selectOption("ceo");
    await expect(runs.getByTestId("run-row-run_ok")).toBeVisible();
    await expect(runs.getByTestId("run-row-run_fail")).toHaveCount(0);
    await runs.getByTestId("runs-member-filter").selectOption("");
    await expect(runs.getByTestId("run-row-run_fail")).toBeVisible();
  });

  test("timeline auto-selects the newest run on first render", async ({ page }) => {
    await page.goto(`/fleets/${FLEET_ID}`);
    const runs = page.getByTestId("fleet-runs");
    await expect(runs).toBeVisible({ timeout: 15000 });
    // No click — the newest run's waterfall renders by itself.
    await expect(runs.getByTestId("run-waterfall")).toBeVisible({ timeout: 5000 });
  });

  test("a fleet with no runs shows the empty state, not an error", async ({ page }) => {
    await page.route(`**/api/fleets/${FLEET_ID}/runs?**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
    );
    await page.goto(`/fleets/${FLEET_ID}`);
    const runs = page.getByTestId("fleet-runs");
    await expect(runs).toBeVisible({ timeout: 15000 });
    await expect(runs.getByTestId("runs-empty")).toBeVisible();
    await expect(runs.getByTestId("runs-list")).toHaveCount(0);
  });
});

// ── inspector + design mode (cockpit v2 faces 3+4) ──────────────────────────

test.describe("fleet inspector & design mode", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Canvas Fleet", state: "active", memberCount: 3, statusCounts: { on_duty: 3 } }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(CANVAS_FLEET) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/runs**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/members/**/turns**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ turns: [], nextBefore: null }) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/members/**/reports**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ reports: [], nextBefore: null }) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/decisions**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ open: 0, decisions: [] }) }),
    );
  });

  test("clicking a canvas node opens the five-tab inspector; the edge opens the edge inspector", async ({ page }) => {
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-inv")).toBeVisible({ timeout: 15000 });

    await canvas.getByTestId("canvas-node-inv").click();
    const insp = page.getByTestId("inspector-inv");
    await expect(insp).toBeVisible();
    for (const tab of ["overview", "config", "turns", "reports", "decisions"]) {
      await expect(insp.getByTestId(`inspector-tab-${tab}`)).toBeVisible();
    }
    await insp.getByTestId("inspector-close").click();
    await expect(insp).toBeHidden();
    // Let the timeline's auto-select detail fetch settle — its setState wave
    // can replace canvas DOM between query and dispatch.
    await expect(page.getByTestId("fleet-runs").getByTestId("run-waterfall").or(page.getByTestId("runs-empty"))).toBeVisible({ timeout: 5000 }).catch(() => {});

    // Dispatch a bubbling click on the edge's <g> — coordinates are unreliable
    // now that nodes are draggable (a midpoint can land on a draggable card).
    // The canvas may re-render between query and dispatch (auto-select detail
    // fetch), so retry until the drawer opens.
    const edgeInsp = page.getByTestId("edge-inspector");
    for (let i = 0; (await edgeInsp.count()) === 0 && i < 4; i++) {
      await canvas
        .locator('.react-flow__edge[data-id="ceo→inv:handoff"]')
        .evaluate((el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true })))
        .catch(() => {});
      await page.waitForTimeout(400);
    }
    await expect(edgeInsp).toBeVisible();
    await expect(edgeInsp).toContainText("handoff");
    await expect(edgeInsp.getByTestId("edge-inspector-traffic")).toContainText("24h: 4");
  });

  test("inspector turns tab refreshes when the post's turn ends", async ({ page }) => {
    let turnFetches = 0;
    await page.route(`**/api/fleets/${FLEET_ID}/members/**/turns**`, (route) => {
      turnFetches += 1;
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ turns: [{ id: 1, source: "cron", status: "ok", errorKind: null, error: null, model: null, startedAt: 1, endedAt: 2, sessionId: "s" }], nextBefore: null }) });
    });
    let client = null;
    await page.routeWebSocket(/.*/, (ws) => {
      client = ws;
      const server = ws.connectToServer();
      ws.onMessage((data) => server.send(data));
      server.onMessage((data) => ws.send(data));
    });
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-inv")).toBeVisible({ timeout: 15000 });
    await canvas.getByTestId("canvas-node-inv").click();
    const insp = page.getByTestId("inspector-inv");
    await expect(insp).toBeVisible();
    await insp.getByTestId("inspector-tab-turns").click();
    const baseline = turnFetches;

    client?.send(JSON.stringify({
      type: "fleet_turn_ended",
      fleetId: FLEET_ID, memberId: "inv", runId: "run_e2e", turnId: "turn_e2e",
      parentTurnId: null, parentMemberId: null, edgeKind: null, source: "manual",
      sessionId: "s", startedAt: Date.now() - 1000, endedAt: Date.now(),
      status: "ok", errorKind: null, model: null, usage: null,
    }));
    await expect.poll(() => turnFetches, { timeout: 5000 }).toBeGreaterThan(baseline);
  });

  test("inspector delivers now via the task run channel", async ({ page }) => {
    const runs = [];
    await page.route("**/api/cron/cron_task_x/run", (route) => {
      runs.push(route.request().url());
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, state: "queued" }) });
    });
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-inv")).toBeVisible({ timeout: 15000 });

    // CANVAS_FLEET members are fixtures without taskId — inject one on inv's
    // cockpit payload for this test, then open her inspector.
    const insp = page.getByTestId("inspector-inv");
    await canvas.getByTestId("canvas-node-inv").click();
    await expect(insp).toBeVisible();
    await insp.getByTestId("inspector-tab-config").click();
    // taskId is absent on the fixture → the button honestly doesn't render.
    await expect(insp.getByTestId("inspector-run-now")).toHaveCount(0);
    await insp.getByTestId("inspector-close").click();

    // With a taskId the button shows and calls the run channel.
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ...CANVAS_FLEET, members: CANVAS_FLEET.members.map((m) => (m.id === "inv" ? { ...m, taskId: "cron_task_x" } : m)) }),
      }),
    );
    await page.reload();
    await expect(page.getByTestId("fleet-canvas").getByTestId("canvas-node-inv")).toBeVisible({ timeout: 15000 });
    const insp2 = page.getByTestId("inspector-inv");
    await page.getByTestId("fleet-canvas").getByTestId("canvas-node-inv").click();
    await expect(insp2).toBeVisible();
    await insp2.getByTestId("inspector-tab-config").click();
    await insp2.getByTestId("inspector-run-now").click();
    await expect(insp2.getByTestId("inspector-run-note")).toContainText("started");
    expect(runs.length).toBe(1);
  });

  test("design mode: drag-connect drafts an edge, dry-run gates confirm, apply lands it", async ({ page }) => {
    const applies = [];
    let draftOk = true;
    const connect = async (src, dst) => {
      const sb = await src.boundingBox();
      const db = await dst.boundingBox();
      await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
      await page.mouse.down();
      await page.mouse.move(db.x + db.width / 2, db.y + db.height / 2, { steps: 8 });
      await page.mouse.up();
    };
    await page.route(`**/api/fleets/${FLEET_ID}/orchestration/draft`, (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(draftOk ? { ok: true, diff: [{ op: "edge", kind: "handoff" }], warnings: [] } : { ok: false, errors: [{ error: "handoff edges form a cycle: ceo→ops→ceo" }], warnings: [] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/orchestration/apply`, (route) => {
      applies.push(route.request().postDataJSON());
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, mode: "edit", applied: [] }) });
    });
    await page.goto(`/fleets/${FLEET_ID}`);
    const canvas = page.getByTestId("fleet-canvas");
    await expect(canvas.getByTestId("canvas-node-ceo")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("design-panel")).toBeVisible();

    // Enter design; the confirm is dead until a draft exists.
    await page.getByTestId("design-toggle").click();
    await expect(page.getByTestId("design-kind")).toBeVisible();
    await expect(page.getByTestId("design-confirm")).toBeDisabled();

    // Drag ceo → ops (a NEW pair: existing edges are cron→ceo and ceo→inv).
    const src = canvas.locator('.react-flow__node[data-id="ceo"] .react-flow__handle.source');
    const dst = canvas.locator('.react-flow__node[data-id="ops"] .react-flow__handle.target');
    await connect(src, dst);

    // The draft edge renders (3 edges now) and confirm unlocks on a passing dry-run.
    await expect(canvas.locator(".react-flow__edge")).toHaveCount(3);
    await expect(canvas.locator('.react-flow__edge[data-id="ceo→ops:handoff"]')).toHaveCount(1);
    await expect(page.getByTestId("design-confirm")).toBeEnabled({ timeout: 5000 });

    // A blocked dry-run locks confirm and names the cycle: drop the draft,
    // flip the stub to failing, reconnect — the errors line shows, confirm is dead.
    await canvas.locator('.react-flow__edge[data-id="ceo→ops:handoff"]').click();
    await expect(canvas.locator(".react-flow__edge")).toHaveCount(2, { timeout: 15000 });
    draftOk = false;
    await connect(src, dst);
    await expect(page.getByTestId("design-errors")).toContainText("cycle", { timeout: 5000 });
    await expect(page.getByTestId("design-confirm")).toBeDisabled();

    // Unblock, confirm, land: the apply body carries the terminal orchestration
    // with BOTH declared edges kept and the new handoff appended.
    draftOk = true;
    await canvas.locator('.react-flow__edge[data-id="ceo→ops:handoff"]').click();
    await connect(src, dst);
    await expect(page.getByTestId("design-confirm")).toBeEnabled({ timeout: 5000 });
    await page.getByTestId("design-confirm").click();
    await expect(page.getByTestId("design-toggle")).toBeVisible({ timeout: 5000 });
    expect(applies.length).toBe(1);
    const edges = applies[0].fleet.orchestration.edges.map((e) => `${e.kind}:${e.from ?? "*"}→${e.to ?? (e.targets ?? []).join("+")}`);
    expect(edges).toContain("trigger:*→ceo");
    expect(edges).toContain("handoff:ceo→inv");
    expect(edges).toContain("handoff:ceo→ops");

    // Exit discards: enter, connect, exit without confirming — nothing applied.
    await page.getByTestId("design-toggle").click();
    await connect(src, dst);
    await expect(canvas.locator(".react-flow__edge")).toHaveCount(3);
    await page.getByTestId("design-exit").click();
    await expect(canvas.locator(".react-flow__edge")).toHaveCount(2);
    expect(applies.length).toBe(1);
  });
});

// ── post card skipped badge (fix-fleet-turn-veracity) ───────────────────────
// A skipped newest turn (runtime never ready / lane breaker open) is its own
// muted chip — never the destructive failure tone, with the in-window count.

test.describe("post card skipped round", () => {
  test("skipped newest turn renders its own chip with the window count", async ({ page }) => {
    await pinLocaleEn(page);
    const skippedMember = memberFixture("skippy", {
      title: "Skippy",
      status: "on_duty",
      statusReason: "recent execution within tolerance",
      lastTurn: {
        status: "skipped",
        errorKind: "runtime_not_ready",
        error: "the agent runtime is not ready (waited for fleet round)",
        endedAt: 1790000200000,
        sessionId: null,
      },
      skippedRounds: 2,
    });
    const failingMember = memberFixture("faily", {
      title: "Faily",
      status: "failing",
      statusReason: "3 consecutive failed rounds (last: model_upstream)",
      lastTurn: { status: "failed", errorKind: "model_upstream", error: "503 upstream", endedAt: 1790000100000, sessionId: "cron-faily" },
      consecutiveFailures: 3,
    });
    const DETAIL = {
      fleet: { id: FLEET_ID, name: "Demo Fleet", state: "active", createdAt: 0, updatedAt: 0 },
      members: [skippedMember, failingMember],
      statusCounts: { on_duty: 1, failing: 1 },
      openDecisions: 0,
    };
    await page.route("**/api/fleets", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Demo Fleet", state: "active", memberCount: 2, statusCounts: DETAIL.statusCounts }] }),
      }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(DETAIL) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/runs**`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ total: 0, runs: [] }) }),
    );

    await page.goto(`/fleets/${FLEET_ID}`);
    const tree = page.getByTestId("fleets-tree");
    await expect(tree.getByTestId("member-card-skippy")).toBeVisible({ timeout: 15000 });

    // skipped = muted own chip with the in-window count, never the failure chip
    await expect(tree.getByTestId("member-turn-skipped-skippy")).toHaveText(/round not executed · runtime_not_ready ×2/);
    await expect(tree.getByTestId("member-turn-skippy")).toHaveCount(0);

    // the failing member keeps the destructive chip — the two tones must not merge
    await expect(tree.getByTestId("member-turn-faily")).toContainText("turn failed · model_upstream");
    await expect(tree.getByTestId("member-consecutive-faily")).toBeVisible();
  });
});
