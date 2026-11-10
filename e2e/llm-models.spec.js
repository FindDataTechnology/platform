import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Models page (dsh-llm-models-page). These tests drive the real /api/llm/*
// endpoints through the UI and self-clean: any provider they create is deleted
// at the end so the developer's dsh settings.yaml is left as found. The built-in
// Volces card is read-only (no Edit/Delete) and serves as the "at least one
// provider visible" assertion.

const PAGE_URL = "/models";
const FAKE_BASE = "http://127.0.0.1:9/vendor/v1"; // unreachable; test expects failure

async function gotoModels(page) {
  await pinLocaleEn(page);
  await page.goto(PAGE_URL);
  await expect(page.getByTestId("models-page")).toBeVisible({ timeout: 15000 });
}

async function cleanupProviderByName(page, name) {
  // Best-effort delete via the API so a failed test doesn't leave residue.
  const list = await page.request.get("/api/llm/providers");
  if (list.ok()) {
    const body = await list.json();
    const match = (body.providers || []).find((p) => p.name === name);
    if (match && !match.reserved) {
      await page.request.delete(`/api/llm/providers/${match.id}`);
    }
  }
}

test.describe("Models page", () => {
  const providerName = "E2E Test Provider";

  test.afterEach(async ({ page }) => {
    await cleanupProviderByName(page, providerName);
  });

  test("renders the built-in provider card and the Add button", async ({ page }) => {
    await gotoModels(page);
    await expect(page.getByTestId("llm-provider-card").first()).toBeVisible();
    await expect(page.getByTestId("llm-add-provider")).toBeVisible();
  });

  test("sidebar gear opens Settings, where Models lives", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/chat/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-panel")).toBeVisible();
    await page.getByTestId("settings-section-models").click();
    await expect(page).toHaveURL(/\/settings\/models$/);
    await expect(page.getByTestId("models-page")).toBeVisible();
  });

  test("add → see in list → test (fails) → delete lifecycle", async ({ page }) => {
    await gotoModels(page);
    // Wait for the built-in card before counting — on a slow machine the
    // list may not have loaded yet and `before` would read 0.
    await expect(page.getByTestId("llm-provider-card").first()).toBeVisible({ timeout: 10000 });
    const before = await page.getByTestId("llm-provider-card").count();

    // Add a provider (unreachable base URL).
    await page.getByTestId("llm-add-provider").click();
    await page.getByTestId("llm-provider-name").fill(providerName);
    await page.getByTestId("llm-provider-baseurl").fill(FAKE_BASE);
    await page.getByTestId("llm-provider-apikey").fill("sk-e2e-fake");
    await page.getByTestId("llm-provider-save").click();

    // The new card appears.
    const card = page
      .getByTestId("llm-provider-card")
      .filter({ hasText: providerName });
    await expect(card).toBeVisible({ timeout: 5000 });
    expect(await page.getByTestId("llm-provider-card").count()).toBe(before + 1);

    // Test connection against the unreachable URL → failure state.
    await card.getByTestId("llm-test-btn").click();
    await expect(card.getByTestId("llm-test-failed")).toBeVisible({ timeout: 10000 });

    // Delete with confirm; the card disappears.
    await card.getByTestId("llm-delete-btn").click();
    await expect(page.getByTestId("llm-delete-confirm")).toBeVisible();
    await page.getByTestId("llm-delete-confirm").click();
    await expect(card).toHaveCount(0, { timeout: 5000 });
    expect(await page.getByTestId("llm-provider-card").count()).toBe(before);
  });

  test("Set as default updates the active default", async ({ page }) => {
    await gotoModels(page);

    // Find any model row that is not already the default — its "Set as
    // default" button is enabled (the default's is disabled). Scan all
    // cards: on a fresh store the built-in card's only model IS the default.
    const enabledBtns = page.locator('[data-testid="llm-set-default"]:not([disabled])');
    const count = await enabledBtns.count();
    test.skip(count === 0, "no set-default targets available");
    const btn = enabledBtns.first();
    await btn.click();
    const card = page.getByTestId("llm-provider-card").filter({ has: btn }).first();
    await expect(card.getByTestId("llm-default-check").first()).toBeVisible({ timeout: 5000 });

    // The default pointer persisted.
    const r = await page.request.get("/api/llm/default");
    const body = await r.json();
    expect(body.modelId).toBeTruthy();
    expect(body.activeModelId).toBeTruthy();
  });

  test("concurrent edits: second simultaneous write returns 409", async ({ page }) => {
    // Fire two POSTs at once with the same body. The write mutex rejects the
    // competing request with 409 "another edit in progress" rather than
    // queueing or racing on settings.yaml.
    const body = { name: providerName, baseUrl: FAKE_BASE, apiKey: "sk-e2e-fake" };
    const [r1, r2] = await Promise.all([
      page.request.post("/api/llm/providers", { data: body }),
      page.request.post("/api/llm/providers", { data: body }),
    ]);
    const statuses = [r1.status(), r2.status()].sort();
    // Exactly one succeeds (201), the other is rejected (409).
    expect(statuses).toEqual([201, 409]);
  });

  test("API rejects deleting the only provider with 409", async ({ page }) => {
    // The only-provider guard can only be exercised over HTTP when the single
    // remaining provider is a user provider (not the reserved Volces card,
    // which is rejected with 400 before the count check). In the local dev env
    // LLM_API_KEY is set so Volces is always present — then this scenario is
    // covered by the unit tests instead.
    await gotoModels(page);
    const list = await page.request.get("/api/llm/providers");
    const body = await list.json();
    test.skip(body.providers.length !== 1, "only meaningful with a single provider");
    test.skip(body.providers[0].reserved, "sole provider is the reserved built-in card");
    const id = body.providers[0].id;
    const del = await page.request.delete(`/api/llm/providers/${id}`);
    expect(del.status()).toBe(409);
  });
});
