import { test, expect } from "@playwright/test";
import { gotoChat, openSettings, pinLocaleEn } from "./helpers.js";

// 委托状设置面 (add-personal-mandate 7.2/7.3) — 浏览器冒烟。
//
// 钉三件在源码里看不出、只有真跑起来才知道的事：
//   1. 分区真的能进（surface registry 与 sections.ts 双向一致还不够，
//      组件自己也要挂载成功）；
//   2. 全新 cell 打开时四域都是「只给建议」且没有任何额度——默认不放大的
//      承诺必须在 UI 上成立，而不是只在 resolver 里成立；
//   3. 改一个域并保存后，刷新仍然是新值（走的是真 PUT + 真读回）。

test.describe("settings · mandate", () => {
  test("opens with every domain defaulting to advise and no quota", async ({ page }) => {
    await pinLocaleEn(page);
    await gotoChat(page);
    await openSettings(page);

    await page.getByTestId("settings-section-mandate").click();
    await expect(page).toHaveURL(/\/settings\/mandate$/);
    await expect(page.getByTestId("mandate-section")).toBeVisible({ timeout: 15000 });

    for (const domain of ["ops", "external-comms", "advancement", "research"]) {
      const card = page.getByTestId(`mandate-domain-${domain}`);
      await expect(card).toBeVisible();
      // Every domain reads `advise` with no quota — the floor, not a pre-filled
      // grant. `ops` is the one domain that always exists: it carries the legacy
      // delegation policy, whose defaults (enabled:false) resolve to advise. The
      // other three stay absent until the owner creates them.
      await expect(page.getByTestId(`mandate-mode-${domain}`)).toHaveValue("advise");
      await expect(page.getByTestId(`mandate-quota-${domain}`)).toHaveValue("");
      if (domain !== "ops") {
        await expect(card).not.toHaveAttribute("data-configured", "true");
      }
    }

    // The non-downgradable constraint is stated on the surface, not hidden.
    await expect(page.getByTestId("mandate-section")).toContainText(/Publishing and destructive actions/i);
  });

  test("saving a domain mode survives a reload", async ({ page }) => {
    await pinLocaleEn(page);
    await gotoChat(page);
    await openSettings(page);
    await page.getByTestId("settings-section-mandate").click();
    await expect(page.getByTestId("mandate-section")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("mandate-mode-external-comms").selectOption("draft");
    await page.getByTestId("mandate-quota-external-comms").fill("3");
    await page.getByTestId("mandate-discloseScope-external-comms-public").click();
    await page.getByTestId("mandate-save").click();
    await expect(page.getByTestId("mandate-saved")).toBeVisible({ timeout: 10000 });

    await page.reload();
    await openSettings(page);
    await page.getByTestId("settings-section-mandate").click();
    await expect(page.getByTestId("mandate-section")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("mandate-mode-external-comms")).toHaveValue("draft");
    await expect(page.getByTestId("mandate-quota-external-comms")).toHaveValue("3");
    await expect(page.getByTestId("mandate-discloseScope-external-comms-public")).toHaveAttribute("aria-pressed", "true");
  });
});
