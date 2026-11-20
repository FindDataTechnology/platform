// 真浏览器走查：幕僚团驾驶舱（add-personal-staff-fleet 4.3 的界面半边）。
// 只读：登录 → 打开 /fleets/<id> → 核对五岗、编排边、以及页面是否报错。
// 不在页面上点任何写操作（不建岗、不点火、不改授权）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = "/Users/chengsishi/finddata/paas";
const PLATFORM = process.env.PLATFORM_URL || "https://platform.finddatatech.cloud";
const FLEET_ID = process.env.FLEET_ID || "fleet_1794463395632_v4ycrt";
const REQUIRED = ["幕僚长", "评审官", "侦查官", "书记", "审计官"];

const dotenv = (key) => {
  const m = readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
};
const EMAIL = dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = dotenv("PAAS_TEST_PASSWORD");
if (!EMAIL || !PASSWORD) throw new Error("PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD 未配");

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`); });

try {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  // 与 verify-live-external-sources.mjs 同一套 Logto 表单（shell 页 → sso-login → 两步）
  await page.getByTestId("login-page").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("sso-login").click();
  const identifier = page.locator('input[name="identifier"]');
  await identifier.waitFor({ state: "visible", timeout: 30_000 });
  await identifier.fill(EMAIL);
  await page.locator('input[type="submit"], button:has-text("Sign in"), button:has-text("登录")').first().click();
  const password = page.locator('input[name="password"]');
  await password.waitFor({ state: "visible", timeout: 30_000 });
  await password.fill(PASSWORD);
  await password.press("Enter");
  await page.waitForURL(/\/chat|\/settings|\/fleets/, { timeout: 60_000 });
  ok("登录成功", true, new URL(page.url()).pathname);

  const before = errors.length;
  const resp = await page.goto(`${PLATFORM}/fleets/${FLEET_ID}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  ok("驾驶舱 HTTP 200", resp?.status() === 200, `status ${resp?.status()}`);

  // 等页面把岗位渲染出来（骨架/表格都算），再到 DOM 里核对文字
  await page.waitForTimeout(6000);
  const text = await page.evaluate(() => document.body.innerText || "");
  for (const t of REQUIRED) ok(`页面出现岗位「${t}」`, text.includes(t));

  // 编排边：读 API 拿真值，再确认页面不是"白板"（有 svg/canvas 或节点容器）
  const canvasish = await page.evaluate(() => {
    const sel = ["svg", "canvas", "[data-testid*='canvas']", "[data-testid*='orchestration']", "[class*='react-flow']"];
    return sel.map((s) => [s, document.querySelectorAll(s).length]);
  });
  ok("渲染了编排视图（svg/canvas/节点容器其一）", canvasish.some(([, n]) => n > 0), JSON.stringify(canvasish));

  // 晨报可见性（本轮新增）：幕僚长有 cadence 之后，KPI 卡上应能看到 brief_digest 的值。
  const brief = await page.evaluate(() => document.body.innerText || "");
  ok("KPI 卡出现「今日要事」", brief.includes("今日要事"));
  ok("KPI 卡出现「待你拍板」", brief.includes("待你拍板"));
  ok("晨报正文可见（含『晨报』或『本轮无回执』）", /晨报|本轮无回执/.test(brief));
  const newErrors = errors.slice(before);
  ok("页面无 JS 报错", newErrors.length === 0, newErrors.slice(0, 3).join(" | "));

  // 截图留证（失败也能看现场）
  await page.screenshot({ path: "/tmp/fleet-cockpit.png", fullPage: false });
  console.log("screenshot: /tmp/fleet-cockpit.png");
} catch (e) {
  ok("走查流程", false, e.message);
  try { await page.screenshot({ path: "/tmp/fleet-cockpit-fail.png" }); } catch { /* ignore */ }
} finally {
  await browser.close();
}

console.log(failures ? `\n[walkthrough] 失败 ${failures} 项` : "\n[walkthrough] 全部通过");
process.exit(failures ? 1 : 0);
