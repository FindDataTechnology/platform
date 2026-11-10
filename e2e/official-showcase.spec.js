import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// Official showcase (openspec: add-official-pack-showcase) — web faces over
// mocked API (the component contract is what this pins; the server side has
// scripts/test-official-showcase.mjs):
//   - the pre-login strip renders official cards and NEVER writes: clicking a
//     card surfaces the sign-in guidance line only
//   - an empty/failed showcase answer renders nothing on the login page
//   - the market face: the official chip renders only when official rows
//     exist, filters to them, and official cards carry the badge

const SHOWCASE = {
  templates: [
    { id: "tpl_1", name: "Service Desk Crew", description: "Three-post support team, honest degradation.", official: true },
  ],
  assistants: [],
  featured: [
    { id: "feat_1", name: "Official Pick", description: "Curated by operations.", official: true },
  ],
};

const MARKET_ROWS = [
  { id: "off_1", name: "Official Pack", description: "roster author", tags: [], version: 1, official: true, badge: "blueprint", category: "ops" },
  { id: "com_1", name: "Community Pack", description: "outsider author", tags: [], version: 1, official: false, badge: "toolkit", category: "ops" },
];

const CONFIG = {
  documentsEnabled: false,
  packMarketplace: true,
  lineBoardsEnabled: false,
  copilotEnabled: true,
  compositionModesVisible: false,
  roles: null,
  resolvedLayout: null,
  voice: null,
  loginHero: null,
  companyName: null,
  assistantName: null,
  brandIconUrl: null,
  loginFooterText: null,
  authEnabled: true,
  loginUrl: "/auth/login",
  ssoEnabled: false,
};

test.describe("official showcase faces", () => {
  test("pre-login strip: cards render, click surfaces sign-in guidance, no writes", async ({ page }) => {
    await pinLocaleEn(page);
    let writes = 0;
        await page.route("**/api/*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ mode: "logto", email: null, groups: null, authenticated: false, loginUrl: "/auth/login", logoutUrl: "/logout", ssoConfigured: false, ssoAuthenticated: false, ssoEmail: null, ssoGroups: null }),
      }),
    );
    await page.route("**/api/config", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(CONFIG) }));
    await page.route("**/api/packs/official", (route) => {
      if (route.request().method() !== "GET") writes += 1;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(SHOWCASE) });
    });

    await page.goto("/login");
    // loginHero: null in the fixture → the neutral layout mounts the strip
    // under the -neutral testId (the hero layout uses the base id).
    const strip = page.getByTestId("login-official-neutral");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Service Desk Crew");
    await expect(strip).toContainText("Official Pick");
    await page.getByTestId("login-official-neutral-card-tpl_1").click();
    await expect(page.getByTestId("login-official-neutral-hint")).toBeVisible();
    expect(writes, "the strip never issues a write").toBe(0);
  });

  test("empty showcase answer renders nothing on the login page", async ({ page }) => {
    await pinLocaleEn(page);
    await page.route("**/api/*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ mode: "logto", email: null, groups: null, authenticated: false, loginUrl: "/auth/login", logoutUrl: "/logout", ssoConfigured: false, ssoAuthenticated: false, ssoEmail: null, ssoGroups: null }),
      }),
    );
    await page.route("**/api/config", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(CONFIG) }));
    await page.route("**/api/packs/official", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ templates: [], assistants: [], featured: [] }) }),
    );

    await page.goto("/login");
    await expect(page.getByTestId("login-page")).toBeVisible();
    await expect(page.getByTestId("login-official")).toHaveCount(0);
    await expect(page.getByTestId("login-official-neutral")).toHaveCount(0);
  });

  test("market face: official chip filters and official cards badge", async ({ page }) => {
    await pinLocaleEn(page);
        await page.route("**/api/*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ mode: "none", email: null, groups: null, authenticated: false, loginUrl: "/auth/login", logoutUrl: "/logout", ssoConfigured: false, ssoAuthenticated: false, ssoEmail: null, ssoGroups: null }),
      }),
    );
    await page.route("**/api/config", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(CONFIG) }));
    await page.route("**/api/packs**", (route) => {
      const url = new URL(route.request().url());
      const _official = url.searchParams.get("official");
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ total: MARKET_ROWS.length, page: 1, pageSize: 50, packs: MARKET_ROWS }),
      });
    });

    await page.goto("/packs");
    // Chip renders because official rows exist; toggling filters to them.
    await expect(page.getByTestId("pack-official-chip")).toBeVisible();
    await expect(page.getByTestId("pack-card-off_1")).toBeVisible();
    await expect(page.getByTestId("pack-card-com_1")).toBeVisible();
    await page.getByTestId("pack-official-chip").click();
    // The official filter switches the gallery tile (add-official-agent-gallery),
    // which carries its own anchor; community rows leave the gallery projection.
    await expect(page.getByTestId("pack-gallery-card-off_1")).toBeVisible();
    await expect(page.getByTestId("pack-gallery-card-com_1")).toHaveCount(0);
    await expect(page.getByTestId("pack-official-badge-off_1")).toBeVisible();
  });
});
