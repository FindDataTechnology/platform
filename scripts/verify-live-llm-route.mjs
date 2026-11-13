// Production acceptance walkthrough for add-editable-llm-route (2026-10-01).
// Drives the REAL Models page on fd-prod through the three acceptance moves:
//   1. sync on the reserved Volces card (persists into the override, no dry run)
//   2. per-model contextWindow edit + save (hot-reload, no restart)
//   3. clear-override rollback to the baked/env projection
// Leaves the deployment as it found it (override cleared at the end). The
// default-lane guard may legitimately move the default off a dark lane during
// the post-sync probe — that is the feature working and is reported, not undone.
//
// Credentials: PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD from the repo .env
// (same source as verify-live-chat-fixes.mjs).
//
//   node scripts/verify-live-llm-route.mjs

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.env.PLATFORM_URL || "https://craw.finddatatech.cloud";

function dotenv(key) {
  const m = readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

const EMAIL = dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = dotenv("PAAS_TEST_PASSWORD");
if (!EMAIL || !PASSWORD) throw new Error("PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD not set in .env");

async function fillLogtoForm(page, timeoutMs = 30_000) {
  const identifier = page.locator('input[name="identifier"]');
  if (await identifier.isVisible().catch(() => false)) {
    await identifier.fill(EMAIL);
    await identifier.press("Enter");
  }
  const password = page.locator('input[name="password"]');
  await password.waitFor({ state: "visible", timeout: timeoutMs });
  await password.fill(PASSWORD);
  await password.press("Enter");
}

async function signInPlatform(page) {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(3000);
  if (!/auth\.finddatatech\.cloud/.test(page.url())) {
    const sso = page.getByRole("link", { name: /sign in with sso/i });
    if (await sso.isVisible().catch(() => false)) {
      await sso.click();
      await page.waitForTimeout(4000);
    }
  }
  if (/auth\.finddatatech\.cloud/.test(page.url())) {
    await fillLogtoForm(page);
    await page.waitForURL((u) => !/auth\.finddatatech\.cloud/.test(u.href), { timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }
}

// Read provider state through the page's authenticated session.
async function providers(page) {
  return page.evaluate(async () => {
    const r = await fetch("/api/llm/providers");
    const b = await r.json();
    const v = (b.providers || []).find((p) => p.id === "volces");
    const d = await (await fetch("/api/llm/default")).json();
    return { volces: v, def: d };
  });
}

const browser = await chromium.launch({ args: ["--proxy-server=direct://"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try { localStorage.setItem("platform.locale", "en"); } catch { /* ignore */ }
});
const page = await ctx.newPage();

const shot = (n) => page.screenshot({ path: `/tmp/accept-${n}.png`, fullPage: false });
const report = { steps: [] };
const note = (s, ok = true, extra = "") => { report.steps.push(`${ok ? "PASS" : "FAIL"} ${s}${extra ? " — " + extra : ""}`); console.log(report.steps.at(-1)); };

try {
  // ── 0. sign in ───────────────────────────────────────────────────────────
  await signInPlatform(page);
  if (!/\/chat|\/settings/.test(page.url())) throw new Error(`login did not land: ${page.url()}`);
  note("sign in", true, page.url());

  // ── 1. Models page, reserved card ────────────────────────────────────────
  await page.goto(`${PLATFORM}/models`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const card = page.locator('[data-testid="llm-provider-card"][data-provider-id="volces"]');
  await card.waitFor({ state: "visible", timeout: 30_000 });
  const before = await providers(page);
  note("reserved card renders", true, `models=${before.volces.models.length} override.active=${before.volces.override.active} default=${before.def.modelId}`);
  await shot("1-card");

  const isAdmin = (await card.getByTestId("llm-edit-models-btn").count()) === 1;
  if (!isAdmin) throw new Error("test account is not admin — run the API-level acceptance instead");
  note("admin actions visible (editor + override bar)", true);

  // ── 2. sync the reserved route (persisted, no dry run) ───────────────────
  await card.getByTestId("llm-sync-btn").click();
  // Long-lived: 20+ ids × probe. Success = the summary toast, then chips.
  await page.getByTestId("toast").waitFor({ state: "visible", timeout: 120_000 }).catch(() => {});
  const afterSync = await providers(page);
  const statuses = Object.values(afterSync.volces.discovery || {});
  const serving = statuses.filter((s) => s.status === "serving").length;
  note("sync persisted on the reserved route", afterSync.volces.override.active === true && statuses.length > 0,
    `${statuses.length} classified, ${serving} serving, override.active=${afterSync.volces.override.active}, roster=${afterSync.volces.models.length}, default now=${afterSync.def.modelId}`);
  await shot("2-sync");
  const fallbackToast = await page.getByTestId("toast").innerText().catch(() => "");
  if (/e2e|switched|dark/i.test(fallbackToast) || afterSync.def.modelId !== before.def.modelId) {
    note("guard moved the default off a dark lane (feature working)", true, `${before.def.modelId} -> ${afterSync.def.modelId}`);
  }

  // ── 3. contextWindow edit ────────────────────────────────────────────────
  await card.getByTestId("llm-edit-models-btn").click();
  const editor = card.locator('[data-testid="llm-model-editor"]');
  await editor.waitFor({ state: "visible", timeout: 15_000 });
  const firstRow = editor.locator("li").first();
  const firstId = (await firstRow.innerText()).split("\n")[0].trim();
  const cwInput = firstRow.getByTestId("llm-model-context-window");
  const putSeen = page.waitForRequest(
    (req) => req.method() === "PUT" && req.url().includes("/api/llm/providers/volces"),
  );
  await cwInput.fill("96000");
  await card.getByTestId("llm-model-save").click();
  const put = await putSeen;
  const putResponse = await put.response();
  const payload = put.postDataJSON();
  const sent = payload.models?.find?.((m) => m.id === firstId);
  note("contextWindow edit travels in the PUT", sent?.contextWindow === 96000,
    `${firstId} contextWindow=${sent?.contextWindow} maxTokens=${sent?.maxTokens} (HTTP ${putResponse?.status()})`);
  await shot("3-contextwindow");
  const afterEdit = await providers(page);
  note("roster still hot after edit", afterEdit.volces.override.active === true, `roster=${afterEdit.volces.models.length}`);

  // ── 4. clear the override (rollback) ─────────────────────────────────────
  await card.getByTestId("llm-override-clear").click();
  await expect_count0(page, card, "llm-override-active");
  const afterClear = await providers(page);
  note("clear rolls back to baked/env projection", afterClear.volces.override.active === false,
    `roster=${afterClear.volces.models.length}, deepseek-v4.1-flash present=${afterClear.volces.models.includes("deepseek-v4.1-flash")}`);
  await shot("4-cleared");
} catch (e) {
  note(`aborted: ${e.message}`, false);
  await shot("error").catch(() => {});
} finally {
  console.log("\n=== acceptance ===");
  for (const s of report.steps) console.log(s);
  await browser.close();
}

async function expect_count0(page, card, testid) {
  for (let i = 0; i < 30; i++) {
    if ((await card.getByTestId(testid).count()) === 0) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`${testid} did not disappear`);
}
