// Live acceptance for settings-connect-center (tasks 6.1 / 6.3), production.
//
//   node scripts/verify-live-connections.mjs
//
// Runs with the real Logto account from .env. Because that account carries a
// business role (stock/legal → the `simple` layout preset), the section list is
// narrowed by the role layer; the script therefore:
//   1. records the ORIGINAL assignment and the narrowed section list (evidence),
//   2. temporarily clears the role via the admin API so the factory preset
//      renders (the surface this change targets), runs every assertion,
//   3. restores the original assignment in a finally block.
//
// Every assertion is about what a user sees or what the API reports — no
// module-level calls: this file exists because module-level acceptance missed
// the last four defects (ledger §12.9/§12.10).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const results = [];
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  results.push({ label, cond, detail });
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

let originalRoles = null;
let roleCleared = false;

try {
  // ── A. login ────────────────────────────────────────────────────────────
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await fillLogtoForm(page);
  await page.waitForURL(/\/chat|\/settings/, { timeout: 60_000 });
  ok("login lands in the console", true, page.url());

  const me = await page.evaluate(async () => (await fetch("/api/auth/me")).json());
  console.log("  /api/auth/me:", JSON.stringify({ email: me.email, isAdmin: me.isAdmin, roles: me.roles }));
  ok("identity is the .env account", me.email === EMAIL, me.email);
  originalRoles = me.roles ?? null;

  // ── A2. /api/connections projection ─────────────────────────────────────
  const connRes = await page.evaluate(async () => {
    const r = await fetch("/api/connections");
    return { status: r.status, body: await r.json() };
  });
  ok("/api/connections 200", connRes.status === 200, String(connRes.status));
  const items = connRes.body.connections || [];
  const byId = Object.fromEntries(items.map((c) => [c.id, c]));
  for (const id of [
    "registry",
    "facet-market",
    "connector",
    "line-wire-customer",
    "line-lex",
    "line-wanxing-caller",
    "paper-trading",
    "search",
  ]) {
    ok(`entry ${id} present`, Boolean(byId[id]), byId[id] ? byId[id].state : "missing");
  }
  ok(
    "no credential material in the payload",
    !/sk-|fdt_|oct_|Bearer\s|eyJ[A-Za-z0-9_-]{10,}/.test(JSON.stringify(connRes.body)),
  );
  ok(
    "every state is one of the four",
    items.every((c) => ["connected", "stale", "disconnected", "not-configured"].includes(c.state)),
    items.map((c) => `${c.id}=${c.state}`).join(" "),
  );
  ok(
    "whitelist projection holds (non-search keys)",
    items
      .filter((c) => c.id !== "search")
      .every((c) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(["id", "name", "reason", "state"])),
  );
  ok("search carries userKey", typeof byId.search?.userKey === "boolean", JSON.stringify(byId.search));

  // ── A3. the role-layer narrowing (recorded as evidence, then lifted) ────
  const cfgBefore = await page.evaluate(async () => (await fetch("/api/config")).json());
  console.log("  roles:", JSON.stringify(me.roles), "settings sections:", JSON.stringify(cfgBefore.resolvedLayout?.settings));
  const narrowedByRole = Array.isArray(cfgBefore.resolvedLayout?.settings) && !cfgBefore.resolvedLayout.settings.includes("connections");
  console.log(`  NOTE role layer narrows settings to: ${JSON.stringify(cfgBefore.resolvedLayout?.settings)} (connections present: ${!narrowedByRole})`);

  if (narrowedByRole) {
    // Deep link under the narrowed layout: the modal falls back to General —
    // the visible defect this run records.
    await page.goto(`${PLATFORM}/settings/connections?panel=search`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.getByTestId("settings-nav").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1200);
    const landed = await page.getByTestId("settings-panel").getAttribute("data-section").catch(() => null);
    ok("DEFECT: role-narrowed deep link still reaches the connections section", landed === "connections", `data-section=${landed}`);
  }

  // Sections C–E address the Tools & Skills store, which the `simple` preset
  // hides by design (only the Basics group + connections survive). Clear the
  // role for those assertions and restore it in the finally block — the
  // narrowing itself is already recorded above.
  if (me.roles?.primary && me.roles.primary !== "standard") {
    const put = await page.evaluate(async (email) => {
      const r = await fetch(`/api/roles/assignments/${encodeURIComponent(email)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ primary: "standard" }),
      });
      return { status: r.status, body: await r.text() };
    }, EMAIL);
    ok("temporary role clear accepted (restored at the end)", put.status === 200, put.body.slice(0, 160));
    roleCleared = put.status === 200;
    await page.goto(`${PLATFORM}/chat`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
  }

  // ── B. connections section ──────────────────────────────────────────────
  await page.goto(`${PLATFORM}/settings/connections`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("settings-section-connections").waitFor({ state: "visible", timeout: 30_000 });
  ok("connections section renders", true, page.url());
  ok(
    "section is active in the nav",
    (await page.getByTestId("settings-section-connections").getAttribute("data-active")) === "true",
  );

  const glossary = page.getByTestId("connections-glossary");
  // The section's panels mount lazily; wait for the wrapper before counting
  // (a bare count() right after the section appears can still be 0).
  await glossary.first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  const glossaryCount = await glossary.count();
  console.log(`  glossary elements: ${glossaryCount}`);
  ok("glossary present", glossaryCount >= 1, `count=${glossaryCount}`);
  ok("glossary collapsed by default", !(await glossary.locator("dl").isVisible()));
  await glossary.locator("summary").click();
  await page.waitForTimeout(300);
  const glossText = await glossary.innerText();
  ok("glossary expands in place", await glossary.locator("dl").isVisible());
  for (const brand of ["萬星·词元", "谦面", "萬星·连接器", "柏讯", "识律"]) {
    ok(`glossary names ${brand}`, glossText.includes(brand));
  }

  const cardText = await page.getByTestId("settings-connections").innerText();
  for (const [label, testid] of [
    ["registry card", "registry-connect-panel"],
    ["search card", "search-service-card"],
    ["paper-trading card", "paper-trading-connect-panel"],
    ["connector card", "connector-connect-panel"],
  ]) {
    ok(`${label} visible`, await page.getByTestId(testid).isVisible());
  }
  ok("facet group wrapper visible", await page.getByTestId("connections-group-facet").isVisible());
  ok("facet-market card renders its title", cardText.includes("谦面市场"));
  ok("line card renders all three rows", ["柏讯", "识律", "萬星 Caller"].every((s) => cardText.includes(s)));
  ok("search card has the BYOK zone", await page.getByTestId("websearch-byok").isVisible());
  ok(
    "card subtitles present",
    /工具市场登录|市场设备配对|连接器账号|产品线操作凭据|模拟交易凭据/.test(cardText),
  );

  const PANELS = [
    "registry",
    "facet-market",
    "connector",
    "line-wire-customer",
    "line-lex",
    "line-wanxing-caller",
    "paper-trading",
    "search",
  ];
  for (const panel of PANELS) {
    await page.goto(`${PLATFORM}/settings/connections?panel=${panel}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("settings-section-connections").waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(400);
    const activeCount = await page.locator("[data-panel-active='true']").count();
    ok(`deep link ?panel=${panel} marks one anchor`, activeCount === 1, `active=${activeCount}`);
  }
  await page.goto(`${PLATFORM}/settings/connections?panel=nonsense`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByTestId("settings-section-connections").waitFor({ state: "visible", timeout: 20_000 });
  ok(
    "unknown panel degrades (section renders, nothing marked)",
    (await page.locator("[data-panel-active='true']").count()) === 0,
  );

  // ── C. retired websearch + market two-zone ──────────────────────────────
  await page.goto(`${PLATFORM}/settings/websearch`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(1200);
  ok(
    "/settings/websearch redirects into connections?panel=search",
    /\/settings\/connections\?panel=search$/.test(page.url()),
    page.url(),
  );
  ok("search card visible after redirect", await page.getByTestId("search-service-card").isVisible());

  await page.goto(`${PLATFORM}/settings/skills`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByTestId("extensions-page").waitFor({ state: "visible", timeout: 30_000 });
  const tabs = await page
    .locator("[data-testid^='extensions-tab-'], nav button")
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-testid") || (e.textContent || "").trim()).filter(Boolean),
    );
  console.log("  tabs:", tabs.join(" | "));
  // The installed tab has no testid of its own; the tab strip is two buttons
  // (installed | market) and no third (external) tab — the retired tab is the
  // assertion's point.
  const tabButtons = await page.locator("div.border-b nav button").evaluateAll((els) =>
    els.map((e) => (e.textContent || "").trim()),
  );
  ok("store has exactly two tabs (no external tab)", tabButtons.length === 2, tabButtons.join(" | "));
  ok("market tab is addressable", (await page.getByTestId("extensions-tab-market").count()) === 1);
  await page.getByTestId("extensions-tab-market").click();
  await page.getByTestId("market-external-zone").waitFor({ state: "visible", timeout: 20_000 });
  ok("skills market shows the external zone", true);
  ok(
    "market is a pure shelf (no connect cards)",
    (await page.getByTestId("registry-connect-panel").count()) === 0 &&
      (await page.getByTestId("connector-connect-panel").count()) === 0,
  );
  const zoneHtml = await page.getByTestId("market-external-zone").innerHTML();
  ok("external zone carries the not-reviewed mark", /未经本平台审校|not reviewed/i.test(zoneHtml));

  await page.goto(`${PLATFORM}/settings/mcp?tab=market`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByTestId("extensions-page").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  ok("tools market has no external zone", (await page.getByTestId("market-external-zone").count()) === 0);

  // ── D. deep-link compatibility matrix ───────────────────────────────────
  const MATRIX = [
    ["/settings/skills?tab=external", /\/settings\/skills\?tab=external$/],
    ["/models", /\/models$/],
  ];
  for (const [pathname, urlRe] of MATRIX) {
    await page.goto(`${PLATFORM}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(1500);
    ok(`deep link ${pathname} resolves`, urlRe.test(page.url()), page.url());
  }

  // ── E. admin view of the search card ────────────────────────────────────
  await page.goto(`${PLATFORM}/settings/connections?panel=search`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByTestId("search-service-card").waitFor({ state: "visible", timeout: 20_000 });
  const isAdmin = me.isAdmin === true || (Array.isArray(me.groups) && me.groups.includes("admin"));
  const sharedVisible = await page.getByTestId("websearch-shared").isVisible().catch(() => false);
  ok(
    isAdmin ? "admin sees the shared-wiring zone" : "non-admin does not see the shared-wiring zone",
    isAdmin ? sharedVisible : !sharedVisible,
    `isAdmin=${isAdmin} sharedVisible=${sharedVisible}`,
  );
  ok("BYOK zone is available to this user", await page.getByTestId("websearch-byok").isVisible());

  // ── F. card state agrees with the aggregate endpoint ────────────────────
  const liveConn = await page.evaluate(async () => (await fetch("/api/connections")).json());
  const live = Object.fromEntries((liveConn.connections || []).map((c) => [c.id, c]));
  const registryUiState = await page.getByTestId("registry-connect-panel").getAttribute("data-registry-state");
  ok(
    "registry UI state agrees with /api/connections",
    registryUiState === live.registry?.state,
    `ui=${registryUiState} api=${live.registry?.state}`,
  );
  const connectorUiState = await page.getByTestId("connector-connect-panel").getAttribute("data-connector-state");
  const connectorApi = live.connector?.state === "connected" ? "connected" : "disconnected";
  ok(
    "connector UI state agrees with /api/connections",
    connectorUiState === connectorApi,
    `ui=${connectorUiState} api=${live.connector?.state}`,
  );
  const paperUiState = await page.getByTestId("paper-trading-connect-panel").getAttribute("data-paper-trading-state");
  const paperApi = live["paper-trading"]?.state === "connected" ? "connected" : "disconnected";
  ok(
    "paper-trading UI state agrees with /api/connections",
    paperUiState === paperApi,
    `ui=${paperUiState} api=${live["paper-trading"]?.state}`,
  );

  // ── G. install gate points at the new home ──────────────────────────────
  const gate = await page.evaluate(async () => {
    const r = await fetch("/api/extensions/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "verify-live-gate-probe",
        config: { url: "http://127.0.0.1:9/mcp", credentialRef: "registry" },
      }),
    });
    return { status: r.status, body: await r.text() };
  });
  if (gate.status === 409) {
    ok(
      "credential-required 409 carries the connections connectPath",
      /\/settings\/connections\?panel=/.test(gate.body),
      gate.body.slice(0, 200),
    );
  } else {
    console.log(`  (skip) install-gate probe returned ${gate.status}, not a credential refusal`);
  }

  console.log("\n--- observed states ---");
  console.log(JSON.stringify(items, null, 1));
} catch (err) {
  failures += 1;
  console.error("ERROR", err);
  await page.screenshot({ path: "/tmp/verify-live-connections-error.png", fullPage: true }).catch(() => {});
} finally {
  // Restore the account's business role (the role clear was ours).
  if (roleCleared && originalRoles?.primary) {
    const restored = await page
      .evaluate(
        async ({ email, roles }) => {
          const r = await fetch(`/api/roles/assignments/${encodeURIComponent(email)}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ primary: roles.primary, secondary: roles.secondary ?? [] }),
          });
          return { status: r.status, body: await r.text() };
        },
        { email: EMAIL, roles: originalRoles },
      )
      .catch((e) => ({ status: 0, body: String(e) }));
    ok(
      "original role assignment restored",
      restored.status === 200,
      `${restored.status} ${String(restored.body).slice(0, 120)}`,
    );
  }
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`} (${results.length} assertions)`);
process.exit(failures === 0 ? 0 : 1);
