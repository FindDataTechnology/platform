#!/usr/bin/env node
// Mint with the group attached at creation (the panel UI's own dropdown sends
// this field; the API accepts it on POST).
import { chromium } from "playwright";
const EMAIL = "p2walk1025@findmail.com";
const PASSWORD = "P2wlk#1025T";
const PANEL = "https://token.finddatatech.cloud";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(`${PANEL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await page.getByText(/Continue with OIDC/).click();
  await page.waitForTimeout(6_000);
  const id = page.locator('input[name="identifier"]');
  if (await id.isVisible().catch(() => false)) {
    await id.fill(EMAIL); await id.press("Enter"); await page.waitForTimeout(2_500);
  }
  const pw = page.locator('input[name="password"]');
  await pw.waitFor({ state: "visible", timeout: 30_000 });
  await pw.fill(PASSWORD); await pw.press("Enter");
  for (let i = 0; i < 12; i++) { await page.waitForTimeout(2_000); if (/auth\/oidc\/callback/.test(page.url())) break; }
  await page.waitForTimeout(4_000);
  const out = await page.evaluate(async () => {
    const token = localStorage.getItem("auth_token");
    const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    for (const body of [
      { name: "m53-drill-2", group_ids: [3] },
      { name: "m53-drill-2", group_id: 3 },
    ]) {
      const r = await fetch("/api/v1/keys", { method: "POST", headers: H, body: JSON.stringify(body) }).catch(() => null);
      const doc = r ? await r.json().catch(() => null) : null;
      if (r?.ok && doc?.code === 0) return { created: true, key: doc.data.key, groupId: doc.data.group_id };
    }
    return { created: false };
  });
  console.log(JSON.stringify(out));
  if (out.created) process.stdout.write(out.key);
} finally {
  await browser.close();
}
