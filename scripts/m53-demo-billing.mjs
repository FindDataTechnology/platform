import { chromium } from "playwright";
const EMAIL = "facet-demo@findmail.com";
const PASSWORD = "0DNVg-oB";
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
  await page.waitForTimeout(6_000);
  console.log("landed:", page.url().slice(0, 80));
  console.log("body:", (await page.locator("body").innerText()).slice(0, 200).replace(/\n+/g, " | "));
  const out = await page.evaluate(async () => {
    const token = localStorage.getItem("auth_token");
    const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const r = await fetch("/api/v1/keys", { method: "POST", headers: H, body: JSON.stringify({ name: "m53-deploy", group_id: 3 }) });
    const doc = await r.json();
    return { status: r.status, code: doc?.code, message: doc?.message, key: doc?.data?.key ?? null, groupId: doc?.data?.group_id ?? null };
  });
  console.log(JSON.stringify(out));
} finally { await browser.close(); }
