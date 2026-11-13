// fd-prod acceptance smoke for add-external-skill-sources (2026-10-15) AND
// add-external-skill-install (刀二, 2026-10-15). 刀一 section: logs in through
// Logto with the .env test account, opens the extensions market, switches to
// the external-source shelf tab, runs one real aggregated search against both
// upstream markets, and asserts the visible contract (per-source groups,
// provenance marks, detail dialog). 刀二 section (INSTALL=1, default on):
// installs one real SkillHub entry through the UI consent flow, asserts it in
// the installed list, then uninstalls it back to a clean state.
//
//   node scripts/verify-live-external-sources.mjs          # shelf + install
//   SKIP_INSTALL=1 node scripts/verify-live-external-sources.mjs  # shelf only
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLATFORM = process.env.PLATFORM_URL || "https://platform.finddatatech.cloud";

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

// The platform /login page is a shell: the real form lives on the Logto
// domain, reached through the sso-login link (which also carries rd +
// ui_locales). Clicking it is part of the flow, not an extra.
async function fillLogtoForm(page, timeoutMs = 30_000) {
  await page.getByTestId("login-page").waitFor({ state: "visible", timeout: timeoutMs });
  await page.getByTestId("sso-login").click();
  const identifier = page.locator('input[name="identifier"]');
  await identifier.waitFor({ state: "visible", timeout: timeoutMs });
  await identifier.fill(EMAIL);
  await page.locator('input[type="submit"], button:has-text("Sign in"), button:has-text("登录")').first().click();
  const password = page.locator('input[name="password"]');
  await password.waitFor({ state: "visible", timeout: timeoutMs });
  await password.fill(PASSWORD);
  await password.press("Enter");
}

const browser = await chromium.launch();
const page = await browser.newPage();
const apiCalls = [];
page.on("response", async (r) => {
  if (r.url().includes("/api/extensions/external") || r.url().includes("/api/extensions/skills")) {
    let body = "";
    let sources = null;
    try {
      body = await r.text();
      // Record the payload's group ids — the response is far too large for a
      // substring check once both sources return their full page of entries.
      const doc = JSON.parse(body);
      if (Array.isArray(doc.groups)) sources = doc.groups.map((g) => g.source);
    } catch { /* non-JSON or gone */ }
    apiCalls.push({ status: r.status(), url: r.url().replace(/^https:\/\/[^/]+/, ""), body: body.slice(0, 400), sources });
  }
});

