// Live production walkthrough for add-machine-lifecycle-console (机器生命周期门面).
// Screenshots to gui-test-screenshots/machines-*.png — each must be Read to count as seen.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "https://platform.finddatatech.cloud";
const envText = fs.readFileSync("/Users/chengsishi/paas/.env", "utf8");
const env = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const IDENT = env.PAAS_TEST_IDENTIFIER;
const PASS = env.PAAS_TEST_PASSWORD;
const SHOT = "/Users/chengsishi/paas/gui-test-screenshots";
fs.mkdirSync(SHOT, { recursive: true });

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  | " + extra : ""}`);
  cond ? pass++ : fail++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// ── login ───────────────────────────────────────────────────────────────────
await page.goto(BASE + "/login", { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="sso-login"]', { timeout: 20000 });
await page.evaluate((el) => el.click(), await page.locator('[data-testid="sso-login"]').elementHandle());
await page.waitForURL(/auth\.finddatatech\.cloud/, { timeout: 20000 }).catch(() => {});
await page.waitForSelector('input[name="identifier"]', { timeout: 20000 });
await page.fill('input[name="identifier"]', IDENT);
await page.keyboard.press("Enter");
await page.waitForSelector('input[name="password"]', { timeout: 20000 });
await page.fill('input[name="password"]', PASS);
await page.keyboard.press("Enter");
await page.waitForURL(new RegExp(BASE.replace(/[./]/g, "\\$&")), { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
ok("login lands in console", !page.url().includes("/login"), `url=${page.url()}`);

// ── 机器页 ──────────────────────────────────────────────────────────────────
await page.goto(BASE + "/machines", { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="machines-page"]', { timeout: 15000 });
await page.waitForTimeout(1500);
const roster = await page.locator('[data-testid^="machine-row-"]').count();
const empty = await page.locator('[data-testid="machines-empty"]').count();
ok("machines page renders roster or empty state", roster > 0 || empty > 0, `rows=${roster} empty=${empty}`);
await page.screenshot({ path: `${SHOT}/machines-1-roster.png` });

// 卡面系统信息（有机器时）
if (roster > 0) {
  const sysInfo = await page.locator('[data-testid^="machine-row-"]').first().textContent();
  ok("roster card carries OS/version or pairing date", /macOS|Windows|Linux|darwin|win32|linux|配对|Paired|—/i.test(sysInfo ?? ""), String(sysInfo).slice(0, 90));
}

// ── 配对向导 ────────────────────────────────────────────────────────────────
await page.getByTestId("machine-add").click();
const wizard = await page.waitForSelector('[data-testid="machine-pair-overlay"]', { timeout: 10000 }).then(() => true).catch(() => false);
ok("pairing wizard opens from the header button", wizard);
if (wizard) {
  const code = await page.waitForSelector('[data-testid="machine-pairing-code"]', { timeout: 10000 }).then((el) => el.textContent()).catch(() => "");
  ok("wizard mints a 6-digit code (shared pool)", /^\d{6}$/.test((code ?? "").trim()), `code=${code}`);
  const qr = await page.locator('[data-testid="machine-pairing-qr"]').count();
  ok("wizard renders the QR (settings/devices contract)", qr === 1);
  await page.screenshot({ path: `${SHOT}/machines-2-pairing-wizard.png` });
  await page.getByRole("button", { name: /Close|关闭/ }).click();
  await page.waitForTimeout(500);
}

// ── 详情抽屉（有机器时） ─────────────────────────────────────────────────────
if (roster > 0) {
  await page.locator('[data-testid^="machine-row-"]').first().click();
  await page.waitForSelector('[data-testid="machine-detail-overlay"]', { timeout: 10000 });
  const conv = await page.locator('[data-testid="machine-convergence"]').getAttribute("data-state").catch(() => null);
  ok("convergence indicator renders with a state", Boolean(conv), `state=${conv}`);
  const identity = await page.locator('[data-testid="machine-identity"]').textContent().catch(() => "");
  ok("identity line renders (label/os/boundAt or unknown)", Boolean(identity), String(identity).slice(0, 90));
  const history = await page.waitForSelector('[data-testid="machine-history"], [data-testid="machine-history-empty"]', { timeout: 10000 }).then(() => true).catch(() => false);
  ok("history timeline section renders", history);
  const unbind = await page.locator('[data-testid="machine-unbind"]').count();
  ok("unbind danger zone renders", unbind === 1);
  await page.screenshot({ path: `${SHOT}/machines-3-detail-drawer.png` });
  // 历史端点真读面（页面上下文内）
  const hist = await page.evaluate(async () => {
    const id = document.querySelector('[data-testid="machine-detail-overlay"] h2')?.textContent?.trim();
    if (!id) return null;
    const r = await fetch(`/api/machines/${encodeURIComponent(id)}/history`);
    if (!r.ok) return { status: r.status };
    const doc = await r.json();
    return { status: r.status, n: doc.history?.length ?? 0, first: doc.history?.[0]?.kind ?? null, keys: Object.keys(doc.history?.[0] ?? {}) };
  });
  ok("history endpoint serves metadata events", Boolean(hist && hist.status === 200), JSON.stringify(hist));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

// ── 设置页设备节（steward 行过滤 + 指路） ────────────────────────────────────
await page.goto(BASE + "/settings/devices", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const devicesSection = await page.locator('[data-testid="settings-devices"]').count();
if (devicesSection > 0) {
  await page.locator('[data-testid="settings-devices"]').scrollIntoViewIfNeeded();
  const stewardRows = await page.locator('[data-testid="device-row"]').evaluateAll((rows) => rows.length);
  const pointer = await page.locator('[data-testid="devices-machines-pointer"]').count();
  ok("settings devices section renders", true, `app-device rows=${stewardRows} machines-pointer=${pointer}`);
  await page.screenshot({ path: `${SHOT}/machines-4-settings-devices.png` });
} else {
  ok("settings devices section renders", false, "settings-devices testid not found on /settings");
}

console.log(`\n== machines walkthrough: ${pass} pass / ${fail} fail ==`);
await browser.close();
process.exit(fail > 0 ? 1 : 0);
