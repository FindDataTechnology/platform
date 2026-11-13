// Live verification of add-deployment-branding + ADMIN_GROUPS on craw.finddatatech.cloud
// Drives a real browser: Logto login -> admin section -> save branding
// -> anonymous login page render -> cleanup. Prints PASS/FAIL per step.
import { chromium } from "playwright";

const BASE = "https://craw.finddatatech.cloud";
// Which account to log in as comes from the environment only: this repo is
// public on GitHub, so no real account name or address may be a default here.
const EMAIL = process.env.LIVE_EMAIL || "";
const PASSWORD = process.env.LIVE_PW;
if (!PASSWORD || !EMAIL) {
  console.error("LIVE_EMAIL and LIVE_PW env vars required (the account to log in as)");
  process.exit(2);
}

const results = [];
function ok(name, cond, extra = "") {
  results.push({ name, pass: Boolean(cond), extra });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
}

const browser = await chromium.launch();
try {
  // ── 1. Anonymous /login renders with locale picker + unbranded defaults ──
  const anon = await browser.newContext({ locale: "en-US" });
  const anonPage = await anon.newPage();
  await anonPage.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await anonPage.waitForSelector('[data-testid="login-page"]', { timeout: 20000 });
  ok("anonymous /login renders", true);
  ok("locale picker present", await anonPage.getByTestId("login-locale-select").count() === 1);
  ok("unbranded: no icon img", (await anonPage.getByTestId("login-brand-icon").count()) === 0);
  ok("unbranded: no footer", (await anonPage.getByTestId("login-footer").count()) === 0);
  ok("unbranded: no favicon link", await anonPage.evaluate(() => document.querySelector('link[rel="icon"]') === null));
  const loginHref = await anonPage.getByTestId("sso-login").getAttribute("href");
  ok("login link carries rd + ui_locales", loginHref.includes("rd=") && loginHref.includes("ui_locales="), loginHref);

  // ── 2. Pick zh-CN, sign in through the hosted Logto page ──
  await anonPage.getByTestId("login-locale-select").selectOption("zh-CN");
  await expectText(anonPage, "h1", "登录");

  // Start from a deep link so rd carry-through is exercisable: /settings/account.
  await anonPage.goto(`${BASE}/settings/account`, { waitUntil: "domcontentloaded" });
  await anonPage.waitForSelector('[data-testid="login-page"]', { timeout: 20000 });
  console.log(`INFO deep-link login href: ${await anonPage.getByTestId("sso-login").getAttribute("href")}`);
  await anonPage.getByTestId("sso-login").click();
  await anonPage.waitForURL(/auth\.finddatatech\.cloud/, { timeout: 30000 });
  console.log(`INFO hosted url: ${anonPage.url().slice(0, 160)}`);

  // Logto's sign-in experience is an SPA that strips the query after hydration,
  // so the settled page — not the URL — is the evidence for ui_locales. (The
  // passthrough itself is proven server-side: /auth/login → /oidc/auth carries
  // ui_locales, and Logto 303s to /sign-in?...&ui_locales=<v>.) The tenant may
  // still render English; that is Logto's business, so it is INFO, not FAIL.
  const idInput = anonPage.locator('input[name="identifier"], input[type="email"], input[name="email"]');
  await idInput.first().waitFor({ state: "visible", timeout: 30000 });
  const settled = await anonPage.evaluate(() => ({ lang: document.documentElement.lang || "", text: document.body.innerText.slice(0, 400) }));
  const zhHosted = /登录|继续|密码/.test(settled.text);
  console.log(`INFO hosted page lang=${settled.lang || "<unset>"} zhText=${zhHosted} :: ${settled.text.replace(/\s+/g, " ").slice(0, 120)}`);

  await idInput.first().fill(EMAIL);
  await anonPage.getByRole("button", { name: /继续|Continue|Next|下一步/i }).click().catch(async () => {
    await anonPage.keyboard.press("Enter");
  });
  await anonPage.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000 });
  await anonPage.fill('input[type="password"], input[name="password"]', PASSWORD);
  await anonPage.getByRole("button", { name: /登录|Continue|Next|Sign in|下一步/i }).click().catch(async () => {
    await anonPage.keyboard.press("Enter");
  });

  // ── 3. Back on craw ──
  await anonPage.waitForURL(/craw\.finddatatech\.cloud/, { timeout: 30000 });
  await anonPage.waitForLoadState("domcontentloaded");
  const landed = anonPage.url();
  // rd carry-through is not observable from the browser: App.tsx rewrites every
  // anonymous deep link to /login before the login page renders, so the app
  // always sends rd=/login, and an authenticated /login bounces straight to
  // /chat. (The rd round-trip itself is pinned by scripts/test-logto-auth.mjs.)
  // What is observable: the callback completed and left us in the app.
  await anonPage.waitForURL(/craw\.finddatatech\.cloud\/(chat|settings)/, { timeout: 20000 }).catch(() => {});
  ok("post-login lands in the app, off /login", !new URL(anonPage.url()).pathname.startsWith("/login"), `${landed} -> ${anonPage.url()}`);

  await anonPage.goto(`${BASE}/settings/account`, { waitUntil: "domcontentloaded" });
  await anonPage.waitForSelector('[data-testid="account-email"]', { timeout: 20000 });
  ok("account email shown", (await anonPage.getByTestId("account-email").textContent()) === EMAIL);

  const me = await anonPage.evaluate(async () => (await fetch("/api/auth/me", { credentials: "same-origin" })).json());
  ok("me.authenticated", me.authenticated === true);
  ok("me.groups includes platform-admin", (me.groups || []).includes("platform-admin"), JSON.stringify(me.groups));
  ok("me.adminGroups = [platform-admin]", JSON.stringify(me.adminGroups) === '["platform-admin"]');

  // ── 4. Settings shows the 部署品牌 section; save test values ──
  await anonPage.goto(`${BASE}/settings/branding`, { waitUntil: "domcontentloaded" });
  await anonPage.waitForSelector('[data-testid="settings-branding"]', { timeout: 20000 });
  ok("部署品牌 section visible for platform-admin", true);
  await anonPage.getByTestId("branding-companyName").fill("验证科技");
  await anonPage.getByTestId("branding-brandIconUrl").fill("https://www.google.com/favicon.ico");
  await anonPage.getByTestId("branding-loginFooterText").fill("© 2026 验证科技");
  await anonPage.getByTestId("branding-save").click();
  await anonPage.waitForSelector('[data-testid="settings-branding"] >> text=/Saved|已保存/', { timeout: 15000 });
  ok("branding save succeeded", true);

  const cfg = await anonPage.evaluate(async () => (await fetch("/api/config")).json());
  ok("stored branding served without restart", cfg.companyName === "验证科技" && cfg.loginFooterText === "© 2026 验证科技" && cfg.brandIconUrl === "https://www.google.com/favicon.ico", JSON.stringify({ companyName: cfg.companyName, footer: cfg.loginFooterText }));

  // ── 5. Anonymous context sees the branded login + favicon ──
  const fresh = await browser.newContext({ locale: "en-US" });
  const freshPage = await fresh.newPage();
  await freshPage.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await freshPage.waitForSelector('[data-testid="login-page"]', { timeout: 20000 });
  await freshPage.waitForSelector('[data-testid="login-brand-icon"]', { timeout: 15000 });
  ok("branded login shows icon", await freshPage.getByTestId("login-brand-icon").isVisible());
  await freshPage.waitForSelector('[data-testid="login-footer"]', { timeout: 10000 });
  ok("branded login shows footer", (await freshPage.getByTestId("login-footer").textContent()) === "© 2026 验证科技");
  const desc = await freshPage.locator("p.text-sm").first().textContent();
  ok("login copy interpolates company name", desc.includes("验证科技"), desc.slice(0, 80));
  const fav = await freshPage.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute("href"));
  ok("favicon link injected", fav === "https://www.google.com/favicon.ico", String(fav));

  // ── 6. Cleanup: clear all fields back to empty ──
  await anonPage.goto(`${BASE}/settings/branding`, { waitUntil: "domcontentloaded" });
  await anonPage.waitForSelector('[data-testid="branding-companyName"]', { timeout: 20000 });
  for (const id of ["branding-companyName", "branding-assistantName", "branding-brandIconUrl", "branding-loginFooterText"]) {
    await anonPage.getByTestId(id).fill("");
  }
  await anonPage.getByTestId("branding-save").click();
  await anonPage.waitForTimeout(1500);
  const cfg2 = await anonPage.evaluate(async () => (await fetch("/api/config")).json());
  ok("cleanup: branding cleared to null", cfg2.companyName === null && cfg2.brandIconUrl === null && cfg2.loginFooterText === null, JSON.stringify(cfg2));

  await fresh.close();
  await anon.close();
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : failed.length + " FAILURES"}`);
  for (const f of failed) console.log(`  FAIL: ${f.name} ${f.extra}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

async function expectText(page, sel, text) {
  try {
    await page.locator(sel).first().waitFor({ state: "visible", timeout: 8000 });
    const t = await page.locator(sel).first().textContent();
    if (t !== text) console.log(`WARN ${sel} text=${t} expected=${text}`);
  } catch (e) {
    console.log(`WARN ${sel} not visible: ${e.message.split("\n")[0]}`);
  }
}
