import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

// App center sentinel (openspec: add-app-center 1.5): nav reachability, the
// five line cards render, the platform-self card has no outbound link, early
// lines wear the honest badge, and outbound links carry the right hrefs.
// The platform-apps section is deployment-dependent (role-filtered catalog)
// so this spec only asserts it never breaks the page.

test("nav item reaches the app center", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/chat");
  await expect(page.getByTestId("nav-apps")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("nav-apps").click();
  await expect(page.getByTestId("app-center-page")).toBeVisible();
});

test("five product line cards render with honest states", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });

  for (const id of ["yizuo", "facet", "wanxing", "lex", "wire"]) {
    await expect(page.getByTestId(`app-card-${id}`)).toBeVisible();
  }

  // The platform itself: "you are here", no outbound link.
  await expect(page.getByTestId("app-card-yizuo-self")).toBeVisible();
  await expect(page.getByTestId("app-card-yizuo-open")).toHaveCount(0);

  // Early lines (lex, wire) wear the badge; live lines do not.
  await expect(page.getByTestId("app-card-lex-early-badge")).toBeVisible();
  await expect(page.getByTestId("app-card-wire-early-badge")).toBeVisible();
  await expect(page.getByTestId("app-card-facet-early-badge")).toHaveCount(0);
});

test("line cards link out to each line's own domain", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });

  await expect(page.getByTestId("app-card-facet-open")).toHaveAttribute(
    "href",
    "https://facet.finddatatech.cloud",
  );
  await expect(page.getByTestId("app-card-wanxing-open")).toHaveAttribute(
    "href",
    "https://wanxing.finddatatech.cloud",
  );
  await expect(page.getByTestId("app-card-lex-open")).toHaveAttribute(
    "href",
    "https://lex.finddatatech.cloud",
  );
  await expect(page.getByTestId("app-card-wire-open")).toHaveAttribute(
    "href",
    "https://wire.finddatatech.cloud",
  );
});

test("platform products section renders the authored catalog entries", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/apps");
  await expect(page.getByTestId("app-center-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("app-center-lines")).toBeVisible();
  // The products section is catalog-driven: the bundled agents.json entries
  // (壹座·Packs / 萬星·词元 / 萬星·连接器) surface as product cards.
  await expect(page.getByTestId("app-center-platform-apps")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("app-card-yizuo-packs")).toBeVisible();
  await expect(page.getByTestId("app-card-wanxing-token")).toBeVisible();
  await expect(page.getByTestId("app-card-wanxing-connector")).toBeVisible();
});
