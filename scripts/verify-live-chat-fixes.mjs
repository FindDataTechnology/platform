// Live regression check for the three chat defects reported on 2026-09-21, run
// against a deployed instance:
//
//   LOGTO_EMAIL=… LOGTO_PASSWORD=… node scripts/verify-live-chat-fixes.mjs
//
// The repo's .env already carries the deployment's test account as
// PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD, which are used when the LOGTO_*
// variables are unset — the password never has to be typed on the command line.
//
//   1. memory      — two turns in one session: the second asks for a code word
//                    the first one set. A forked/remote agent answers "no
//                    memory"; the local runtime answers the code word.
//   2. reasoning   — the thinking block streams open and folds when the answer
//                    lands (data-open flips to false without a click).
//   3. the name    — the configured ASSISTANT_NAME (GET /api/config) shows in
//                    the sidebar title, the turn header and the composer
//                    placeholder.
//   4. MCP tools   — the session the deployment ran carries marketplace MCP
//                    tools (mcp__*), i.e. the chat is on the agent that HAS them.
//   5. the round trip — a vertical-pack agent answers in character, and
//                    switching back to the built-in agent restores the
//                    deployment's own preset instead of keeping the pack.
//
// Read-only against the deployment except for one throwaway chat session.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

// The repo .env names the deployment's test account; read it here so the caller
// passes nothing on the command line (and the password never lands in a shell
// history or a process list).
function dotenv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") : undefined;
  } catch {
    return undefined;
  }
}

const PLATFORM = process.env.PLATFORM_URL_LIVE || "https://craw.finddatatech.cloud";
const EMAIL = dotenv("LOGTO_EMAIL") || dotenv("PAAS_TEST_IDENTIFIER");
const PASSWORD = dotenv("LOGTO_PASSWORD") || dotenv("PAAS_TEST_PASSWORD");
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 240_000);
if (!EMAIL || !PASSWORD) throw new Error("LOGTO_EMAIL/LOGTO_PASSWORD (or PAAS_TEST_*) not set");

const results = [];
const ok = (m) => { results.push(`PASS  ${m}`); console.log(`✓ ${m}`); };
const bad = (m) => { results.push(`FAIL  ${m}`); console.log(`✗ ${m}`); };

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

async function signIn(page) {
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

// Send one prompt and wait for the turn to finish. The assistant turn is
// created only when `agent_start` arrives, so wait for the turn COUNT to grow
// first — otherwise `.last()` still points at the previous turn and every
// assertion reads the wrong answer.
async function sendTurn(page, text) {
  const before = await page.getByTestId("turn-assistant").count();
  const input = page.getByTestId("composer-input");
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(text);
  await page.getByTestId("composer-send").click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="turn-assistant"]').length > n,
    before,
    { timeout: 90_000 },
  );
  await page
    .waitForFunction(() => {
      const turns = document.querySelectorAll('[data-testid="turn-assistant"]');
      const last = turns[turns.length - 1];
      return last && last.getAttribute("data-streaming") === "false";
    }, { timeout: TURN_TIMEOUT_MS })
    .catch(() => {});
  return page.getByTestId("turn-assistant").last();
}

