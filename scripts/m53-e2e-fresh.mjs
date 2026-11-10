#!/usr/bin/env node
// K7 closure drill: a BRAND-NEW account (no ops touch at all) — OIDC signup
// → panel opens → mint key with the default subscription group → key works.
import { chromium } from "playwright";
const PANEL = "https://token.finddatatech.cloud";
const STAMP = "k7" + Date.now().toString(36).slice(-6);
const EMAIL = `${STAMP}@findmail.com`;
const PASSWORD = "K7drill#2026";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(`${PANEL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  // Logto SSO: the Logto side auto-registers on first SSO (email-verified upstream)
  await page.getByText(/Continue with OIDC/).click();
  await page.waitForTimeout(6_000);
  const id = page.locator('input[name="identifier"]');
  await id.waitFor({ state: "visible", timeout: 30_000 });
  await id.fill(EMAIL); await id.press("Enter"); await page.waitForTimeout(3_000);
  // Unknown identity → sign-in refused → back → 注册 (K7 fix: register enabled)
  const back = page.getByText("返回").first();
  if (await back.isVisible().catch(() => false)) { await back.click(); await page.waitForTimeout(2_500); }
  await page.getByText("注册", { exact: true }).first().click(); await page.waitForTimeout(3_000);
  await page.locator('input[name="identifier"], input[type="email"], input:not([type=password])').first().fill(EMAIL);
  await page.getByRole("button", { name: "注册" }).click(); await page.waitForTimeout(3_000);
  // Email verification code screen — a real user reads their inbox; this
  // drill stops here and reports the state (the code itself is in the mail).
  const body = (await page.locator("body").innerText()).slice(0, 200).replace(/\n+/g, " | ");
  console.log("state:", body);
  const pw = page.locator('input[name="password"]');
  await pw.fill(PASSWORD); await pw.press("Enter");
  await page.waitForTimeout(2_500);
  const pw2 = page.locator('input[name="confirm-password"], input[name="password2"], input[name="confirmPassword"]');
  if (await pw2.isVisible().catch(() => false)) {
    await pw2.fill(PASSWORD); await pw2.press("Enter");
  }
  for (let i = 0; i < 14; i++) { await page.waitForTimeout(2_000); if (/auth\/oidc\/callback/.test(page.url()) || /dashboard/.test(page.url())) break; }
  console.log("landed:", page.url().slice(0, 90));
  await page.waitForTimeout(5_000);
  const out = await page.evaluate(async () => {
    const token = localStorage.getItem("auth_token");
    if (!token) return { token: false };
    const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const me = await (await fetch("/api/v1/users/me", { headers: H })).json().catch(() => null);
    const r = await fetch("/api/v1/keys", { method: "POST", headers: H, body: JSON.stringify({ name: "k7-drill", group_id: 3 }) });
    const doc = await r.json();
    return { token: true, uid: me?.data?.id ?? me?.id, allowed: me?.data?.allowed_groups ?? me?.allowed_groups, keyStatus: r.status, code: doc?.code, key: doc?.data?.key ?? null, groupId: doc?.data?.group_id ?? null, msg: doc?.message };
  });
  console.log("account:", JSON.stringify(out).slice(0, 300));
  if (out.key) {
    // Direct probe through the SAME panel origin (the /v1 gateway proxies there too)
    const probe = await page.evaluate(async (k) => {
      const r = await fetch("/v1/models", { headers: { Authorization: `Bearer ${k}` } });
      return r.status;
    }, out.key);
    console.log("key probe:", probe);
  }
} catch (e) {
  console.error("ERR", e.message.slice(0, 200));
} finally {
  await browser.close();
}
