// ── Machine lifecycle console: pairing wizard, convergence, history, unbind ──
//
// add-machine-lifecycle-console: the machine page is the steward lifecycle
// façade. All endpoints are mocked — the shared routes the gateway and
// single-process server mount.
//
//   npm run test:e2e -- e2e/machines-lifecycle.spec.js

import { expect, test } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const NOW = Date.now();

const MACHINE_ROW = {
  deviceId: "dev-alpha",
  label: "Alpha Studio",
  boundAt: NOW - 86400_000,
  lastSeenAt: NOW - 30_000,
  presence: { state: "running", os: "darwin", appVersion: "1.3.24" },
  desiredVersion: 3,
  summary: { fleetCount: 2, memberCount: 5, enabledTaskCount: 1, deploymentCount: 2, capacity: { used: 1, cap: 4, unit: "groups" } },
  health: { silence: "online", alerts: [], divergenceStreak: 0, lastSeenAt: NOW - 30_000 },
};

// A converged-then-silent machine: desired v3, machine consumed v2, presence silent.
const MACHINE_ROW_AWAITING = {
  ...MACHINE_ROW,
  deviceId: "dev-bravo",
  label: "Bravo Box",
  lastSeenAt: NOW - 3600_000,
  desiredVersion: 3,
  health: { silence: "silent", alerts: [{ kind: "silent", lastSeenAt: NOW - 3600_000 }], divergenceStreak: 0, lastSeenAt: NOW - 3600_000 },
};

function machineDetail({ desiredVersion = 3, seenVersion = 3, deployments = null, rejects = [] } = {}) {
  return {
    deviceId: "dev-alpha",
    detail: {
      at: NOW - 20_000,
      capacity: { used: 1, cap: 4, unit: "groups" },
      deployments: deployments ?? [
        { agentPath: "packs/probe/probe-worker", packId: "probe", agentId: "probe-worker", enabled: true, source: "cloud" },
      ],
      agents: [{ key: "packs/probe/probe-worker", state: "serving", port: 8805, version: 1 }],
      merge: { desiredVersionSeen: seenVersion, rejects },
    },
    desired: { version: desiredVersion, entries: [{ packId: "probe", agentId: "probe-worker", enabled: true }], updatedAt: NOW - 60_000 },
    health: { silence: "online", alerts: [], divergenceStreak: 0, lastSeenAt: NOW - 30_000 },
  };
}

const HISTORY_EVENTS = [
  { at: NOW - 60_000, kind: "desired_change", who: "owner@test", version: 3, added: 1, removed: 0, toggled: 0 },
  { at: NOW - 120_000, kind: "merge_advance", from: 2, to: 3 },
];

function mockLifecycle(page, { rows = [MACHINE_ROW], detail = machineDetail(), history = HISTORY_EVENTS } = {}) {
  const state = { rows, detail, deleted: [] };
  page.route("**/api/mp/bindcode", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ code: "123456", ttlMs: 5 * 60_000 }),
    }),
  );
  page.route("**/api/machines/*/history", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deviceId: "dev-alpha", history, revokedAt: null }) }),
  );
  page.route("**/api/machines/*/desired", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ desired: state.detail.desired, health: state.detail.health }) }),
  );
  page.route("**/api/machines/*", (route) => {
    const req = route.request();
    if (req.url().includes("/history") || req.url().includes("/desired")) return route.fallback();
    if (req.method() === "DELETE") {
      state.deleted.push(req.url());
      state.rows = state.rows.filter((m) => !req.url().endsWith(m.deviceId));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.detail) });
  });
  page.route("**/api/machines", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ machines: state.rows, isAdminView: false }) }),
  );
  return state;
}

test.beforeEach(async ({ page }) => {
  await pinLocaleEn(page);
});

test("empty state opens the pairing wizard; the waiting state closes it when the machine reports", async ({ page }) => {
  const state = mockLifecycle(page, { rows: [] });
  await page.goto("/machines");
  await expect(page.getByTestId("machines-empty")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("machines-empty-pair").click();
  await expect(page.getByTestId("machine-pair-overlay")).toBeVisible();
  // The shared mint pool renders the digits + QR + validity.
  await expect(page.getByTestId("machine-pairing-code")).toContainText("123456");

  await page.getByTestId("machine-pair-wait-start").click();
  await expect(page.getByTestId("machine-pair-waiting")).toBeVisible();

  // The machine reports: a row bound after the mint appears in the roster.
  state.rows = [{ ...MACHINE_ROW, boundAt: Date.now() + 1000 }];
  await expect(page.getByTestId("machine-pair-overlay")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("machine-row-dev-alpha")).toBeVisible();
});

test("convergence indicator: synced and awaiting-pickup states render", async ({ page }) => {
  const state = mockLifecycle(page);
  await page.goto("/machines");
  await page.getByTestId("machine-row-dev-alpha").click();
  await expect(page.getByTestId("machine-convergence")).toHaveAttribute("data-state", "synced");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("machine-detail-overlay")).toHaveCount(0);

  // Desired v3, machine consumed v2, presence silent → awaiting pickup.
  // The roster polls every 15s, so the swapped fixture needs a longer window.
  state.rows = [MACHINE_ROW_AWAITING];
  state.detail = { ...machineDetail({ seenVersion: 2 }), deviceId: "dev-bravo", health: MACHINE_ROW_AWAITING.health };
  await expect(page.getByTestId("machine-row-dev-bravo")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("machine-row-dev-bravo").click();
  await expect(page.getByTestId("machine-convergence")).toHaveAttribute("data-state", "awaiting");
  await expect(page.getByTestId("machine-convergence")).toContainText("Awaiting pickup");
});

test("history timeline renders metadata events in the drawer", async ({ page }) => {
  mockLifecycle(page);
  await page.goto("/machines");
  await page.getByTestId("machine-row-dev-alpha").click();
  const history = page.getByTestId("machine-history");
  await expect(history).toBeVisible();
  await expect(history).toContainText("owner@test");
  await expect(history).toContainText("v3");
});

test("unbind: two-step confirm deletes, closes the drawer and refreshes the roster", async ({ page }) => {
  const state = mockLifecycle(page);
  await page.goto("/machines");
  await page.getByTestId("machine-row-dev-alpha").click();

  await page.getByTestId("machine-unbind").click();
  await expect(page.getByTestId("machine-unbind-confirming")).toBeVisible();
  // Cancel keeps the machine.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("machine-unbind-confirming")).toHaveCount(0);

  await page.getByTestId("machine-unbind").click();
  await page.getByTestId("machine-unbind-confirm").click();
  await expect.poll(() => state.deleted.length).toBe(1);
  await expect(page.getByTestId("machine-detail-overlay")).toHaveCount(0);
  await expect(page.getByTestId("machine-row-dev-alpha")).toHaveCount(0);
});
