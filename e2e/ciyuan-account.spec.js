// ciyuan-account.spec.js — the zero-paste 词元 account binding end to end
// against the hermetic fake gateway (e2e/ciyuan-stub.js), plus the card's
// places in the ecosystem: the /api/connections aggregation and the app-center
// 词元 badge. State carries across the tests on purpose — this spec plays one
// script: bind → probe flips stale → healed → disconnect → wrong password →
// paste fallback → panel deep links.

import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const STUB = `http://127.0.0.1:${process.env.E2E_CIYUAN_PORT || 3197}`;

const MINTED = ["sk", "e2e-ciyuan-minted-key"].join("-");

async function stubMode(login, keys = "ok", models = 200) {
  const r = await fetch(`${STUB}/__mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login, keys, models }),
  });
  expect(r.ok).toBeTruthy();
}

async function aggregation(request) {
  const res = await request.get("/api/connections");
  const body = await res.json();
  const byId = Object.fromEntries(body.connections.map((c) => [c.id, c]));
  return { byId, raw: JSON.stringify(body) };
}

test("zero-paste bind: form → connected with key metadata; aggregation and app-center flip", async ({ page, request }) => {
  await stubMode("ok");
  await pinLocaleEn(page);
  await page.goto("/settings/connections");
  await expect(page.getByTestId("ciyuan-account-card")).toBeVisible();
  await expect(page.getByTestId("ciyuan-account-state")).toHaveAttribute("data-state", "disconnected");

  await page.getByTestId("ciyuan-account-email").fill("ciyuan-user@findmail.com");
  await page.getByTestId("ciyuan-account-password").fill("e2e-password");
  await page.getByTestId("ciyuan-account-connect").click();
  await expect(page.getByTestId("ciyuan-account-state")).toHaveAttribute("data-state", "connected", { timeout: 15000 });

  // Metadata, not material: the key name renders, the minted key never does.
  const details = await page.getByTestId("ciyuan-account-details").innerText();
  expect(details).toMatch(/yizuo-[0-9a-f]{8}-\d{8}/);
  expect(details).not.toContain(MINTED);
  // Hermetic runs are single-process (auth off): the card says so honestly.
  await expect(page.getByTestId("ciyuan-account-lane-note")).toContainText("single-process");

  const { byId, raw } = await aggregation(request);
  expect(byId["ciyuan-account"].state).toBe("connected");
  expect(byId["line-wanxing-caller"]).toBeUndefined();
  expect(raw).not.toContain(MINTED);

  await page.goto("/apps");
  await expect(page.getByTestId("app-card-wanxing-token-connection-badge")).toHaveAttribute(
    "data-state",
    "connected",
  );
  await expect(page.getByTestId("app-card-wanxing-token-connect")).toHaveCount(0);
});

test("probe: 401 flips stale, a healed upstream heals on the next probe", async ({ page, request }) => {
  await stubMode("ok", "ok", 401);
  await pinLocaleEn(page);
  await page.goto("/settings/connections");
  await expect(page.getByTestId("ciyuan-account-state")).toHaveAttribute("data-state", "connected");
  await page.getByTestId("ciyuan-account-test").click();
  await expect(page.getByTestId("ciyuan-account-state")).toHaveAttribute("data-state", "stale", { timeout: 15000 });
  expect((await aggregation(request)).byId["ciyuan-account"].state).toBe("stale");

  await stubMode("ok", "ok", 200);
  await page.getByTestId("ciyuan-account-test").click();
  await expect(page.getByTestId("ciyuan-account-state")).toHaveAttribute("data-state", "connected", { timeout: 15000 });
});

test("disconnect drops locally with the revoke hint; aggregation follows", async ({ page, request }) => {
  await pinLocaleEn(page);
  await page.goto("/settings/connections");
  await page.getByTestId("ciyuan-account-disconnect").click();
  await expect(page.getByTestId("ciyuan-account-state")).toHaveAttribute("data-state", "disconnected", { timeout: 15000 });
  await expect(page.getByTestId("ciyuan-account-notice")).toContainText("token.finddatatech.cloud");
  expect((await aggregation(request)).byId["ciyuan-account"].state).toBe("disconnected");
});

test("wrong password refuses readably and leaves the card unbound", async ({ page }) => {
  await stubMode("401");
  await pinLocaleEn(page);
  await page.goto("/settings/connections");
  await page.getByTestId("ciyuan-account-email").fill("ciyuan-user@findmail.com");
  await page.getByTestId("ciyuan-account-password").fill("wrong-password");
  await page.getByTestId("ciyuan-account-connect").click();
  await expect(page.getByTestId("ciyuan-account-error")).toContainText("login failed", { timeout: 15000 });
  await expect(page.getByTestId("ciyuan-account-state")).toHaveAttribute("data-state", "disconnected");
});

test("paste fallback: a pasted sk- binds through the retired caller route, labeled as such", async ({ page, request }) => {
  await pinLocaleEn(page);
  await page.goto("/settings/connections");
  await page.getByTestId("ciyuan-account-paste-toggle").click();
  await page.getByTestId("ciyuan-account-paste-input").fill(["sk","e2e-pasted-by-hand"].join("-"));
  await page.getByTestId("ciyuan-account-paste").click();
  await expect(page.getByTestId("ciyuan-account-state")).toHaveAttribute("data-state", "connected", { timeout: 15000 });
  await expect(page.getByTestId("ciyuan-account-details")).toContainText("pasted");
  expect((await aggregation(request)).byId["ciyuan-account"].state).toBe("connected");
  await page.getByTestId("ciyuan-account-disconnect").click();
  await expect(page.getByTestId("ciyuan-account-state")).toHaveAttribute("data-state", "disconnected", { timeout: 15000 });
});

test("panel deep links: new id and the retired alias both highlight the card", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/settings/connections?panel=ciyuan-account");
  await expect(page.getByTestId("ciyuan-account-card")).toBeVisible();
  await expect(page.locator("[data-panel='ciyuan-account']")).toHaveAttribute("data-panel-active", "true");

  await page.goto("/settings/connections?panel=line-wanxing-caller");
  await expect(page.getByTestId("ciyuan-account-card")).toBeVisible();
  await expect(page.locator("[data-panel='ciyuan-account']")).toHaveAttribute("data-panel-active", "true");
});