try {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await fillLogtoForm(page);
  await page.waitForURL(/\/chat|\/settings/, { timeout: 60_000 });
  console.log("[smoke] logged in →", page.url());

  await page.goto(`${PLATFORM}/settings/mcp`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("extensions-page").waitFor({ state: "visible", timeout: 30_000 });

  const tab = page.getByTestId("extensions-tab-external");
  ok("external tab visible by default (no flag)", (await tab.count()) === 1);
  await tab.click();

  const shelf = page.getByTestId("external-source-shelf");
  await shelf.waitFor({ state: "visible", timeout: 20_000 });
  ok("shelf renders", true);

  await page.getByTestId("external-source-search").fill("pdf");
  await page.getByRole("button", { name: /^搜索$|^Search$/i }).click();

  // Real upstream aggregation takes a moment (two markets + snapshot cache).
  await page.getByTestId("external-group-skillhub").waitFor({ state: "visible", timeout: 60_000 });
  const smitheryVisible = await page
    .getByTestId("external-group-smithery")
    .waitFor({ state: "visible", timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  ok("both source groups render", smitheryVisible);

  const shelfHtml = await shelf.innerHTML();
  ok("not-reviewed mark present", /未经本平台审校|not reviewed/i.test(shelfHtml));
  ok("license three-state chip present", /许可证|License:/i.test(shelfHtml));
  ok("no install affordance on the shelf", !/>\s*(安装|Install)\s*</.test(shelfHtml));

  // First skillhub card → detail dialog.
  const firstCard = page
    .getByTestId("external-group-skillhub")
    .locator('[data-testid^="external-entry-skillhub-"]')
    .first();
  const cardCount = await firstCard.count();
  ok("skillhub group has at least one entry", cardCount > 0);
  if (cardCount > 0) {
    await firstCard.click();
    const dialog = page.getByTestId("external-entry-detail");
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
    ok("entry detail dialog opens", true);
    const hasUpstream = (await dialog.getByRole("link", { name: /open upstream|打开上游/i }).count()) > 0;
    ok("upstream link renders in detail", hasUpstream);
    if (process.env.DUMP_TEXT) {
      console.log("[smoke] dialog text:\n---\n" + (await dialog.innerText()) + "\n---");
    }
    await page.keyboard.press("Escape");
    const closedOnce = await dialog
      .waitFor({ state: "hidden", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    ok("detail dialog closes on Escape", closedOnce);
    if (closedOnce) {
      // Regression guard (fixed 7d89a91, image sha-09989ff): the detail fetch
      // still in flight at close time used to resolve late and re-open the
      // dialog. The upstream fetch has a 10s timeout, so watch for 12s.
      let reopened = false;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if ((await page.getByTestId("external-entry-detail").count()) > 0) {
          reopened = true;
          break;
        }
        await page.waitForTimeout(500);
      }
      ok("dialog stays closed after in-flight fetch resolves", !reopened);
    }
  }

  // ── 刀二: real install through the consent flow, then clean up ─────────────
  // One real SkillHub entry, by name (the pdf search's first card), installed
  // end-to-end in the production UI: detail → install button → preview panel
  // (files, scripts, license) → ack (when scripts) → confirm → success state →
  // installed list → uninstall. The entry is a real upstream download, so the
  // script-bearing path (the platform's core governance case) is exercised.
  if (!process.env.SKIP_INSTALL && cardCount > 0) {
    const slug = await firstCard.getAttribute("data-testid"); // external-entry-skillhub-<slug>
    const skillSlug = slug.replace("external-entry-skillhub-", "");
    // Mirrors external-install.js normalizeSkillName exactly (fold → trim →
    // ≤64 → strip a trailing hyphen the slice may have exposed).
    const installedName = skillSlug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/, "");

    // Re-open the detail dialog (it was closed by the Escape regression check).
    await firstCard.click();
    await page.getByTestId("external-entry-detail").waitFor({ state: "visible", timeout: 20_000 });
    const installBtn = page.getByTestId("external-install-button");
    ok("install button renders in detail dialog", (await installBtn.count()) === 1);
    await installBtn.click();

    const panel = page.getByTestId("external-install-dialog");
    await panel.waitFor({ state: "visible", timeout: 30_000 });
    ok("consent panel opens", true);

    // Preview arrives (a real package fetch happens server-side here).
    const loadFailed = await page
      .getByTestId("install-load-error")
      .waitFor({ state: "visible", timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    ok("preview loads without error", !loadFailed);
    if (!loadFailed) {
      ok("file inventory renders in the panel", (await page.getByTestId("install-file-list").count()) === 1);
      ok("package always listed honestly (≥1 file)", (await panel.locator('[data-testid="install-file-list"] li').count()) >= 1);
      const panelText = await panel.innerText();
      ok("not-reviewed mark present in consent panel", /未经本平台审校|not reviewed/i.test(panelText));

      const ack = page.getByTestId("install-ack-scripts");
      const needsAck = (await ack.count()) > 0;
      console.log(`[smoke] package script-gated: ${needsAck}`);
      if (needsAck) {
        const confirmBtn = page.getByTestId("install-confirm");
        ok("confirm is disabled before the script acknowledgement", await confirmBtn.isDisabled());
        await ack.check();
      }
      await page.getByTestId("install-confirm").click();

      const succeeded = await page
        .getByTestId("install-success")
        .waitFor({ state: "visible", timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (!succeeded) {
        const failText = await page
          .getByTestId("install-failure")
          .innerText()
          .catch(() => "(no failure node)");
        console.log(`[smoke] install failure text: ${failText}`);
      }
      ok("install succeeds through the UI", succeeded);

      if (succeeded) {
        console.log(`[smoke] installed as: ${installedName}`);
        await page.keyboard.press("Escape"); // close the panel
        await page.getByTestId("external-install-dialog").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});

        // The installed skills list lives under /settings/skills — the pages
        // share the external tab, but /settings/mcp's installed tab lists MCP
        // servers only (probe bug found in the first production run: the
        // install succeeded yet the card was invisible because of the page).
        await page.goto(`${PLATFORM}/settings/skills`, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await page.getByTestId("extensions-page").waitFor({ state: "visible", timeout: 30_000 });
        const card = page.locator(`[data-testid="skill-card"][data-skill-name="${installedName}"]`);
        const inList = await card
          .waitFor({ state: "visible", timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        ok("installed skill appears in the installed list", inList);

        // The install response shape also landed on the server: the row's
        // provenance is visible via the API the page itself just used.
        const skillsApi = apiCalls.find((c) => c.url.endsWith("/api/extensions/skills"));
        if (skillsApi) console.log(`[smoke] skills listing: ${skillsApi.body.slice(0, 200)}`);

        // Uninstall → back to a clean instance (the probe must not leave state).
        // KEEP_INSTALLED=1 skips this so the in-pod materialization check
        // (scripts/verify-live-external-sources.mjs → materialized dir) can
        // inspect the tree while the skill is live.
        if (process.env.KEEP_INSTALLED) {
          console.log(`[smoke] KEEP_INSTALLED set — leaving "${installedName}" installed for in-pod inspection`);
        } else if (inList) {
          page.once("dialog", (d) => d.accept()); // the confirm() guard
          await card.getByRole("button", { name: /删除|delete/i }).click();
          const gone = await card
            .waitFor({ state: "hidden", timeout: 20_000 })
            .then(() => true)
            .catch(() => false);
          ok("uninstall removes it from the list", gone);
        } else {
          console.log(`[smoke] WARNING: leaving "${installedName}" installed (list lookup failed)`);
        }
      }
    }
  } else if (process.env.SKIP_INSTALL) {
    console.log("[smoke] SKIP_INSTALL set — install flow skipped");
  }

  console.log("\n[smoke] external API calls observed:");
  for (const c of apiCalls) console.log(`  ${c.status} ${c.url}\n    ${c.body.slice(0, 220)}`);
  ok("search API returned 200", apiCalls.some((c) => c.status === 200 && c.url.includes("/search")));
  const searchCall = apiCalls.find((c) => c.url.includes("/search") && c.status === 200);
  const payloadSources = searchCall?.sources ?? [];
  ok(
    "search payload carries both sources",
    payloadSources.includes("skillhub") && payloadSources.includes("smithery"),
    `groups=[${payloadSources.join(", ")}]`,
  );

  // Snapshot-time facts, so a bad screenshot can never be misread as a pass
  // (or a good one as a fail): the URL, what the viewport actually holds, and
  // the shelf's own text.
  console.log(`[smoke] at-screenshot url: ${page.url()}`);
  console.log(`[smoke] at-screenshot shelf visible: ${await shelf.isVisible().catch(() => false)}`);
  if (process.env.DUMP_TEXT) {
    const text = (await shelf.innerText()).replace(/\n{2,}/g, "\n").slice(0, 1200);
    console.log("[smoke] shelf text (head):\n---\n" + text + "\n---");
    const dialogOpen = await page.getByTestId("external-entry-detail").count();
    console.log(`[smoke] at-screenshot detail dialog count: ${dialogOpen}`);
  }
  await page.screenshot({ path: "/tmp/external-shelf-prod.png", fullPage: false });
  console.log("[smoke] screenshot → /tmp/external-shelf-prod.png");
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
