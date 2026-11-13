// 语义档的「已配置通道」支路：披露先出 → 勾选后才可开启 → 开启后状态可见 → 关闭即时生效。
//
// 前置条件：服务端必须真的配了嵌入通道（LIBRARY_SEMANTIC_RUNG=on 且
// LIBRARY_EMBED_BASE_URL/MODEL 指向替身）。默认套件不配这些变量，所以这里显式
// skip，而不是让它在没配通道的实例上假红：
//
//   LIBRARY_SEMANTIC_RUNG=on LIBRARY_EMBED_BASE_URL=http://127.0.0.1:3197 \
//   LIBRARY_EMBED_MODEL=e2e-embed LIBRARY_EMBED_DIMENSIONS=8 \
//   npx playwright test e2e/rung-enable.spec.js --project=fast
import { test, expect } from "@playwright/test";
import { pinLocaleEn } from "./helpers.js";

const LANE_CONFIGURED = process.env.LIBRARY_SEMANTIC_RUNG === "on"
  && Boolean(process.env.LIBRARY_EMBED_BASE_URL)
  && Boolean(process.env.LIBRARY_EMBED_MODEL);
test.skip(!LANE_CONFIGURED, "需要已配置嵌入通道的服务端；见本文件顶部命令");

test("semantic rung: disclosure gates the enable, then enabling sticks", async ({ page }) => {
  await pinLocaleEn(page);
  await page.goto("/knowledge");
  const section = page.getByTestId("retrieval-section");
  await expect(section).toBeVisible({ timeout: 30000 });

  // 通道已配置 → 不应出现「不可用」提示
  await expect(page.getByTestId("retrieval-blocked")).toHaveCount(0);
  const sw = page.getByTestId("retrieval-switch");
  await expect(sw).toBeEnabled();

  // 披露尚未出现：看不见等于没同意
  await expect(page.getByTestId("retrieval-disclosure")).toHaveCount(0);

  // 点开关 → 展开披露（此时仍未开启）
  await sw.click();
  const disclosure = page.getByTestId("retrieval-disclosure");
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText("embedding lane");

  // 未勾选 → 开启按钮禁用（同意不能被跳过）
  const enable = page.getByTestId("retrieval-enable");
  await expect(enable).toBeDisabled();

  // 勾选 → 按钮可用 → 开启
  await page.getByTestId("retrieval-ack").check();
  await expect(enable).toBeEnabled();
  await enable.click();

  // 开启后：开关为选中态、披露收起、显示模型行与确认时间
  await expect(sw).toBeChecked({ timeout: 15000 });
  await expect(page.getByTestId("retrieval-disclosure")).toHaveCount(0);
  await expect(page.getByTestId("retrieval-model")).toBeVisible();
  await expect(page.getByTestId("retrieval-ack-note")).toBeVisible();

  // 再关掉：立即生效，不需要二次确认
  await sw.click();
  await expect(sw).not.toBeChecked({ timeout: 15000 });
});
