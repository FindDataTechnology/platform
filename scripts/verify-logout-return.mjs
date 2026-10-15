// 用户视角验收：真点「Sign out」按钮，看最终停在哪一页、cookie 是否清掉、
// 以及随后访问 / 是落地页还是登录墙。
// 重点回答：登出后是否回到我们的域名（而非停在 Logto 自己的成功页）。
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "https://mcp.finddatatech.cloud";
const env = Object.fromEntries(
  fs.readFileSync("/Users/chengsishi/paas/.env", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  | " + extra : ""}`);
  cond ? pass++ : fail++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// ── 登录 ────────────────────────────────────────────────────────────────────
await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Sign in with FindData account", { timeout: 20000 });
await page.locator("text=Sign in with FindData account").click();
await page.waitForSelector('input[name="identifier"]', { timeout: 20000 });
await page.fill('input[name="identifier"]', env.PAAS_TEST_IDENTIFIER);
await page.keyboard.press("Enter");
await page.waitForSelector('input[name="password"]', { timeout: 20000 });
await page.fill('input[name="password"]', env.PAAS_TEST_PASSWORD);
await page.keyboard.press("Enter");
await page.waitForTimeout(4000);
ok("登录成功进入控制台", !page.url().includes("/login"), `url=${page.url()}`);

// ── 真点 Sign out ───────────────────────────────────────────────────────────
// Headless UI 下拉：先点用户菜单按钮（头像+用户名+chevron），再点菜单里的
// Sign out（Layout.tsx 的 Menu.Button / Menu.Item）。
await page.getByRole("button", { name: /^aloadtree/ }).click({ timeout: 15000 });
await page.locator('button:has-text("Sign out")').first().click({ timeout: 10000 });

await page.waitForTimeout(6000); // 覆盖 5 秒倒计时
const finalUrl = page.url();
console.log("\n  → 点 Sign out 后最终停在:", finalUrl);

const onOurDomain = finalUrl.startsWith(BASE);
ok("登出后最终回到我们的域名（非停在 Logto 成功页）", onOurDomain, `host=${new URL(finalUrl).host}`);

const text = await page.innerText("body").catch(() => "");
const onLanding = text.includes("三步上手") || text.includes("壹座·Packs");
ok("最终落点是产品首页（落地页），不是登录墙", onLanding && !finalUrl.includes("/login"), `url=${finalUrl}`);

const cookies = await ctx.cookies();
ok("会话 cookie 已清除", !cookies.some((c) => c.name === "mcp_gateway_session"),
   `cookies=${cookies.map((c) => c.name).join(",") || "(none)"}`);

// ── 再进首页 ────────────────────────────────────────────────────────────────
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const t2 = await page.innerText("body").catch(() => "");
ok("退出后访问 / 显示落地页（不跳登录）", t2.includes("三步上手") && !page.url().includes("/login"), `url=${page.url()}`);
await page.screenshot({ path: "/tmp/verify-after-signout-root.png" });

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
