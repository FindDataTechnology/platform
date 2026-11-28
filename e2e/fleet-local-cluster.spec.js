// ── Desktop fleet console: local cluster management (fast lane) ─────────────
//
// The write face this batch shipped (add-local-fleet-control-plane +
// add-desktop-fleet-console delta): the fleet page is a MANAGEMENT surface on
// the desktop — deploy / stop / start / remove against the cell's LOCAL store,
// a runtime-group capacity line, honest capacity refusal, and a cloud
// directory that stays a read-only bridge.
//
// The harness has no Electron, so the preload bridge is stubbed the same way
// the app detects it (window.platform.pickWorkdir is a function →
// lib/environment.ts IS_DESKTOP). Everything else is the real built page
// talking to mocked fleet endpoints — the desktop proxy lane.
//
//   npm run test:e2e -- e2e/fleet-local-cluster.spec.js

import { expect, test } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const LIVE_HEALTHY = {
  ok: true,
  agents: [{ key: "packs-probe/probe-worker", path: "packs/probe/probe-worker", port: 8805, state: "resident", version: 1 }],
  children: 1,
  queued: 0,
  budget: 210,
  budgetMb: 3072,
};

function localCatalog({ deployed = false, enabled = false, capacity = { used: 0, cap: 4, unit: "groups", podMode: true } } = {}) {
  return {
    source: "local",
    agents: deployed && enabled ? [{ path: "packs/probe/probe-worker", name: "Probe Worker", description: "d", version: "1", tags: [] }] : [],
    candidates: [
      {
        path: "packs/probe/probe-worker",
        packId: "probe",
        agentId: "probe-worker",
        name: "Probe Worker",
        description: "does work",
        deployed,
        enabled,
      },
    ],
    capacity,
  };
}

// One mutable server-side state so the walkthrough behaves like the real cell:
// deploy/stop/start/remove move it, and every read reflects it.
function mockFleet(page, initial = {}) {
  const state = {
    deployed: initial.deployed ?? false,
    enabled: initial.enabled ?? false,
    capacity: initial.capacity ?? { used: 0, cap: 4, unit: "groups", podMode: true },
    deployRefusal: initial.deployRefusal ?? null,
    cloudLoaded: 0,
  };

  page.route("**/api/wanxing/fleet/live", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LIVE_HEALTHY) }),
  );

  page.route("**/api/wanxing/fleet/catalog**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("source") === "registry") {
      state.cloudLoaded += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          source: "registry",
          agents: [{ path: "cloud/agent-1", name: "Cloud Agent", description: "cloud", version: "2", tags: ["cloud"] }],
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(localCatalog(state)),
    });
  });

  page.route("**/api/wanxing/fleet/deployments**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const action = url.pathname.split("/").pop();
    if (req.method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ capacity: state.capacity, deployments: state.deployed ? [{ agentPath: "packs/probe/probe-worker", packId: "probe", agentId: "probe-worker", enabled: state.enabled }] : [] }),
      });
    }
    if (action === "deployments") {
      if (state.deployRefusal) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "capacity_exceeded", used: 4, cap: 4, unit: "groups" }),
        });
      }
      state.deployed = true;
      state.enabled = true;
      state.capacity = { ...state.capacity, used: 1 };
    } else if (action === "stop") {
      state.enabled = false;
    } else if (action === "start") {
      state.enabled = true;
    } else if (action === "remove") {
      state.deployed = false;
      state.enabled = false;
      state.capacity = { ...state.capacity, used: 0 };
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, capacity: state.capacity }) });
  });

  page.route("**/api/wanxing/fleet/presets**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bundles: [{ file: "starter-v1.yizpack", packId: "starter", version: 1, name: "Starter Fleet", bytes: 1024 }] }),
    }),
  );

  page.route("**/api/wanxing/fleet/convergence", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ last: { at: "2026-10-28T00:00:00Z", pruned: 1, deployments: 1, enabled: 1 }, current: { deployments: 1, enabled: 1 } }),
    }),
  );

  return state;
}

test.beforeEach(async ({ page }) => {
  await pinLocaleEn(page);
  // Be the desktop shell (the single tell the app forks on).
  await page.addInitScript(() => {
    window.platform = { pickWorkdir: async () => "" };
  });
});

