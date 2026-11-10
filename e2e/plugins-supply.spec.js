import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// 插件 tab of the materials market (openspec: unify-material-market —
// dsh-plugin-supply MODIFIED, plugin-supply-request ADDED).
//
// HISTORY — read before "restoring" anything. This file used to drive
// Settings → Plugins and assert `plugins-list` with an "Applying…" state and a
// `plugins-streaming-hint`. That settings section was RETIRED by
// unify-material-market (sections.ts carries no `plugins` slug) and the
// catalogue moved to `/agents?tab=plugins`. The old settings component
// (`settings/PluginsSection.tsx`) stayed behind with zero importers until it was
// deleted — a replaced surface that is strictly worse (no supply states, no
// 申请供应) must not sit in the tree waiting to be re-mounted by mistake. Four behaviours the old spec pinned did NOT
// survive the move; they are listed here so they get re-decided instead of
// silently lost:
//   1. per-row failure metadata (an `error.code: "operation-error"` badge);
//   2. a local "Applying…" pending state after a toggle;
//   3. a REJECTED toggle retiring that pending state (nothing is pending now —
//      `toggle()` is a fire-and-forget `set_plugin_enabled` WS send);
//   4. greying every switch out during a live turn (`plugins-streaming-hint`).
// What the live component does contract is asserted below: three supply states,
// protection via `readOnlyReason`, 申请供应 writing a request row, an
// unavailable-roster note, an explaining empty state, and a retryable failure.

const CATALOG = [
  { id: "@e2e/cat-enabled", name: "Enabled bundle", description: "supplied and on" },
  { id: "@e2e/cat-available", name: "Off bundle", description: "supplied, switched off" },
  { id: "@e2e/cat-protected", name: "Protected bundle", description: "managed elsewhere" },
  { id: "@e2e/cat-unsupplied", name: "Not supplied", description: "catalogued only" },
];

const BUNDLES = [
  { id: "@e2e/cat-enabled", name: "@e2e/cat-enabled", version: "0.0.1", enabled: true, installed: true, optional: false, removable: true },
  { id: "@e2e/cat-available", name: "@e2e/cat-available", version: "0.0.1", enabled: false, installed: true, optional: false, removable: true },
  {
    id: "@e2e/cat-protected",
    name: "@e2e/cat-protected",
    version: "0.0.1",
    enabled: true,
    installed: false,
    optional: false,
    removable: false,
    readOnlyReason: "management-required",
  },
];

/** Open the tab, stub the catalogue, then inject the WS roster through the same
 *  store seam the chat specs use (after mount, so the real first answer cannot
 *  overwrite the injection mid-assertion). */
async function openPluginsTab(page, { catalog = CATALOG, bundles = BUNDLES, available = true } = {}) {
  await pinLocaleEn(page);
  await page.route("**/api/plugin-catalog**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ plugins: catalog }) }),
  );
  await page.goto("/agents?tab=plugins");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(
    ({ bundles: b, available: a }) => window.__chatStore.getState().apply({ type: "plugins", bundles: b, available: a }),
    { bundles, available },
  );
  return page.getByTestId("plugin-catalog");
}

test("the three supply states render, and protection disables its switch", async ({ page }) => {
  const catalog = await openPluginsTab(page);
  await expect(catalog).toBeVisible();

  // supplied + on
  const enabled = page.getByTestId("plugin-row-@e2e/cat-enabled");
  await expect(enabled).toHaveAttribute("data-state", "enabled");
  await expect(enabled.getByTestId("plugin-toggle-@e2e/cat-enabled")).toBeEnabled();

  // supplied + off
  const off = page.getByTestId("plugin-row-@e2e/cat-available");
  await expect(off).toHaveAttribute("data-state", "available");
  await expect(off.getByTestId("plugin-toggle-@e2e/cat-available")).toBeEnabled();

  // protected: disabled, and the reason is stated in words (colour never alone)
  const guarded = page.getByTestId("plugin-row-@e2e/cat-protected");
  await expect(guarded.getByTestId("plugin-toggle-@e2e/cat-protected")).toBeDisabled();
  await expect(guarded).toContainText("management-required");

  // unsupplied: NO switch at all, and 申请供应 instead. A greyed switch would
  // send the user hunting for a fault on their side that does not exist.
  const missing = page.getByTestId("plugin-row-@e2e/cat-unsupplied");
  await expect(missing).toHaveAttribute("data-state", "unsupplied");
  await expect(missing.getByTestId("plugin-toggle-@e2e/cat-unsupplied")).toHaveCount(0);
  await expect(missing.getByTestId("plugin-request-@e2e/cat-unsupplied")).toBeVisible();
});

test("申请供应 writes one request and the row switches to pending", async ({ page }) => {
  const posts = [];
  await page.route("**/api/plugin-supply-requests", (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await openPluginsTab(page);
  await page.getByTestId("plugin-request-@e2e/cat-unsupplied").click();

  await expect(page.getByTestId("plugin-request-pending-@e2e/cat-unsupplied")).toBeVisible();
  expect(posts).toEqual([{ pluginId: "@e2e/cat-unsupplied" }]);
  // The action retires: the same row cannot fire a second request.
  await expect(page.getByTestId("plugin-request-@e2e/cat-unsupplied")).toHaveCount(0);
});

test("a refused request leaves the row actionable instead of freezing it", async ({ page }) => {
  await page.route("**/api/plugin-supply-requests", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "supply-request-failed" }),
    }),
  );

  await openPluginsTab(page);
  await page.getByTestId("plugin-request-@e2e/cat-unsupplied").click();

  // Still a request affordance and still enabled — `busy` is cleared in finally.
  const request = page.getByTestId("plugin-request-@e2e/cat-unsupplied");
  await expect(request).toBeVisible();
  await expect(request).toBeEnabled();
  await expect(page.getByTestId("plugin-request-pending-@e2e/cat-unsupplied")).toHaveCount(0);
});

test("an unavailable roster says so without hiding the catalogue", async ({ page }) => {
  await openPluginsTab(page, { bundles: [], available: false });

  await expect(page.getByTestId("plugin-catalog-unavailable")).toBeVisible();
  // With no roster every catalogue row is unsupplied and offers the request.
  await expect(page.getByTestId("plugin-row-@e2e/cat-enabled")).toHaveAttribute("data-state", "unsupplied");
});

test("an empty catalogue states that nothing is catalogued", async ({ page }) => {
  await pinLocaleEn(page);
  await page.route("**/api/plugin-catalog**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ plugins: [] }) }),
  );
  await page.goto("/agents?tab=plugins");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15_000 });

  await expect(page.getByTestId("plugin-catalog")).toHaveCount(0);
  await expect(page.getByRole("note")).toBeVisible();
});

test("a catalogue failure names the problem and offers a retry", async ({ page }) => {
  let calls = 0;
  await pinLocaleEn(page);
  await page.route("**/api/plugin-catalog**", (route) => {
    calls += 1;
    return calls === 1
      ? route.fulfill({ status: 500, body: "boom" })
      : route.fulfill({ contentType: "application/json", body: JSON.stringify({ plugins: CATALOG }) });
  });

  await page.goto("/agents?tab=plugins");
  await expect(page.getByTestId("agent-market-page")).toBeVisible({ timeout: 15_000 });
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(/HTTP 500/);
  await alert.getByRole("button").click();
  await expect(page.getByTestId("plugin-catalog")).toBeVisible();
});
