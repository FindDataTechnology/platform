import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Team console (openspec: add-pack-console) — the two properties the spec makes
// load-bearing on the CLIENT side:
//   1. a declared block renders, an absent block renders its honest empty state
//      (never a zero), and the owner sees the publication control;
//   2. a block id this client does not know (a declaration from a newer server)
//      degrades IN PLACE — the rest of the page still renders.
//
// Property 2 cannot be produced by the real server: the manifest validator
// rejects unregistered block ids, so an unknown id only reaches a client through
// version skew. That is exactly why this test stubs the REST response — the
// client's degrade path must not go untested just because the server is strict.
//
// Same harness as e2e/fleet-ops-canvas.spec.js: stubbed REST, direct goto.

const FLEET_ID = "fleet_console";

function member(id, over = {}) {
  return {
    id,
    fleetId: FLEET_ID,
    title: over.title ?? id,
    parentId: null,
    target: { kind: "persona", id: "p1", label: "甲" },
    kpiSlots: [],
    cadence: null,
    sortKey: 0,
    createdAt: 0,
    updatedAt: 0,
    status: over.status ?? "on_duty",
    statusReason: null,
    missedRounds: 0,
    skippedRounds: 0,
    latestReport: over.latestReport ?? null,
    lastTurn: null,
    effectiveModel: "deepseek-v4.1-flash",
  };
}

function view(blocks, over = {}) {
  return {
    v: 1,
    fleet: { id: FLEET_ID, name: "Console Fleet", state: "active", published: false, slug: null },
    surface: "platform",
    headline: null,
    blocks,
    sampledAt: 1_700_000_000_000,
    ...over,
  };
}

async function stub(page, body) {
  await pinLocaleEn(page);
  await page.route("**/api/fleets", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ fleets: [{ id: FLEET_ID, name: "Console Fleet", state: "active", memberCount: 1 }] }),
    }),
  );
  await page.route(`**/api/fleets/${FLEET_ID}/console**`, (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(body) }),
  );
}

test.describe("team console", () => {
  test("declared blocks render; an absent block shows its reason, not a zero", async ({ page }) => {
    await stub(
      page,
      view([
        { block: "team", state: "ready", data: { fleet: { id: FLEET_ID, name: "Console Fleet", state: "active" }, statusCounts: { on_duty: 1 }, members: [member("m1", { title: "投放组" })], sampledAt: 1 } },
        { block: "kpi", state: "absent", absentReason: "no_reported_kpis" },
      ]),
    );
    await page.goto(`/fleets/${FLEET_ID}/console`);

    await expect(page.getByTestId("fleet-console-title")).toBeVisible({ timeout: 15000 });
    const team = page.getByTestId("console-block-team");
    await expect(team).toContainText("投放组");
    // The status label travels with the color (web-design-system: colour never
    // speaks alone); "on duty" is the pill's text.
    await expect(team).toContainText("OK");

    const kpi = page.getByTestId("console-card-kpi");
    await expect(kpi).toContainText("No KPI has been reported yet.");
    // The decisive negative: an absent block must not render a metric value.
    await expect(kpi).not.toContainText("0");

    // Owner-side publication control is present and offers publishing.
    await expect(page.getByTestId("console-publish-bar")).toBeVisible();
    await expect(page.getByTestId("console-publish")).toBeVisible();
  });

  test("an unknown block degrades in place and the rest of the page survives", async ({ page }) => {
    await stub(
      page,
      view([
        { block: "sales-funnel", state: "ready", data: { pipeline: [1, 2, 3] } },
        { block: "team", state: "ready", data: { fleet: { id: FLEET_ID, name: "Console Fleet", state: "active" }, statusCounts: { on_duty: 1 }, members: [member("m1", { title: "运营组" })], sampledAt: 1 } },
      ]),
    );
    await page.goto(`/fleets/${FLEET_ID}/console`);

    const unknown = page.getByTestId("console-card-sales-funnel");
    await expect(unknown).toBeVisible({ timeout: 15000 });
    await expect(unknown).toContainText("needs a newer version");

    // The page did not fail closed: the known block still renders.
    await expect(page.getByTestId("console-block-team")).toContainText("运营组");
  });

  test("an unpublished-address read degrades to the honest unavailable state", async ({ page }) => {
    await pinLocaleEn(page);
    await page.route(`**/api/fleets/${FLEET_ID}/console**`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
    await page.goto(`/fleets/${FLEET_ID}/console`);
    await expect(page.getByTestId("fleet-console-page")).toContainText("temporarily unavailable", { timeout: 15000 });
  });
});
