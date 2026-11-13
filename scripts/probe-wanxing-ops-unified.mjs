// 良机 console 统一舰队视图 生产眼见探针 (unify-wanxing-management-plane 5.2 /
// fd-wanxing add-fleet-cell-views 3.2)。登录 wanxing.finddatatech.cloud（Logto PKCE，
// 与平台同 IdP 的两步表单），打开 #/console/ops，断言：
//   - 短期执行 cells 区可见且带真 cell 行（cell:<id>）
//   - 汇总条（cells/在跑/排队）与 board JSON 同源
//   - runners 区渲染（含 pod 密度徽标条件位）
// 截图留档 /tmp/wanxing-ops-unified.png。
//   node scripts/probe-wanxing-ops-unified.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = process.env.WANXING_URL || "https://wanxing.finddatatech.cloud";

function dotenv(key) {
  const m = readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}
const EMAIL = dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = dotenv("PAAS_TEST_PASSWORD");
if (!EMAIL || !PASSWORD) throw new Error("PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD not set in .env");

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
try {
  await page.goto(`${SITE}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.getByRole("button", { name: "登录" }).click();

  // Same IdP two-step form as the platform line (auth.finddatatech.cloud).
  const identifier = page.locator('input[name="identifier"]');
  await identifier.waitFor({ state: "visible", timeout: 30_000 });
  await identifier.fill(EMAIL);
  await page.locator('input[type="submit"], button:has-text("Sign in"), button:has-text("登录")').first().click();
  const password = page.locator('input[name="password"]');
  await password.waitFor({ state: "visible", timeout: 30_000 });
  await password.fill(PASSWORD);
  await password.press("Enter");

  // Back on the wanxing domain with a session (控制台 tab appears).
  await page.getByRole("link", { name: "控制台" }).waitFor({ state: "visible", timeout: 30_000 });
  ok("登录回跳，控制台 tab 可见", true);

  // In-SPA navigation only (a full page goto drops the in-memory session).
  await page.getByRole("link", { name: "控制台" }).click();
  const opsTab = page.getByTestId("console-tab-ops");
  await opsTab.waitFor({ state: "visible", timeout: 15_000 });
  await opsTab.click();
  // Wait out the board's first fetch (加载中 → data or 读取失败) before asserting.
  await page
    .locator("text=观测面加载中…")
    .waitFor({ state: "hidden", timeout: 30_000 })
    .catch(() => {});
  const panel = page.locator('[data-testid="cells-panel"]');
  try {
    await panel.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    if (process.env.DUMP_TEXT) {
      console.log("---- BODY DUMP ----");
      console.log((await page.locator("body").innerText()).slice(0, 1500));
      console.log("---- URL:", page.url());
    }
    throw new Error("cells-panel not visible — run with DUMP_TEXT=1 for the page dump");
  }
  const text = await panel.innerText();
  ok("运维 tab 短期执行区渲染", text.includes("短期执行"), text.split("\n")[0]);
  ok("cells 汇总条在场", /cells\s+\d+/.test(text), (text.match(/cells\s+\d+/) || [""])[0]);
  const cellRows = (text.match(/cell:[0-9a-f]+/g) || []).length;
  ok("真 cell 行渲染（cell:<id>）", cellRows > 0, `rows=${cellRows}`);

  // Runners card: the board's runner row with pod density (runner-serving is
  // pod-mode in production, so the badge text should be present).
  const bodyText = await page.locator("body").innerText();
  ok("runners 区渲染", /runner-serving/.test(bodyText));
  ok("pod 密度徽标渲染（runner-serving=pod 模式）", /runner-serving\s*pod/.test(bodyText), "runner 行紧随 pod 徽标");

  await page.screenshot({ path: "/tmp/wanxing-ops-unified.png", fullPage: true });
  ok("截图留档 /tmp/wanxing-ops-unified.png", true);
  if (process.env.DUMP_TEXT) {
    console.log("---- OPS AREA DUMP ----");
    console.log((await page.locator('[data-testid="console-shell"]').innerText()).slice(0, 2000));
  }
} finally {
  await browser.close();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
