import { test, expect } from "@playwright/test";
import { gotoChat, openSettings, pinLocaleEn } from "./helpers.js";

// 层级样本面 (add-principal-disclosure-gate 6.4)。
//
// 屏幕上的承诺是「缺哪一层不能自动说话」。所以断言的不是「有五行」，
// 而是每一行都同时给出**数字**与**该层能不能放量**——只有一个总数的话，
// 主人知道「还不够」却不知道要去补哪一层。

test.describe("settings · disclosure levels", () => {
  test("every disclosure level shows its sample count and whether it may auto-send", async ({ page }) => {
    await pinLocaleEn(page);
    await gotoChat(page);
    await openSettings(page);
    await page.getByTestId("settings-section-mandate-intake").click();
    await expect(page.getByTestId("mandate-intake-section")).toBeVisible({ timeout: 15000 });

    for (const level of ["public", "internal", "confidential", "hr", "finance"]) {
      const row = page.getByTestId(`mandate-level-${level}`);
      await expect(row).toBeVisible();
      // 空样本的新部署：每一行都应当显示 0 且标记为不足。
      await expect(page.getByTestId(`mandate-level-state-${level}`)).toContainText("0");
      await expect(page.getByTestId(`mandate-level-state-${level}`)).toContainText(/Not enough samples/i);
    }
  });
});
