// ── Platform-ops web e2e (add-agent-platform-ops 6.1) ────────────────────────
//
// The ③ web deltas against the real page with a gateway stand-in (the
// packs.spec.js pattern — the hermetic webServer has no gateway): the private
// pack's badge and the deploy surface's balance readout with its low-balance
// warning. The gateway's own HTTP contract (gate/mint/board/visibility) is
// covered for real by scripts/test-platform-billing.mjs against booted routes.

import { expect, test } from "@playwright/test";
import { openSettings } from "./helpers.js";

const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("platform.locale", "zh-CN"));
});

test("a private pack shows its badge in the detail dialog", async ({ page }) => {
  await page.route("**/api/packs**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/api/packs")) {
      return route.fulfill(json({ total: 1, page: 1, pageSize: 50, packs: [
        { id: "pk-priv", authorEmail: "a@x", createdAt: 1, version: 1, name: "ProbePriv", description: "d", tags: [], publishedAt: 1, visibility: "private" },
      ] }));
    }
    if (url.pathname.endsWith("/api/packs/pk-priv")) {
      return route.fulfill(json({ id: "pk-priv", version: 1, visibility: "private", manifest: { name: "ProbePriv", skills: [], mcpServers: [], agents: [] } }));
    }
    return route.fulfill(json({ error: "no route" }, 404));
  });
  await openSettings(page, "packs");
  await page.getByTestId("pack-card-pk-priv").click();
  await expect(page.getByTestId("pack-private-badge")).toBeVisible({ timeout: 10_000 });
});

test("the deploy section shows the balance readout, paste inputs, and the bound badge", async ({ page }) => {
  await page.route("**/api/packs**", async (route) => {
    const url0 = new URL(route.request().url());
    // Registered inside the glob so it cannot be shadowed (later-registered
    // routes win in Playwright; a separate earlier route was swallowed).
    if (url0.pathname.endsWith("/api/packs/billing/me")) {
      return route.fulfill(json({ linked: true, balance: 0.2, accountState: "ok", panelUrl: "https://token.example.test" }));
    }
    if (url0.pathname.endsWith("/api/packs/pk-svc/billing-bindings")) {
      return route.fulfill(json({ "svc-agent": true }));
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/api/packs")) {
      return route.fulfill(json({ total: 1, page: 1, pageSize: 50, packs: [
        { id: "pk-svc", authorEmail: "a@x", createdAt: 1, version: 1, name: "ProbeSvc", description: "d", tags: [], publishedAt: 1 },
      ] }));
    }
    if (url.pathname.endsWith("/api/packs/pk-svc")) {
      return route.fulfill(json({
        id: "pk-svc", version: 1,
        manifest: { name: "ProbeSvc", skills: [], mcpServers: [], agents: [{ id: "svc-agent", name: "S", persona: "p", serving: { protocol: "a2a" } }] },
      }));
    }
    if (url.pathname.includes("/deployments")) return route.fulfill(json({ deployments: [] }));
    return route.fulfill(json({ error: "no route" }, 404));
  });
  await openSettings(page, "packs");
  await page.getByTestId("pack-card-pk-svc").click();
  const readout = page.getByTestId("pack-billing-readout");
  await expect(readout).toBeVisible({ timeout: 10_000 });
  await expect(readout).toContainText("0.20");
  // The low-balance branch renders the amber warning styling (class check is
  // locale-independent).
  await expect(readout).toHaveClass(/amber/);
  // Paste flow: the serving agent shows its paste input and bound badge —
  // values never come back, only the fact of a binding.
  await expect(page.getByTestId("pack-billing-key-input-svc-agent")).toBeVisible();
  await expect(page.getByTestId("pack-billing-bound-svc-agent")).toBeVisible();
});

test("an unresolved billing account shows the connect-panel guidance, not the readout", async ({ page }) => {
  await page.route("**/api/packs**", async (route) => {
    const url0 = new URL(route.request().url());
    if (url0.pathname.endsWith("/api/packs/billing/me")) {
      return route.fulfill(json({ linked: true, balance: null, accountState: "none", panelUrl: "https://token.example.test" }));
    }
    if (url0.pathname.endsWith("/api/packs/pk-svc/billing-bindings")) {
      return route.fulfill(json({}));
    }
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/api/packs")) {
      return route.fulfill(json({ total: 1, page: 1, pageSize: 50, packs: [
        { id: "pk-svc", authorEmail: "a@x", createdAt: 1, version: 1, name: "ProbeSvc", description: "d", tags: [], publishedAt: 1 },
      ] }));
    }
    if (url.pathname.endsWith("/api/packs/pk-svc")) {
      return route.fulfill(json({
        id: "pk-svc", version: 1,
        manifest: { name: "ProbeSvc", skills: [], mcpServers: [], agents: [{ id: "svc-agent", name: "S", persona: "p", serving: { protocol: "a2a" } }] },
      }));
    }
    if (url.pathname.includes("/deployments")) return route.fulfill(json({ deployments: [] }));
    return route.fulfill(json({ error: "no route" }, 404));
  });
  await openSettings(page, "packs");
  await page.getByTestId("pack-card-pk-svc").click();
  await expect(page.getByTestId("pack-billing-no-account")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("pack-billing-connect")).toBeVisible();
  await expect(page.getByTestId("pack-billing-readout")).toHaveCount(0);
  // No paste inputs until the account exists — there is nothing to paste from.
  await expect(page.getByTestId("pack-billing-key-input-svc-agent")).toHaveCount(0);
});
