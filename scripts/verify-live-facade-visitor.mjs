#!/usr/bin/env node
// ── Live drill: logged-in tenant visitor turn on a deployed facade ──────────
//
// Collects the chat-lane positive sample (add-principal-facade / §15.37
// closing note): Logto login → auth exchange → chat POST → SSE reply →
// quota metered, no paywall. The visitor question should be answerable from
// the pack's corpus; the reply text is asserted to RENDER in the page (the
// runaway-turn regression showed replies never rendering is possible).
//
// Credentials come from the repo .env (PAAS_TEST_IDENTIFIER/PASSWORD) or
// VISITOR_EMAIL/VISITOR_PASSWORD overrides — never hardcoded.
//
//   node scripts/verify-live-facade-visitor.mjs [chat-url] [question]
//
// Defaults: the 寻数分身 reception chat entry.

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function dotenv(key) {
  const m = readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}
const EMAIL = process.env.VISITOR_EMAIL || dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = process.env.VISITOR_PASSWORD || dotenv("PAAS_TEST_PASSWORD");
if (!EMAIL || !PASSWORD) throw new Error("visitor credentials missing (.env or VISITOR_EMAIL/VISITOR_PASSWORD)");

const CHAT_URL = process.argv[2] || "https://wanxing.finddatatech.cloud/#/chat/packs-ut_bjmuw5kxad83kimpmlg-reception";
const QUESTION = process.argv[3] || "你们是做什么的？一句话说清。";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const api = [];
page.on("response", async (res) => {
  const u = res.url();
  if (!/\/api\/wanxing\/v1\//.test(u)) return;
  api.push(`${res.request().method()} ${res.status()} ${u.split("/v1/")[1]?.slice(0, 60)}`);
});
try {
  await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3_000);
  const gate = page.getByText(/使用寻数账号登录/);
  if (await gate.isVisible().catch(() => false)) {
    await gate.click();
    await page.waitForTimeout(5_000);
    const id = page.locator('input[name="identifier"]');
    await id.waitFor({ state: "visible", timeout: 30_000 });
    await id.fill(EMAIL);
    await id.press("Enter");
    await page.waitForTimeout(2_000);
    const pw = page.locator('input[name="password"]');
    await pw.waitFor({ state: "visible", timeout: 30_000 });
    await pw.fill(PASSWORD);
    await pw.press("Enter");
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(2_000);
      if (i > 1 && /wanxing\.finddatatech/.test(page.url())) break;
    }
    // IdP interstitials (already-signed-in confirm screens) click through.
    for (const label of ["继续", "Continue", "确认", "授权", "Allow"]) {
      const btn = page.getByRole("button", { name: label });
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(4_000);
      }
    }
  }
  const box = page.getByPlaceholder(/说点什么/);
  await box.waitFor({ state: "visible", timeout: 45_000 });
  const quotaBefore = (await page.locator("body").innerText()).match(/免费额度剩余[^\n]*/)?.[0] ?? "(n/a)";
  await box.fill(QUESTION);
  await page.getByRole("button", { name: "发送" }).click();
  let body = "";
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2_000);
    body = await page.locator("body").innerText();
    if (!/回复中/.test(body)) break;
  }
  const after = body.split(QUESTION)[1] ?? "";
  const quotaAfter = body.match(/免费额度剩余[^\n]*/)?.[0] ?? "(n/a)";
  const rendered = after.replace(/\n+/g, " ").trim().slice(0, 60);
  console.log("quota:", quotaBefore, "→", quotaAfter);
  console.log("reply rendered:", rendered ? `YES — ${rendered}…` : "NO (turn may still be streaming)");
  console.log("paywall:", /余额不足|请充值/.test(body) ? "YES" : "no");
  console.log("lane api:", api.slice(0, 6).join(" | "));
  if (!rendered) process.exit(1);
} finally {
  await browser.close();
}
