// E2E: run concurrency + workbench controls (fleet-run-concurrency 5.1).
//
// Three facts this spec pins, each one a failure the change exists to prevent:
//   1. the four numbers are VISIBLE together (declared / effective / capped-by /
//      running) — a lone `effective` cannot tell "the ceiling is 2" from
//      "the ceiling is 4 but only 2 slots are free";
//   2. parallel + workbench off is refused IN THE UI, before a round-trip, with
//      a message that names the fix (the server has the same gate; this is the
//      honest UI half, not a duplicate);
//   3. saving sends both fields (an empty box clears the declaration to null,
//      which means inherit — NOT 1).

import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const FLEET_ID = "f_conc_e2e";

function member(over = {}) {
  return {
    id: "post-a",
    fleetId: FLEET_ID,
    title: "Post A",
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
    ...over,
  };
}

function cockpit(members) {
  return {
    fleet: { id: FLEET_ID, name: "Conc Fleet", state: "active" },
    members,
    statusCounts: { on_duty: members.length },
    orchestration: { mode: "pipeline", constraints: { maxChainDepth: 4 }, edges: [] },
    edgeTraffic: [],
    decisions: [],
    openDecisions: 0,
    stream: members.map((m) => ({ memberId: m.id, title: m.title, status: m.status, latestReport: null })),
    health: { onDuty: members.length, paused: 0, missing: 0, vacant: 0, passive: 0, total: members.length },
  };
}

const CAPPED = {
  declared: 3,
  source: "member",
  workbench: "auto",
  ceiling: 2,
  effective: 2,
  limitedBy: "worker_pool",
  held: 1,
  queued: 0,
  unreadable: [],
};

test.describe("run concurrency controls", () => {
  test.beforeEach(async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/fleets", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Conc Fleet", state: "active", memberCount: 1, openDecisions: 0 }] }) }),
    );
    await page.route(`**/api/fleets/${FLEET_ID}/cockpit`, (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(cockpit([member({ concurrency: CAPPED })])) }),
    );
    // The cockpit mounts several sibling read faces; a passing sibling test in
    // fleets.spec mocks all of them. Unmocked, one of them parks the page in a
    // loading state and the canvas never renders.
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

  test("declared / effective / capped-by / running are shown together", async ({ page }) => {
    await page.goto(`/fleets/${FLEET_ID}`);
    // The structure tree's per-post inspect button renders in EVERY view (the
    // live canvas only mounts under the Operations tab), so the inspector is
    // reachable here without depending on which view happens to be active.
    const inspect = page.getByTestId("member-inspect-post-a");
    await expect(inspect).toBeVisible({ timeout: 15000 });
    await inspect.click();

    const insp = page.getByTestId("inspector-post-a");
    await expect(insp).toBeVisible();
    await insp.getByTestId("inspector-tab-config").click();

    // The declared value seeds the input (3, not the effective 2).
    await expect(insp.getByTestId("inspector-concurrency")).toHaveValue("3");
    // The workbench select reflects the declaration.
    await expect(insp.getByTestId("inspector-workbench")).toHaveValue("auto");
    // The summary line names the limit that capped it — the whole point.
    const line = insp.getByTestId("inspector-concurrency-effective");
    await expect(line).toContainText("2");
    await expect(line).toContainText("worker_pool");
    await expect(line).toContainText("1/2");
  });

  test("parallel with workbench off is refused in the UI and nothing is sent", async ({ page }) => {
    let patched = 0;
    await page.route(`**/api/fleets/${FLEET_ID}/members/post-a`, (route) => {
      if (route.request().method() === "PATCH") patched += 1;
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.goto(`/fleets/${FLEET_ID}`);
    const inspect = page.getByTestId("member-inspect-post-a");
    await expect(inspect).toBeVisible({ timeout: 15000 });
    await inspect.click();
    const insp = page.getByTestId("inspector-post-a");
    await insp.getByTestId("inspector-tab-config").click();

    // Turn isolation off while keeping 3 parallel runs — the physical conflict.
    await insp.getByTestId("inspector-workbench").selectOption("off");
    await insp.getByTestId("inspector-save").click();

    // The UI refuses and names the fix; no PATCH leaves the browser.
    await expect(insp).toContainText(/workbench/i);
    expect(patched).toBe(0);
  });

  test("clearing the box sends null (= inherit), not 1", async ({ page }) => {
    const bodies = [];
    await page.route(`**/api/fleets/${FLEET_ID}/members/post-a`, async (route) => {
      if (route.request().method() === "PATCH") bodies.push(route.request().postDataJSON());
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });
    await page.goto(`/fleets/${FLEET_ID}`);
    const inspect = page.getByTestId("member-inspect-post-a");
    await expect(inspect).toBeVisible({ timeout: 15000 });
    await inspect.click();
    const insp = page.getByTestId("inspector-post-a");
    await insp.getByTestId("inspector-tab-config").click();

    await insp.getByTestId("inspector-concurrency").fill("");
    await insp.getByTestId("inspector-save").click();

    await expect.poll(() => bodies.length, { timeout: 5000 }).toBeGreaterThan(0);
    expect(bodies[0].concurrency).toBeNull();
  });
});