// ── Machines console: roster + detail + desired editing (fast lane) ─────────
//
// add-unified-fleet-console: the cloud machines page (roster with derived
// health chips, per-machine detail with deployment provenance + divergence,
// desired-state editor) and the desktop fleet page's provenance badges.
// Everything talks to mocked /api/machines* — the shared routes the gateway
// and single-process server mount.
//
//   npm run test:e2e -- e2e/machines-console.spec.js

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

const MACHINE_ROW_SILENT = {
  deviceId: "dev-bravo",
  label: "Bravo Box",
  boundAt: NOW - 86400_000,
  lastSeenAt: NOW - 3600_000,
  presence: { state: "suspended", os: "win32", appVersion: "1.3.24" },
  desiredVersion: 0,
  summary: { fleetCount: 0, memberCount: 0, enabledTaskCount: 0, deploymentCount: null, capacity: null },
  health: { silence: "silent", alerts: [{ kind: "silent", lastSeenAt: NOW - 3600_000 }], divergenceStreak: 0, lastSeenAt: NOW - 3600_000 },
};

function machineDetail({ desired = [], deployments = null, rejects = [] } = {}) {
  return {
    deviceId: "dev-alpha",
    detail: {
      at: NOW - 20_000,
      capacity: { used: 1, cap: 4, unit: "groups" },
      deployments: deployments ?? [
        { agentPath: "packs/probe/probe-worker", packId: "probe", agentId: "probe-worker", enabled: true, source: "cloud" },
        { agentPath: "packs/demo/helper", packId: "demo", agentId: "helper", enabled: false, source: "manual" },
      ],
      agents: [{ key: "packs/probe/probe-worker", state: "serving", port: 8805, version: 1 }],
      merge: { desiredVersionSeen: 3, rejects },
    },
    desired: { version: 3, entries: desired, updatedAt: NOW - 60_000 },
    health: { silence: "online", alerts: [], divergenceStreak: 0, lastSeenAt: NOW - 30_000 },
  };
}

function mockMachines(page, { rows = [MACHINE_ROW, MACHINE_ROW_SILENT], detail = machineDetail() } = {}) {
  const state = { detail, desiredPuts: [] };
  page.route("**/api/machines", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ machines: rows, isAdminView: false }) }),
  );
  page.route("**/api/machines/*/desired", async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const body = req.postDataJSON();
      state.desiredPuts.push(body.entries);
      state.detail = machineDetail({ desired: body.entries });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ desired: { version: state.detail.desired.version, entries: body.entries, updatedAt: NOW }, health: state.detail.health }),
      });
    }
    return route.fulfill({ status: 405, contentType: "application/json", body: "{}" });
  });
  page.route("**/api/machines/*", (route) => {
    if (route.request().url().includes("/desired")) return route.fallback();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.detail) });
  });
  return state;
}

test.beforeEach(async ({ page }) => {
  await pinLocaleEn(page);
});

