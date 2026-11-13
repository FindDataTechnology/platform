#!/usr/bin/env node
// ── Live drill: the visitor matters panel (matter-threads V2) ────────────────
// Login → ask the reception to open a matter → reload → the chat page's
// 「我的事项」 panel must render the matter with 待回应 badge.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dotenv = (k) => readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
const EMAIL = process.env.VISITOR_EMAIL || dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = process.env.VISITOR_PASSWORD || dotenv("PAAS_TEST_PASSWORD");
const CHAT_URL = process.argv[2] || "https://wanxing.finddatatech.cloud/#/chat/packs-ut_bjmuw5kxad83kimpmlg-reception";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
  const gate = page.getByText(/使用寻数账号登录/);
  if (await gate.isVisible().catch(() => false)) {
    await gate.click();
    await page.waitForTimeout(5_000);
    const id = page.locator('input[name="identifier"]');
    await id.waitFor({ state: "visible", timeout: 30_000 });
    await id.fill(EMAIL); await id.press("Enter"); await page.waitForTimeout(2_000);
    const pw = page.locator('input[name="password"]');
    await pw.waitFor({ state: "visible", timeout: 30_000 });
    await pw.fill(PASSWORD); await pw.press("Enter");
    for (let i = 0; i < 10; i++) { await page.waitForTimeout(2_000); if (i > 1 && /wanxing\.finddatatech/.test(page.url())) break; }
    await page.waitForTimeout(6_000);
  }
  const box = page.getByPlaceholder(/说点什么/);
  await box.waitFor({ state: "visible", timeout: 45_000 });
  await box.fill("请调用 matter_open 开一个事项，摘要「面板终验：访客身份 scope」，访客线索「终验号」。告诉我事项号。");
  await page.getByRole("button", { name: "发送" }).click();
  let matterId = "";
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2_000);
    const body = await page.locator("body").innerText();
    const m = body.match(/mt_[0-9a-f]{24}/);
    if (m && !/回复中/.test(body)) { matterId = m[0]; break; }
  }
  console.log("opened:", matterId || "(none)");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8_000);
  const panel = page.getByTestId("chat-matters-panel");
  const visible = await panel.isVisible().catch(() => false);
  console.log("panel visible:", visible);
  if (visible) {
    const text = await panel.innerText();
    console.log("panel text:", text.replace(/\n+/g, " | ").slice(0, 260));
  }
  if (matterId) {
    const row = page.getByTestId(`chat-matter-${matterId}`);
    console.log("matter row rendered:", await row.isVisible().catch(() => false));
  }
  process.exit(visible && matterId ? 0 : 1);
} finally {
  await browser.close();
}
