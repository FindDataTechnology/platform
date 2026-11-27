import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// restructure-yizuo-ia — the doorways.
//
// Before this change three surfaces existed in the router but had NO link in the
// UI, so the capability behind them was reachable only by typing a URL:
//   /tuning                  skill-candidate review + persona amendments (0 links)
//   /packs                   creator drafts + publish (0 links)
//   /settings/delegation     defined in sections.ts but absent from the surface
//                            registry, so the modal — which renders only
//                            registry-resolved slugs — could never show it
// This spec pins that every one of them is now reachable by clicking, and that
// the merged/relocated routes keep their legacy addresses resolving.

test.describe("every work surface has a door", () => {
  test("调优 is a nav entry in the build family", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/chat");
    const tuning = page.getByTestId("nav-tuning");
    await expect(tuning).toBeVisible({ timeout: 15000 });
    await expect(tuning).toHaveAttribute("href", "/tuning");
    await expect(page.getByTestId("nav-family-build")).toContainText("Tuning");
    await tuning.click();
    await expect(page.getByTestId("tuning-page")).toBeVisible();
    await expect(page).toHaveURL(/\/tuning$/);
  });

  test("capability settings shortcuts are retired; models stays a Settings section", async ({ page }) => {
    // unify-material-market: the three rows looked like navigation but opened the
    // Settings modal — and after the market grew tabs they had nothing left to
    // point at beyond 模型, which is a plain Settings section. No rows exist now.
    await pinLocaleEn(page);
    await page.goto("/chat");
    await expect(page.getByTestId("nav-family-build-shortcuts")).toHaveCount(0);
    // 模型 is still reachable as configuration.
    await page.goto("/settings/models");
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "models");
  });

  test("delegation is finally listed in Settings", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/delegation");
    await expect(page.getByTestId("settings-section-delegation")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", "delegation");
  });

  test("渠道 left Settings for the access family and answers at /channels", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/chat");
    const channels = page.getByTestId("nav-channels");
    await expect(channels).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("nav-family-access")).toContainText("Channels");
    await channels.click();
    await expect(page.getByTestId("bots-page")).toBeVisible();
    // The old Settings addresses hand over to the nav surface instead of
    // opening a modal section that no longer exists.
    await page.goto("/settings/channels");
    await expect(page).toHaveURL(/\/channels$/);
    await page.goto("/bots");
    await expect(page).toHaveURL(/\/channels$/);
  });

  test("the market surface carries the four capability species plus mine", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/agents");
    for (const slug of ["agents", "tools", "skills", "plugins", "mine"]) {
      await expect(page.getByTestId(`agent-market-tab-${slug}`)).toBeVisible({ timeout: 15000 });
    }
    // The retired four-zone hub's tabs stay gone.
    for (const slug of ["build", "supply", "creations", "tuning", "apps"]) {
      await expect(page.getByTestId(`agents-tab-${slug}`)).toHaveCount(0);
    }
  });
});

test.describe("legacy pack deep links still land", () => {
  test("/packs?tab=mine lands on the mine tab", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/packs?tab=mine");
    await expect(page).toHaveURL(/\/agents\?tab=mine$/);
    await expect(page.getByTestId("agent-market-tab-mine")).toHaveAttribute("data-active", "true");
  });

  test("/packs keeps an unknown query param (the deploy handoff)", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/packs?deployCastPack=cast_probe_pack&v=2");
    await expect(page).toHaveURL(/\/agents\?.*deployCastPack=cast_probe_pack/);
    await expect(page.getByTestId("agent-market-page")).toBeVisible();
  });

  test("a retired tab slug resolves instead of erroring", async ({ page }) => {
    await pinLocaleEn(page);
    // `market` was the pack browse tab before the surface grew species tabs;
    // it normalizes onto `agents` rather than dead-ending.
    await page.goto("/agents?tab=market");
    await expect(page.getByTestId("agent-market-page")).toBeVisible();
    await expect(page.getByTestId("agent-market-tab-agents")).toHaveAttribute("data-active", "true");
    // and the retired 专家 slug still lands on 我的
    await page.goto("/agents?tab=creations");
    await expect(page.getByTestId("agent-market-tab-mine")).toHaveAttribute("data-active", "true");
  });
});

test.describe("settings search", () => {
  test("filters the resolved list and never widens it", async ({ page }) => {
    await pinLocaleEn(page);
    await page.goto("/settings/general");
    const search = page.getByTestId("settings-search");
    await expect(search).toBeVisible({ timeout: 15000 });
    await search.fill("model");
    await expect(page.getByTestId("settings-section-models")).toBeVisible();
    await expect(page.getByTestId("settings-section-pairing")).toHaveCount(0);
    await search.fill("");
    await expect(page.getByTestId("settings-section-pairing")).toBeVisible();
    // No match → an explicit empty line, not a blank rail.
    await search.fill("zzz-nothing");
    await expect(page.getByTestId("settings-search-empty")).toBeVisible();
  });
});
