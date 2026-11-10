import { test, expect } from "@playwright/test";
import { gotoChat, openSettings, pinLocaleEn } from "./helpers.js";

// 事项接入分区 (widen-deputy-to-personal-domains 6.1/6.2) — 浏览器冒烟。
//
// 源码层面看不出、只有真跑才知道的两件事：
//   1. 分区真的挂载（surface registry 与 sections.ts 双向一致还不够）；
//   2. 三个来源默认全关——「升级不动任何行为」这个承诺要在 UI 上成立，而不是
//      只在归一化函数里成立。

test.describe("settings · matter intake", () => {
  test("opens with every source off and names its target domain", async ({ page }) => {
    await pinLocaleEn(page);
    await gotoChat(page);
    await openSettings(page);

    await page.getByTestId("settings-section-mandate-intake").click();
    await expect(page).toHaveURL(/\/settings\/mandate-intake$/);
    await expect(page.getByTestId("mandate-intake-section")).toBeVisible({ timeout: 15000 });

    for (const source of ["cross-line-blocker", "supplier-thread", "people-schedule"]) {
      const row = page.getByTestId(`mandate-intake-row-${source}`);
      await expect(row).toBeVisible();
      await expect(page.getByTestId(`mandate-intake-toggle-${source}`)).toHaveAttribute("aria-checked", "false");
    }

    // 每个来源都明示「会进哪个域」，否则开关是个黑盒。
    await expect(page.getByTestId("mandate-intake-row-cross-line-blocker")).toContainText(/ops/);
    await expect(page.getByTestId("mandate-intake-row-supplier-thread")).toContainText(/external-comms/);
  });

  test("turning intake on survives a reload", async ({ page }) => {
    await pinLocaleEn(page);
    await gotoChat(page);
    await openSettings(page);
    await page.getByTestId("settings-section-mandate-intake").click();
    await expect(page.getByTestId("mandate-intake-section")).toBeVisible({ timeout: 15000 });

    await page.getByTestId("mandate-intake-toggle-cross-line-blocker").click();
    await expect(page.getByTestId("mandate-intake-toggle-cross-line-blocker")).toHaveAttribute("aria-checked", "true");

    await page.reload();
    await openSettings(page);
    await page.getByTestId("settings-section-mandate-intake").click();
    await expect(page.getByTestId("mandate-intake-section")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("mandate-intake-toggle-cross-line-blocker")).toHaveAttribute("aria-checked", "true");
  });
});

// 就绪结论（2026-11-10）：七处开关分散在三处，配错的表现是「代理很安静」。
// 这里断言「结论一定在场」，而不是断言某个具体文案——文案会改，结论不能没有。
test("the pane states a readiness verdict, with fixes for what is missing", async ({ page }) => {
  await pinLocaleEn(page);
  await gotoChat(page);
  await openSettings(page);
  await page.getByTestId("settings-section-mandate-intake").click();
  await expect(page.getByTestId("mandate-intake-section")).toBeVisible({ timeout: 45000 });

  const box = page.getByTestId("mandate-readiness");
  await expect(box).toBeVisible({ timeout: 20000 });
  // 空部署：判为未就绪，且至少给出一条带修法的缺项
  await expect(box).toHaveAttribute("data-ready", "0");
  await expect(box).toContainText(/还不能用/);
});
