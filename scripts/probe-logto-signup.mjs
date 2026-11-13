import { chromium } from "playwright";
const STAMP = "k7d" + Date.now().toString(36).slice(-6);
const EMAIL = `${STAMP}@findmail.com`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto("https://token.finddatatech.cloud/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await page.getByText(/Continue with OIDC/).click();
  await page.waitForTimeout(6_000);
  const id = page.locator('input[name="identifier"]');
  await id.waitFor({ state: "visible", timeout: 25_000 });
  await id.fill(EMAIL); await id.press("Enter"); await page.waitForTimeout(3_000);
  const back = page.getByText("返回").first();
  if (await back.isVisible().catch(() => false)) { await back.click(); await page.waitForTimeout(2_500); }
  await page.getByText("注册", { exact: true }).first().click();
  await page.waitForTimeout(3_000);
  await page.locator('input[name="identifier"], input[type="email"], input:not([type=password])').first().fill(EMAIL);
  await page.getByRole("button", { name: "注册" }).click();
  await page.waitForTimeout(3_000);
  // Verification-code screen: sign_up.verify=true demands an emailed code.
  // No SMTP on this Logto (instance has none) — the code screen dead-ends here.
  const body = (await page.locator("body").innerText()).slice(0, 260).replace(/\n+/g, " | ");
  console.log("verification screen:", body);
  console.log("VERDICT: registration requires email verification code — SMTP needed");
} catch (e) { console.error("ERR", e.message.slice(0, 150)); } finally { await browser.close(); }