test("roster: machines with health chips, silent machine flagged", async ({ page }) => {
  mockMachines(page);
  await page.goto("/machines");
  await expect(page.getByTestId("machines-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("machine-row-dev-alpha")).toContainText("Alpha Studio");
  await expect(page.getByTestId("machine-row-dev-bravo")).toContainText("Silence timeout");
  // Healthy row shows the online chip.
  await expect(page.getByTestId("machine-row-dev-alpha")).toContainText("Online");
});

test("empty account shows pairing guidance, not an error", async ({ page }) => {
  mockMachines(page, { rows: [] });
  await page.goto("/machines");
  await expect(page.getByTestId("machines-empty")).toBeVisible();
});

test("detail drawer: provenance badges, divergence marker, desired editing round-trip", async ({ page }) => {
  const state = mockMachines(page, {
    detail: machineDetail({
      desired: [{ packId: "probe", agentId: "probe-worker", enabled: true }],
    }),
  });
  await page.goto("/machines");
  await page.getByTestId("machine-row-dev-alpha").click();

  await expect(page.getByTestId("machine-detail-overlay")).toBeVisible();
  // Deployment rows carry source badges; the manually stopped row desired-on
  // by the cloud is the divergence case — but here the manual row is NOT in
  // the desired set, so only the cloud row shows the badge, no divergence.
  const deployList = page.getByTestId("machine-deployments");
  await expect(deployList).toContainText("Cloud desired");
  await expect(deployList).toContainText("Local manual");

  // Desired list shows the cloud-desired entry; toggle it off → PUT.
  await expect(page.getByTestId("desired-list")).toContainText("probe/probe-worker");
  await page.getByRole("button", { name: "Disable" }).click();
  await expect.poll(() => state.desiredPuts.length).toBe(1);
  expect(state.desiredPuts[0]).toEqual([{ packId: "probe", agentId: "probe-worker", enabled: false }]);

  // Remove → PUT without the entry.
  await page.getByRole("button", { name: "Remove" }).click();
  await expect.poll(() => state.desiredPuts.length).toBe(2);
  expect(state.desiredPuts[1]).toEqual([]);

  // Add from deployments: the manual row is absent from desired → addable.
  await page.getByTestId("desired-add-demo-helper").click();
  await expect.poll(() => state.desiredPuts.length).toBe(3);
  expect(state.desiredPuts[2]).toEqual([{ packId: "demo", agentId: "helper", enabled: true }]);
});

test("merge rejections surface in the detail drawer", async ({ page }) => {
  mockMachines(page, {
    detail: machineDetail({ rejects: [{ agentPath: "packs/p2/b1", code: "capacity_exceeded" }] }),
  });
  await page.goto("/machines");
  await page.getByTestId("machine-row-dev-alpha").click();
  await expect(page.getByTestId("machine-detail-overlay")).toContainText("capacity_exceeded");
});

// ── FleetPage provenance badges ──────────────────────────────────────────────

const LIVE_HEALTHY = {
  ok: true,
  agents: [{ key: "packs-probe/probe-worker", path: "packs/probe/probe-worker", port: 8805, state: "resident", version: 1 }],
  children: 1,
  queued: 0,
  budget: 210,
  budgetMb: 3072,
};

function mockFleetPage(page, candidate) {
  page.route("**/api/wanxing/fleet/live", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LIVE_HEALTHY) }),
  );
  page.route("**/api/wanxing/fleet/catalog**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("source") === "registry") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source: "registry", agents: [] }) });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        source: "local",
        agents: [],
        candidates: [candidate],
        capacity: { used: 1, cap: 4, unit: "groups", podMode: true },
      }),
    });
  });
  page.route("**/api/wanxing/fleet/presets**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bundles: [] }) }));
  page.route("**/api/wanxing/fleet/convergence", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ last: null, current: { deployments: 0, enabled: 0 } }) }));
}

test("fleet page: provenance badges render when paired, absent when uplink off", async ({ page }) => {
  await page.addInitScript(() => {
    window.platform = { pickWorkdir: async () => "" };
  });
  // Paired + pulling: cloud-desired entry that the user stopped locally →
  // BOTH the source badge and the divergence marker render.
  mockFleetPage(page, {
    path: "packs/probe/probe-worker",
    packId: "probe",
    agentId: "probe-worker",
    name: "Probe Worker",
    description: "does work",
    deployed: true,
    enabled: false,
    source: "cloud",
    desiredEnabled: true,
  });
  await page.goto("/fleet");
  await expect(page.getByTestId("fleet-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("fleet-candidate-provenance")).toContainText("Cloud desired");
  await expect(page.getByTestId("fleet-candidate-diverged")).toBeVisible();

  // Uplink off (desiredEnabled null) → NO badges at all.
  await page.unroute("**/api/wanxing/fleet/catalog**");
  mockFleetPage(page, {
    path: "packs/probe/probe-worker",
    packId: "probe",
    agentId: "probe-worker",
    name: "Probe Worker",
    description: "does work",
    deployed: true,
    enabled: false,
    source: "manual",
    desiredEnabled: null,
  });
  await page.reload();
  await expect(page.getByTestId("fleet-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("fleet-candidate-provenance")).toHaveCount(0);
});