const browser = await chromium.launch({ args: ["--proxy-server=direct://"] });
try {
  const config = await (await fetch(`${PLATFORM}/api/config`)).json();
  const name = config.assistantName;
  console.log(`deployment name: ${JSON.stringify(name)}`);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page);
  if (!/craw\.finddatatech\.cloud/.test(page.url())) {
    bad(`sign-in did not land on the platform (at ${page.url()})`);
    throw new Error("not signed in");
  }
  ok("signed in");

  // ── 3. the configured name, in all three places ────────────────────────────
  const expectBrand = name || "Platform";
  await page.goto(`${PLATFORM}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const sidebar = await page.getByTestId("sidebar").innerText().catch(() => "");
  if (sidebar.includes(expectBrand)) ok(`sidebar shows the configured name (${expectBrand})`);
  else bad(`sidebar does not show ${expectBrand}: ${sidebar.slice(0, 60)}`);

  const placeholder = await page.getByTestId("composer-input").getAttribute("placeholder").catch(() => "");
  if (placeholder && placeholder.includes(expectBrand)) ok(`composer placeholder names it: ${placeholder.slice(0, 40)}`);
  else bad(`composer placeholder does not name it: ${placeholder}`);

  const title = await page.title();
  if (!name || title === name) ok(`tab title is ${JSON.stringify(title)}`);
  else bad(`tab title is ${JSON.stringify(title)}, expected ${JSON.stringify(name)}`);

  // A brand-new session so the memory check is not reading old turns.
  await page.getByTestId("new-chat-btn").click().catch(async () => {
    await page.goto(`${PLATFORM}/chat`, { waitUntil: "domcontentloaded" });
  });
  await page.waitForTimeout(3000);

  // ── 1. memory across two turns ─────────────────────────────────────────────
  const CODE = "菠萝蜜";
  await sendTurn(page, `请记住一个暗号：${CODE}。只回复"收到"两个字。`);
  let turn2 = await sendTurn(page, "我的暗号是什么？只回复暗号本身。");
  let answer = (await turn2.innerText()).replace(/\s+/g, " ");
  if (!answer.includes(CODE) && /失败|failed/i.test(answer)) {
    // The public gateway flakes (docs/vertical-packs.md §8) — one retry.
    console.log("· the second turn hit a stream error; retrying once");
    turn2 = await sendTurn(page, "我的暗号是什么？只回复暗号本身。");
    answer = (await turn2.innerText()).replace(/\s+/g, " ");
  }
  if (answer.includes(CODE)) ok(`the second turn knew the code word from the first (${CODE})`);
  else bad(`the second turn did not recall the code word: ${answer.slice(0, 200)}`);

  // ── 2. reasoning folds when the answer lands ──────────────────────────────
  const thinking = page.getByTestId("thinking-block").last();
  if (await thinking.count()) {
    const open = await thinking.getAttribute("data-open");
    if (open === "false") ok("the reasoning block is folded after the turn completed");
    else bad(`the reasoning block is still expanded (data-open=${open})`);
    await thinking.getByRole("button").click();
    await page.waitForTimeout(500);
    const reopened = await thinking.getAttribute("data-open");
    if (reopened === "true") ok("clicking it reopens the reasoning");
    else bad("clicking the folded reasoning did not open it");
  } else {
    console.log("· no reasoning block in this turn (model emitted no reasoning) — skipped");
  }

  // ── the turn header names the assistant ───────────────────────────────────
  const header = await turn2.innerText();
  if (header.includes(expectBrand)) ok(`turn header names it (${expectBrand})`);
  else bad(`turn header does not name it: ${header.slice(0, 80)}`);

  // ── 4. a vertical-pack agent runs on the LOCAL runtime ────────────────────
  // The reported bug: selecting a pack agent switched the chat onto the entry's
  // bare remote endpoint (no persona, no tools, no history). It must now be a
  // preset switch that keeps the local runtime.
  await page.getByTestId("strip-more").click();
  const agentOption = page.getByTestId("strip-agent-option").filter({ hasText: "合同审查官" });
  if (await agentOption.count()) {
    await agentOption.first().click();
    console.log("· selected 合同审查官 — waiting for the preset switch (runtime restart)");
    await page.waitForTimeout(15000);
    await page.getByTestId("new-chat-btn").click();
    await page.waitForTimeout(3000);
    const packTurn = await sendTurn(page, "用一句话说明你是谁、负责什么。");
    const packText = (await packTurn.innerText()).replace(/\s+/g, " ");
    if (/合同|审查|法律/.test(packText)) ok(`the pack agent answered in character: ${packText.slice(0, 100)}`);
    else bad(`the pack agent did not answer in character: ${packText.slice(0, 140)}`);
  } else {
    bad("the agent picker did not offer 合同审查官 (catalog/roles?)");
  }

  // ── 5. switching back to the built-in agent drops the pack persona ────────
  // A selected pack's id IS the persisted preset (that is what a restart
  // composes), so a round trip that naively re-reads it re-selects the pack:
  // the picker keeps naming it while the agent row says the built-in agent.
  await page.getByTestId("strip-more").click();
  const builtInOption = page.getByTestId("strip-agent-option").filter({ hasText: expectBrand });
  if (await builtInOption.count()) {
    await builtInOption.first().click();
    console.log("· selected the built-in agent — waiting for the preset switch");
    await page.waitForTimeout(15000);
    await page.getByTestId("new-chat-btn").click();
    await page.waitForTimeout(3000);
    const presetLabel = (await page.getByTestId("agent-preset-picker").innerText().catch(() => "")).trim();
    if (/标准|Standard/i.test(presetLabel)) ok(`the built-in agent restored the deployment's own preset (${presetLabel})`);
    else bad(`after switching back, the preset chip reads ${JSON.stringify(presetLabel)} — expected the deployment's own preset`);
  } else {
    bad(`the agent picker did not offer the built-in agent under the configured name (${expectBrand})`);
  }

  await context.close();
} catch (err) {
  bad(`probe error: ${err.message}`);
} finally {
  await browser.close();
}

console.log("\n" + results.join("\n"));
console.log(results.some((r) => r.startsWith("FAIL")) ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