test("desktop shell: deploy → stop → start → remove, with the capacity line", async ({ page }) => {
  const state = mockFleet(page);
  await page.goto("/fleet");

  await expect(page.getByTestId("fleet-page")).toBeVisible({ timeout: 15_000 });
  // The capacity line is the runtime-GROUP unit, not a deployment count.
  await expect(page.getByTestId("fleet-capacity")).toContainText("0 / 4");

  // Deploy from the installed-pack candidates.
  await expect(page.getByTestId("fleet-candidate-state")).toContainText("not deployed");
  await page.getByTestId("fleet-candidate-deploy").click();
  await expect(page.getByTestId("fleet-candidate-state")).toContainText("running");
  await expect(page.getByTestId("fleet-capacity")).toContainText("1 / 4");
  await page.screenshot({ path: "test-results/fleet-local-deployed.png", fullPage: true });

  // Stop / start keep the identity.
  await page.getByTestId("fleet-candidate-stop").click();
  await expect(page.getByTestId("fleet-candidate-state")).toContainText("stopped");
  await expect(page.getByTestId("fleet-candidate-deploy")).toContainText("Start");
  await page.getByTestId("fleet-candidate-deploy").click();
  await expect(page.getByTestId("fleet-candidate-state")).toContainText("running");

  // Remove clears it.
  await page.getByTestId("fleet-candidate-remove").click();
  await expect(page.getByTestId("fleet-candidate-state")).toContainText("not deployed");
  await expect(page.getByTestId("fleet-capacity")).toContainText("0 / 4");
  expect(state.deployed).toBe(false);
});

test("desktop shell: at capacity the deploy action is PREVENTED, with the reason on it", async ({ page }) => {
  // The UI's own contract is "prevent, don't refuse": with every runtime group
  // in use the action is disabled and carries the why — a user never gets to
  // fire a request the cell would reject.
  mockFleet(page, { capacity: { used: 4, cap: 4, unit: "groups", podMode: true } });
  await page.goto("/fleet");
  await expect(page.getByTestId("fleet-capacity")).toContainText("4 / 4");

  const deploy = page.getByTestId("fleet-candidate-deploy");
  await expect(deploy).toBeDisabled();
  await expect(deploy).toHaveAttribute("title", /runtime groups are in use/i);
  // The reason must be VISIBLE, not hover-only.
  await expect(page.getByTestId("fleet-candidate-capacity-note")).toContainText("runtime groups are in use");
  await page.screenshot({ path: "test-results/fleet-local-capacity.png", fullPage: true });
});

test("desktop shell: a server-side refusal (capacity raced away) shows the structured guidance", async ({ page }) => {
  // The honest race: the page believed a slot was free (another window took
  // it a moment ago) and the CELL answers 409. That answer must land as
  // guidance — used/cap and what to do — never as a raw error toast.
  mockFleet(page, { capacity: { used: 0, cap: 4, unit: "groups", podMode: true }, deployRefusal: true });
  await page.goto("/fleet");
  const deploy = page.getByTestId("fleet-candidate-deploy");
  await expect(deploy).toBeEnabled();

  await deploy.click();
  const banner = page.getByTestId("fleet-action-error");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("4");
  await page.screenshot({ path: "test-results/fleet-local-refusal.png", fullPage: true });
});

test("desktop shell: the cloud directory is a read-only bridge, loaded on demand", async ({ page }) => {
  const state = mockFleet(page);
  await page.goto("/fleet");

  // Nothing is fetched from the cloud until asked.
  await expect(page.getByTestId("fleet-catalog-idle")).toBeVisible();
  expect(state.cloudLoaded).toBe(0);

  await page.getByTestId("fleet-catalog-refresh").click();
  await expect(page.getByTestId("fleet-catalog-card")).toContainText("Cloud Agent");
  expect(state.cloudLoaded).toBe(1);
  // Read-only: the cloud zone offers no deploy action at all.
  await expect(page.getByTestId("fleet-catalog-grid").getByRole("button", { name: /deploy/i })).toHaveCount(0);
  await page.screenshot({ path: "test-results/fleet-local-cloud-bridge.png", fullPage: true });
});

test("plain browser still gets the desktop-only note (no fleet management leak)", async ({ browser }) => {
  // No preload stub this time: the very same build must NOT expose the
  // management surface to a web visitor.
  const context = await browser.newContext();
  const page = await context.newPage();
  await pinLocaleEn(page);
  let polled = 0;
  await page.route("**/api/wanxing/fleet/**", (route) => {
    polled += 1;
    return route.fulfill({ status: 500, body: JSON.stringify({ error: "polled from plain browser" }) });
  });
  await page.goto("/fleet");
  await expect(page.getByTestId("fleet-desktop-only")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("fleet-candidates")).toHaveCount(0);
  await expect(page.getByTestId("fleet-live")).toHaveCount(0);
  expect(polled).toBe(0);
  await context.close();
});
