import { test, expect } from "@playwright/test";

// /api/config contract. OpenConnector and LiteLLM were removed from the
// platform (dsh's native plugins cover both), so their flags must not come
// back — a reappearing field means dead wiring was reintroduced.

test.describe("server config", () => {
  test("exposes documentsEnabled and no removed service flags", async ({ page }) => {
    const res = await page.request.get("/api/config");
    expect(res.ok()).toBe(true);
    const cfg = await res.json();
    expect(typeof cfg.documentsEnabled).toBe("boolean");
    expect(cfg.openconnectorEnabled).toBeUndefined();
    expect(cfg.litellmEnabled).toBeUndefined();
  });

  test("/openconnector is no longer a route and falls back to chat", async ({ page }) => {
    await page.goto("/openconnector");
    await expect(page).toHaveURL(/\/chat$/);
  });
});
