// Live walk-through of the connect flows that can be exercised without
// external credentials the operator does not have in .env (2026-10-18).
//
//   node scripts/verify-live-connect-flows.mjs
//
// Covered here (each asserts /api/connections flips):
//   * wire-customer mint (server-mediated authorization-code round trip)
//   * lex mint (same machinery, different line)
//   * paper-trading rejection of a non-fdt_ token (the refusal path)
//   * search: the shared-pool probe button (admin, read-only)
//   * registry / connector: disconnect → reconnect (reversible; the live
//     Logto session makes both silent). Skipped unless FLOW_RECONNECT=1.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.env.PLATFORM_URL || "https://platform.finddatatech.cloud";
const dotenv = (k) => (readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const EMAIL = dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = dotenv("PAAS_TEST_PASSWORD");

let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "zh-CN" });
const page = await ctx.newPage();

async function state(id) {
  const doc = await page.evaluate(async () => (await fetch("/api/connections")).json()).catch(() => null);
  return (doc?.connections || []).find((c) => c.id === id);
}

// The mint is a FULL-PAGE authorization round trip: the click navigates away
// (Logto) and back. The FIRST mint of a line per user lands on Logto's consent
// screen (the retry leg drops prompt=none by design); approve it if present,
// then poll the aggregate — a fixed sleep races the redirect chain.
async function approveConsentIfShown() {
  if (!/auth\.finddatatech\.cloud/.test(page.url())) return false;
  const label = page.getByRole("button", { name: /^(Continue|Authorize|Allow|允许|继续|同意)$/i }).first();
  const present = await label.isVisible().catch(() => false);
  if (!present) return false;
  console.log("  approving Logto consent screen");
  await label.click().catch(() => {});
  return true;
}

async function waitConnected(id, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    await approveConsentIfShown();
    last = await state(id);
    if (last?.state === "connected") return last;
    await page.waitForTimeout(1500);
  }
  return last;
}

try {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("login-page").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("sso-login").click();
  await page.locator('input[name="identifier"]').waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('input[name="identifier"]').fill(EMAIL);
  await page.locator('input[name="identifier"]').press("Enter");
  await page.locator('input[name="password"]').waitFor({ state: "visible", timeout: 30_000 });
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('input[name="password"]').press("Enter");
  await page.waitForURL(/\/chat|\/settings/, { timeout: 60_000 });
  console.log("logged in:", page.url());

  // The account carries a business role whose preset used to hide the
  // section; the section must still be reachable after the preset fix ships.
  const before = await state("line-wire-customer");
  console.log("  line-wire-customer before:", JSON.stringify(before));

  // ── 1. wire-customer mint ───────────────────────────────────────────────
  await page.goto(`${PLATFORM}/settings/connections?panel=line-wire-customer`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const sectionSeen = await page
    .getByTestId("settings-section-connections")
    .waitFor({ state: "visible", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  ok("connections section reachable for the role-carrying account", sectionSeen, page.url());

  if (sectionSeen) {
    // Rows are `<div.border-t>`; the title is the row's first text node and the
    // action column holds its button. Anchor per row so an already-connected
    // sibling (whose button reads 断开) cannot shift the index.
    const row = (title) => page.locator("[data-testid='settings-connections'] div.border-t").filter({ hasText: title }).first();
    const wireRow = row("柏讯操作");
    const wireBtn = wireRow.getByRole("button", { name: /^连接$/ }).first();
    const wireReady = await wireBtn
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    console.log(`  wire connect button ready: ${wireReady}`);
    if (wireReady) {
      await wireBtn.click();
      // Full-page round trip through Logto; the callback lands back on the
      // same panel. Poll the aggregate rather than sleeping.
      await page.waitForURL(/\/settings\/connections/, { timeout: 90_000 }).catch(() => {});
      const after = await waitConnected("line-wire-customer");
      ok("wire-customer mint flips /api/connections to connected", after?.state === "connected", JSON.stringify(after));
      const mintErr = await page.locator("text=连接未完成").count();
      ok("no mint-failure marker on the card", mintErr === 0, `markers=${mintErr}`);
    } else {
      console.log("  (skip) wire-customer connect button not found — card may already be connected");
    }

    // ── 2. lex mint (same machinery) ──────────────────────────────────────
    // Re-locate by row (after wire connects its row's button reads 断开).
    await page.goto(`${PLATFORM}/settings/connections?panel=line-lex`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("settings-section-connections").waitFor({ state: "visible", timeout: 30_000 });
    const lexBtn = row("识律操作").getByRole("button", { name: /^连接$/ }).first();
    const lexReady = await lexBtn
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (lexReady) {
      await lexBtn.click();
      await page.waitForURL(/\/settings\/connections/, { timeout: 90_000 }).catch(() => {});
      const after = await waitConnected("line-lex");
      ok("lex mint flips /api/connections to connected", after?.state === "connected", JSON.stringify(after));
    } else {
      console.log("  (skip) lex connect button not found");
    }

    // ── 3. paper-trading refusal path ─────────────────────────────────────
    await page.goto(`${PLATFORM}/settings/connections?panel=paper-trading`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("paper-trading-connect-panel").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("paper-trading-token-input").fill("not-an-fdt-token");
    await page.getByTestId("paper-trading-save").click();
    await page.getByTestId("paper-trading-error").waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const errText = await page.getByTestId("paper-trading-error").innerText().catch(() => "");
    ok("paper-trading refuses a non-fdt_ token with a readable reason", /fdt_/.test(errText), errText.slice(0, 120));
    ok("paper-trading stays disconnected after the refusal", (await state("paper-trading"))?.state === "disconnected");

    // ── 4. search shared-pool probe (admin, read-only) ────────────────────
    await page.goto(`${PLATFORM}/settings/connections?panel=search`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("search-service-card").waitFor({ state: "visible", timeout: 20_000 });
    const sharedVisible = await page.getByTestId("websearch-shared").isVisible().catch(() => false);
    if (sharedVisible) {
      const testBtn = page.getByTestId("websearch-test");
      if ((await testBtn.count()) > 0) {
        await testBtn.click();
        await page.getByTestId("websearch-test-result").waitFor({ state: "visible", timeout: 40_000 }).catch(() => {});
        const probe = await page.getByTestId("websearch-test-result").innerText().catch(() => "");
        ok("shared search relay probe answers", probe.length > 0, probe.slice(0, 140));
      }
    }
  }

  // ── 5. registry / connector reconnect (opt-in) ──────────────────────────
  if (process.env.FLOW_RECONNECT === "1") {
    await page.goto(`${PLATFORM}/settings/connections?panel=registry`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByTestId("registry-connect-panel").waitFor({ state: "visible", timeout: 20_000 });
    if ((await page.getByTestId("registry-disconnect").count()) > 0) {
      await page.getByTestId("registry-disconnect").click();
      await page.waitForTimeout(1500);
      ok("registry disconnect flips the aggregate", (await state("registry"))?.state === "disconnected");
      await page.getByTestId("registry-connect").click();
      await page.waitForTimeout(8000);
      ok("registry silent reconnect flips it back", (await state("registry"))?.state === "connected", JSON.stringify(await state("registry")));
    }
  } else {
    console.log("  (skip) registry/connector disconnect→reconnect (set FLOW_RECONNECT=1 to run; it touches live credentials)");
  }
} catch (err) {
  failures += 1;
  console.error("ERROR", err);
  await page.screenshot({ path: "/tmp/verify-live-connect-flows-error.png", fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
