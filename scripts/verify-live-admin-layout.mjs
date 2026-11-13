// Live acceptance for admin-layout-exempt (task 2.3), production.
//
//   node scripts/verify-live-admin-layout.mjs
//
// With the real admin account: temporarily assign the stock business role,
// read the boot config, assert the resolved layout stays the full deployment
// default (the administration sections and the whole nav survive), then
// restore the neutral assignment in a finally block.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.env.PLATFORM_URL || "https://platform.finddatatech.cloud";
const dotenv = (k) => (readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const EMAIL = dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = dotenv("PAAS_TEST_PASSWORD");
if (!EMAIL || !PASSWORD) throw new Error("PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD not set");

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ locale: "zh-CN" })).newPage();
let restored = false;
const put = async (role) => page.evaluate(async ({ email, r }) => {
  const res = await fetch(`/api/roles/assignments/${encodeURIComponent(email)}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ primary: r }),
  });
  return res.status;
}, { email: EMAIL, r: role });
try {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("login-page").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("sso-login").click();
  const id = page.locator('input[name="identifier"]');
  await id.waitFor({ state: "visible", timeout: 30_000 }); await id.fill(EMAIL); await id.press("Enter");
  const pw = page.locator('input[name="password"]');
  await pw.waitFor({ state: "visible", timeout: 30_000 }); await pw.fill(PASSWORD); await pw.press("Enter");
  await page.waitForURL(/\/chat|\/settings/, { timeout: 60_000 });

  const before = await page.evaluate(async () => (await (await fetch("/api/config")).json()).resolvedLayout);
  ok("baseline (no role) nav has admin surfaces", before.nav.includes("tasks") && before.nav.includes("apps"), before.nav.join(","));
  ok("baseline settings include administration sections", ["models", "roles", "layout", "channels", "diagnostics", "status", "branding"].every((s) => before.settings.includes(s)), before.settings.join(","));

  ok("temporary stock role accepted", (await put("stock")) === 200);
  const me = await page.evaluate(async () => (await (await fetch("/api/auth/me")).json()));
  ok("identity still admin, role recorded", me.isAdmin === true && me.roles?.primary === "stock", JSON.stringify({ isAdmin: me.isAdmin, roles: me.roles }));

  const during = await page.evaluate(async () => (await (await fetch("/api/config")).json()).resolvedLayout);
  ok("admin + stock keeps the full nav", JSON.stringify(during.nav) === JSON.stringify(before.nav), during.nav.join(","));
  ok("admin + stock keeps every administration section", JSON.stringify(during.settings) === JSON.stringify(before.settings), during.settings.join(","));

  await page.goto(`${PLATFORM}/chat`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("nav-chat").waitFor({ state: "visible", timeout: 20_000 });
  const navIds = await page.locator('[data-testid^="nav-"]').evaluateAll((els) => els.map((e) => e.dataset.testid));
  ok("sidebar keeps 应用 and 任务 for the role-carrying admin", navIds.includes("nav-apps") && navIds.includes("nav-tasks"), navIds.join(","));
} finally {
  if (page.url().includes(PLATFORM)) {
    await put("standard").then((s) => { restored = s === 200; }).catch(() => {});
    console.log(restored ? "  role restored to standard (neutral)" : "  WARN: role restore failed — re-run PUT standard manually");
  }
  await browser.close();
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
