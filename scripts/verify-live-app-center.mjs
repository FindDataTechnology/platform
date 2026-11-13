// Live acceptance for app-center-unified-grid (task 7.3), production.
//
//   node scripts/verify-live-app-center.mjs
//
// Runs with the real Logto account from .env (which carries business roles —
// exactly the population that module-level acceptance historically missed).
// The core trick: the expected grid is computed with the SAME pure functions
// the page uses (imported straight from web/src/lib/appCatalog.ts) over the
// live /api/catalog + /api/connections of the logged-in session, then the
// DOM must match it card for card, badge for badge. Production catalogs are
// role-filtered, so the script asserts DOM == model(live data), never a
// hard-coded eight.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_LINES,
  buildAppGrid,
  aggregateConnectionState,
  connectTargetFor,
} from "../web/src/lib/appCatalog.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.env.PLATFORM_URL || "https://platform.finddatatech.cloud";

function dotenv(key) {
  const m = readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

const EMAIL = process.env.LIVE_EMAIL || dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = process.env.LIVE_PASSWORD || dotenv("PAAS_TEST_PASSWORD");
if (!EMAIL || !PASSWORD) throw new Error("PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD not set in .env");

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

async function fillLogtoForm(page, timeoutMs = 30_000) {
  await page.getByTestId("login-page").waitFor({ state: "visible", timeout: timeoutMs });
  await page.getByTestId("sso-login").click();
  const identifier = page.locator('input[name="identifier"]');
  await identifier.waitFor({ state: "visible", timeout: timeoutMs });
  await identifier.fill(EMAIL);
  await identifier.press("Enter");
  const password = page.locator('input[name="password"]');
  await password.waitFor({ state: "visible", timeout: timeoutMs });
  await password.fill(PASSWORD);
  await password.press("Enter");
}

const browser = await chromium.launch();
const context = await browser.newContext({ locale: "zh-CN" });
const page = await context.newPage();

try {
  // ── A. login ────────────────────────────────────────────────────────────
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await fillLogtoForm(page);
  await page.waitForURL(/\/chat|\/settings/, { timeout: 60_000 });
  ok("login lands in the console", true, page.url());

  const me = await page.evaluate(async () => (await fetch("/api/auth/me")).json());
  console.log("  /api/auth/me:", JSON.stringify({ email: me.email, isAdmin: me.isAdmin, roles: me.roles ?? null }));

  // ── B. live data → expected grid (same code the page runs) ──────────────
  const { apps, connections } = await page.evaluate(async () => {
    const [c, k] = await Promise.all([fetch("/api/catalog").then((r) => r.json()), fetch("/api/connections").then((r) => r.json())]);
    return { apps: c.apps ?? [], connections: k.connections ?? [] };
  });
  const statesById = Object.fromEntries(connections.map((c) => [c.id, c.state]));
  const expected = buildAppGrid(APP_LINES, apps);
  console.log("  catalog apps:", apps.map((a) => a.id).join(", ") || "(none)");
  console.log("  /api/connections:", connections.map((c) => `${c.id}=${c.state}`).join(" "));
  ok("catalog served the bundled products", apps.some((a) => a.id === "wanxing-connector"), apps.map((a) => a.id).join(","));

  // ── C. the unified grid renders and matches the model ───────────────────
  await page.goto(`${PLATFORM}/apps`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("app-center-grid").waitFor({ state: "visible", timeout: 30_000 });

  const domIds = await page.getByTestId("app-center-grid").evaluate((el) =>
    Array.from(el.children).map((c) => (c.dataset.testid ?? "").replace(/^app-card-/, "")),
  );
  ok("grid order matches model(live catalog)", JSON.stringify(domIds) === JSON.stringify(expected.map((e) => e.id)), domIds.join(","));

  ok("retired section containers absent", (await page.getByTestId("app-center-lines").count()) === 0 && (await page.getByTestId("app-center-platform-apps").count()) === 0);
  ok("platform self card anchors", (await page.getByTestId("app-card-yizuo-self").count()) === 1 && (await page.getByTestId("app-card-yizuo-open").count()) === 0);

  // ── D. badges equal the aggregated live projection, card for card ───────
  let badgeChecks = 0;
  let firstConnectCard = null;
  for (const entry of expected) {
    const badge = page.getByTestId(`app-card-${entry.id}-connection-badge`);
    const want = aggregateConnectionState(entry.connections, statesById);
    if (want === null) {
      ok(`${entry.id}: no badge (brand umbrella)`, (await badge.count()) === 0);
      continue;
    }
    const got = (await badge.count()) === 1 ? await badge.getAttribute("data-state") : null;
    ok(`${entry.id}: badge=${want}`, got === want, `got ${got}`);
    badgeChecks += 1;
    const connect = page.getByTestId(`app-card-${entry.id}-connect`);
    if (want === "connected") {
      ok(`${entry.id}: no connect action when connected`, (await connect.count()) === 0);
    } else if (!firstConnectCard) {
      firstConnectCard = { id: entry.id, target: connectTargetFor(entry.connections, statesById) };
    }
  }
  ok("at least one badge rendered from live projection", badgeChecks > 0, `${badgeChecks} badges`);

  // ── E. 去连接 deep-links to the right panel and highlights it ────────────
  if (firstConnectCard) {
    await page.getByTestId(`app-card-${firstConnectCard.id}-connect`).click();
    const wanted = new RegExp(`/settings/connections\\?panel=${firstConnectCard.target}$`);
    ok(`去连接 lands on panel=${firstConnectCard.target}`, wanted.test(page.url()), page.url());
    // The connections section is a lazy chunk; wait for it before counting.
    await page.getByTestId("settings-section-connections").waitFor({ state: "visible", timeout: 30_000 });
    await page.locator("[data-panel-active='true']").first().waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
    const active = await page.locator("[data-panel-active='true']").evaluateAll((els) => els.map((e) => e.getAttribute("data-panel")));
    ok("target connect card highlighted", active.length === 1, `active anchors: ${active.join(",") || "(none)"}`);
    await page.goto(`${PLATFORM}/apps`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.getByTestId("app-center-grid").waitFor({ state: "visible", timeout: 30_000 });
  } else {
    console.log("  (all mapped cards connected — 去连接 click path covered by e2e mocks)");
  }

  // ── F. the embedded product opens the in-app proxy route ────────────────
  if (expected.some((e) => e.id === "wanxing-token")) {
    await page.getByTestId("app-card-wanxing-token-open").click();
    await page.waitForURL(/\/external\/wanxing-token/, { timeout: 30_000 });
    ok("embedded product routes to /external/wanxing-token", true, page.url());
  } else {
    console.log("  (wanxing-token not in this account's catalog — embedded route covered by e2e)");
  }

  // ── G. evidence: nav reachability for this role-carrying account ────────
  await page.goto(`${PLATFORM}/chat`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const navApps = await page.getByTestId("nav-apps").count();
  console.log(`  (evidence) nav-apps visible for this account: ${navApps === 1 ? "yes" : "no"} — role nav narrowing is role policy, not this change`);
} finally {
  await context.close();
  await browser.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
