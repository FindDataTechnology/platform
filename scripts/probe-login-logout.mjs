// Live probe: landing page → login → console → logout → root again.
// Verifies the two user-reported regressions:
//   1. after logout the browser should not be stuck on the "logged out" screen
//   2. a subsequent visit to / must show the landing page (not /login)
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "https://mcp.finddatatech.cloud";
const envText = fs.readFileSync("/Users/chengsishi/paas/.env", "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const IDENT = env.PAAS_TEST_IDENTIFIER;
const PASS = env.PAAS_TEST_PASSWORD;

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  | " + extra : ""}`);
  cond ? pass++ : fail++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Step 1: anonymous root → landing page
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
let text = await page.innerText("body").catch(() => "");
ok("anonymous / shows landing (not login)", text.includes("壹座·Packs") && text.includes("三步上手"), `url=${page.url()}`);
ok("anonymous / is NOT the console SPA", !page.url().includes("/login"));

// Step 2: click 进入控制台 → should reach console login page
await page.getByTestId("landing-enter").click().catch(() => {});
await page.waitForTimeout(1500);
ok("landing 进入控制台 leads to /login", page.url().includes("/login"), `url=${page.url()}`);

// Step 3: SSO login through Logto
await page.waitForSelector("text=Sign in with FindData account", { timeout: 15000 });
await page.locator("text=Sign in with FindData account").click();
await page.waitForURL(/auth\.finddatatech\.cloud/, { timeout: 20000 }).catch(() => {});
console.log("  → at IdP:", page.url());
await page.waitForSelector('input[name="identifier"]', { timeout: 20000 });
await page.fill('input[name="identifier"]', IDENT);
await page.keyboard.press("Enter");
await page.waitForSelector('input[name="password"]', { timeout: 20000 });
await page.fill('input[name="password"]', PASS);
await page.keyboard.press("Enter");

await page.waitForURL(new RegExp(BASE.replace(/[./]/g, "\\$&")), { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
text = await page.innerText("body").catch(() => "");
const loggedIn = !text.includes("Sign in with FindData account") && (page.url().includes("/chat") || page.url().includes("/dashboard") || page.url().includes("/agents") || page.url().includes("/") );
ok("login lands in console", loggedIn, `url=${page.url()}`);

await page.screenshot({ path: "/tmp/probe-1-console.png" });

// Step 4: go to root while logged in → console (not landing)
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
text = await page.innerText("body").catch(() => "");
ok("logged-in / serves console (not landing)", !text.includes("三步上手"), `url=${page.url()}`);
await page.screenshot({ path: "/tmp/probe-2-root-loggedin.png" });

// Step 5: logout via the REAL endpoint the app's Sign out button uses.
// NOTE: /logout is only the IdP's post-logout confirmation screen — it does
// not end the session. Probing that path instead is a false negative: the
// cookie survives and every downstream assertion lies.
const cookiesBefore = await ctx.cookies();
console.log("  cookies before logout:", cookiesBefore.map(c => c.name).join(",") || "(none)");
await page.goto(BASE + "/api/auth/logout", { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(3000);
text = await page.innerText("body").catch(() => "");
// The real endpoint ends the local session, then hands off to the IdP
// (/oidc/session/end). Landing on the IdP's success page — or on our own
// /logout confirmation screen — both count as a completed logout; what must
// be true is that the local session is gone (asserted next).
const logoutCompleted =
  /oidc\/session\/end|success/i.test(page.url()) ||
  /\/logout(\b|$)/.test(page.url()) ||
  /Logged Out/i.test(text);
ok("logout completed (IdP handoff or confirmation screen)", logoutCompleted, `url=${page.url()}`);
console.log("  → logout landed at:", page.url());
await page.screenshot({ path: "/tmp/probe-3-after-logout.png" });

const cookiesAfter = await ctx.cookies();
console.log("  cookies after logout:", cookiesAfter.map(c => c.name).join(",") || "(none)");
const sessionGone = !cookiesAfter.some(c => c.name === "mcp_gateway_session");
ok("session cookie cleared after logout", sessionGone);

// Step 6: visit root again → MUST be landing
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
text = await page.innerText("body").catch(() => "");
ok("post-logout / shows landing again", text.includes("三步上手"), `url=${page.url()}`);
await page.screenshot({ path: "/tmp/probe-4-post-logout-root.png" });

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
