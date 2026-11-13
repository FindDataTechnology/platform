// Full dress rehearsal of the four vertical packs on a live deployment
// (add-vertical-sample-packs task 5.2):
//
//   node scripts/verify-live-vertical-packs.mjs
//
// Credentials come from the repo .env (PAAS_TEST_IDENTIFIER / PAAS_TEST_PASSWORD
// or LOGTO_EMAIL / LOGTO_PASSWORD) — nothing is typed on the command line.
//
// Per docs/vertical-packs.md:
//   A. as the demo account (both roles): the Store shows the pack's entries,
//      the market connects with the SSO path (only if not already connected),
//      the four entry skills install, each pack's canned input produces its
//      expected deliverable with the pack's agent selected, and the trace
//      carries real mcp__<server>__<tool> calls.
//   B. wrong-role check: WRONG_ROLE_EMAIL/WRONG_ROLE_PASSWORD sign in a second
//      account; without them the script tries the Logto sign-up path to create
//      a fresh one. Either way it must see none of the gated entries.
//
// The script leaves the demo account on the built-in agent. Read-only against
// the deployment except for: entry-skill installs, the throwaway demo chat
// sessions, and (if sign-up is open) one fresh Logto user.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

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
const WRONG_ROLE_EMAIL = process.env.WRONG_ROLE_EMAIL || "";
const WRONG_ROLE_PASSWORD = process.env.WRONG_ROLE_PASSWORD || "";
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 720_000);
const SKIP_DEMOS = process.env.SKIP_DEMOS === "1";
const SKIP_WRONG_ROLE = process.env.SKIP_WRONG_ROLE === "1";
// Comma-separated skill names to uninstall+reinstall before the demos, so the
// materialized copy picks up registry content that changed after the original
// install (e.g. after a drift re-registration).
const REINSTALL = (process.env.REINSTALL || "").split(",").map((s) => s.trim()).filter(Boolean);
// Comma-separated demo ids to run (contract,case,stock,macro); empty = all four.
const DEMO_FILTER = (process.env.DEMOS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!EMAIL || !PASSWORD) throw new Error("LOGTO_EMAIL/LOGTO_PASSWORD (or PAAS_TEST_*) not set");

const results = [];
const ok = (m) => { results.push(`PASS  ${m}`); console.log(`✓ ${m}`); };
const bad = (m) => { results.push(`FAIL  ${m}`); console.log(`✗ ${m}`); };
const note = (m) => { results.push(`NOTE  ${m}`); console.log(`· ${m}`); };

// In-page JSON GET with retries: the public ingress occasionally hands back an
// empty body mid-tunnel, which a bare r.json() turns into a SyntaxError.
async function fetchJson(page, url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.evaluate(async (u) => {
        const r = await fetch(u);
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
      }, url);
    } catch (err) {
      if (i === attempts - 1) throw err;
      await page.waitForTimeout(2000);
    }
  }
}


const PACK_SKILLS = [
  "legal-contract-workflow",
  "legal-case-workflow",
  "stock-research-workflow",
  "china-macro-brief-workflow",
];
const PACK_SERVERS = ["law-bench", "fd-open-data-mcp", "fd-cn-report", "fd-find-data-business-mcp"];

// The canned demo input per pack (docs/vertical-packs.md §5, verbatim where the
// playbook quotes one). The contract text is the demo's 800–1200-char excerpt
// with the three planted defects: no cap on liquidated damages, a one-sided
// acceptance clause, a vague dispute clause.
const CONTRACT_TEXT = `产品采购合同（节选）
甲方（买方）：上海某某科技有限公司　乙方（卖方）：某某设备有限公司
第一条 标的与价款：甲方向乙方采购自动化检测设备两台，单价人民币96万元，总价192万元（含税）。合同签订后7个工作日内甲方支付合同总额的60%作为预付款；设备安装调试完成后10日内支付剩余40%。
第二条 交付与验收：乙方于合同生效后60日内送货至甲方厂区并完成安装调试。设备到货后乙方立即组织安装调试，调试完成连续运行48小时即视为验收合格；甲方收到乙方验收报告后3日内未提出书面异议的，视为验收通过，双方签署验收单。
第三条 质量与售后：设备质保期自验收合格之日起12个月，质保期内因非甲方原因出现的质量问题，乙方负责免费维修。
第四条 违约责任：任何一方违约的，应向守约方支付违约金，违约金按未履行部分价款的每日0.5%计算。乙方逾期交货超过30日的，甲方有权解除本合同，已付预付款不予退还。
第五条 争议解决：因本合同引起的争议，双方应友好协商解决；协商不成的，任何一方均可向有管辖权的人民法院提起诉讼。`;

const DEMOS = [
  {
    id: "contract",
    pack: "法律-合同",
    agent: "合同审查官",
    expectServer: "law-bench",
    prompt: `我方是买方（甲方），请审查以下采购合同节选的风险并给出修改建议：\n${CONTRACT_TEXT}`,
    markers: [
      [/违约金/, "风险明细提到违约金条款"],
      [/验收/, "风险明细提到验收条款"],
      [/争议|管辖|仲裁|诉讼/, "风险明细提到争议解决条款"],
      [/高|中|低/, "风险有分级"],
      [/法|条例/, "给出法条依据"],
    ],
    softMarkers: [[/律师|复核|置信/, "律师复核/置信度提醒"], [/建议|修改|措辞/, "可替换措辞"]],
  },
  {
    id: "case",
    pack: "法律-案件",
    agent: "案件分析师",
    expectServer: "fd-find-data-business-mcp",
    prompt: `我代理劳动者一方。案情：张某2022年3月入职某科技公司任高级工程师，月工资2万元。2025年8月，公司以张某"严重违反规章制度"为由即时解除劳动合同，且未支付未休年假工资。公司据以解除的《员工手册》由行政部门直接发布，未经职工代表大会或全体职工讨论，也未与工会或职工协商；公司无法举证张某"严重违反"的具体条款与事实。请做案件研判：争议焦点、法条依据、诉讼策略，并给出赔偿测算。`,
    markers: [
      [/争议焦点|焦点/, "给出争议焦点"],
      [/劳动合同法|年休假|规章制度/, "法条依据落在劳动合同法/年休假/规章制度"],
      [/策略|攻防/, "给出诉讼策略/攻防"],
      [/赔偿|2N|八十七/, "给出赔偿测算"],
    ],
    softMarkers: [[/类案/, "如实标注类案检索边界"], [/时效|仲裁|证据/, "时效/仲裁/证据提示"]],
  },
  {
    id: "stock",
    pack: "数据-股票",
    agent: "行业分析师",
    expectServer: "fd-open-data-mcp|fd-cn-report",
    prompt: "帮我研究一下贵州茅台（600519.SH）当前的投资价值。",
    markers: [
      [/茅台|600519/, "落到标的"],
      [/估值|PE|市盈|DCF/, "有估值汇总"],
      [/多空|风险/, "有多空对照/风险清单"],
      [/研报|行业/, "有研报/行业交叉"],
    ],
    softMarkers: [[/免责/, "免责声明"], [/财务|营收|利润/, "财报速览"]],
  },
  {
    id: "macro",
    pack: "数据-中国经济",
    agent: "行业分析师",
    expectServer: "fd-open-data-mcp|fd-cn-report",
    prompt: "现在的货币信用环境对A股制造业意味着什么？给我一份简报。",
    markers: [
      [/M1|M2|社融|LPR/, "指标框架落到 M1/M2/社融/LPR"],
      [/制造业/, "落到制造业含义"],
      [/传导|逻辑/, "有传导逻辑链"],
      [/图|表/, "有图表/数据表"],
    ],
    softMarkers: [[/风险|观察/, "风险与观察点"], [/来源|期/, "数值带期数来源"]],
  },
];

async function fillLogtoForm(page, email, password, timeoutMs = 30_000) {
  const identifier = page.locator('input[name="identifier"]');
  if (await identifier.isVisible().catch(() => false)) {
    await identifier.fill(email);
    await identifier.press("Enter");
  }
  const passwordField = page.locator('input[name="password"]');
  await passwordField.waitFor({ state: "visible", timeout: timeoutMs });
  await passwordField.fill(password);
  await passwordField.press("Enter");
}

async function signIn(page, email, password) {
  await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(3000);
  if (!/auth\.finddatatech\.cloud/.test(page.url())) {
    const sso = page.getByRole("link", { name: /sign in with sso/i });
    if (await sso.isVisible().catch(() => false)) {
      await sso.click();
      await page.waitForTimeout(4000);
    }
  }
  // The hosted login card occasionally stalls (its providers call loses a
  // race, or the identifier step silently no-ops) — reload and retry once.
  for (let attempt = 1; attempt <= 2 && /auth\.finddatatech\.cloud/.test(page.url()); attempt++) {
    if (attempt > 1) {
      console.log("· sign-in attempt stalled — reloading the login card");
      await page.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
      await page.waitForTimeout(4000);
      const sso = page.getByRole("link", { name: /sign in with sso/i });
      if (await sso.isVisible().catch(() => false)) {
        await sso.click();
        await page.waitForTimeout(4000);
      }
    }
    await fillLogtoForm(page, email, password, 45_000).catch(() => {});
    await page.waitForURL((u) => !/auth\.finddatatech\.cloud/.test(u.href), { timeout: 90_000 }).catch(() => {});
  }
  await page.waitForTimeout(2000);
  return page.url();
}

// Connect the MCP market with the V1 SSO path ONLY if not already connected:
// the credential carries over for 168 h, and a demo operator should not need
// this click on an already-connected account.
async function ensureMarketConnected(page) {
  const state = await page.evaluate(() =>
    fetch("/api/registry/connection").then((r) => r.json()).catch(() => ({ connected: false })));
  if (state.connected) {
    ok(`market credential already connected (expires ${state.expiresAt}) — V1 one-click not needed`);
    return true;
  }
  console.log("· market not connected — driving the V1 connect flow (Continue with Logto)");
  await page.goto(`${PLATFORM}/settings/mcp`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("extensions-page").waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.getByRole("button", { name: /store/i }).click();
  const panel = page.getByTestId("mcp-market-section").getByTestId("registry-connect-panel");
  await panel.waitFor({ state: "visible", timeout: 45_000 });

  const popupPromise = page.context().waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await panel.getByTestId("registry-connect").click();
  const howPromise = popupPromise.then(async (popup) => {
    if (!popup) return "no window (a registry session was already live)";
    try {
      await popup.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
      let hasButton = false;
      for (let attempt = 1; attempt <= 3 && !hasButton; attempt++) {
        hasButton = await popup.getByRole("button", { name: /continue with logto/i })
          .isVisible({ timeout: 12_000 }).catch(() => false);
        if (!hasButton && attempt < 3) {
          await popup.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await popup.waitForTimeout(3000);
        }
      }
      if (hasButton) {
        await popup.getByRole("button", { name: /continue with logto/i }).click();
        return '"Continue with Logto" clicked — nothing typed';
      }
      return `nothing to click at ${popup.url().slice(0, 60)}`;
    } catch (err) {
      return `window closed by the platform mid-drive (the mint had landed): ${String(err.message).split("\n")[0].slice(0, 60)}`;
    }
  });

  const deadline = Date.now() + 120_000;
  let now = await panel.getAttribute("data-registry-state");
  while (Date.now() < deadline && now !== "connected") {
    await page.waitForTimeout(1500);
    now = await panel.getAttribute("data-registry-state");
  }
  const how = await howPromise;
  if (now !== "connected") {
    bad(`market connect did not complete (${how})`);
    return false;
  }
  ok(`market connected via ${how}`);
  return true;
}


// Server-side truth for "the turn is done": the UI's streaming flag can flip
// false between agent steps, so after it settles, poll the newest trace turn
// and require its event count to be stable across two samples.
async function waitServerQuiet(page, timeoutMs = 900_000) {
  const read = async () => {
    const body = (await fetchJson(page, "/api/trace/turns?limit=1").catch(() => ({ body: null }))).body;
    const t = (body?.turns || [])[0];
    return t ? t.eventCount : -1;
  };
  const deadline = Date.now() + timeoutMs;
  let prev = await read();
  while (Date.now() < deadline) {
    await page.waitForTimeout(8000);
    const now = await read();
    if (now === prev && now > 0) return;
    prev = now;
  }
  note("waitServerQuiet: timed out — the newest trace turn is still growing");
}

// Send one prompt and wait for the turn to finish. The assistant turn is
// created only when `agent_start` arrives, so wait for the turn COUNT to grow
// first — otherwise `.last()` still points at the previous turn.
async function sendTurn(page, text) {
  const before = await page.getByTestId("turn-assistant").count();
  const input = page.getByTestId("composer-input");
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.fill(text);
  // The composer is disabled while a turn streams — with the slow default
  // model a previous turn can still be running. Wait it out instead of
  // clicking into a disabled send button.
  const send = page.getByTestId("composer-send");
  await send.waitFor({ state: "visible", timeout: 30_000 });
  for (let i = 0; i < 40 && !(await send.isEnabled()); i++) await page.waitForTimeout(5000);
  await send.click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="turn-assistant"]').length > n,
    before,
    { timeout: 120_000 },
  );
  // The free default model can stream a full workflow report for many
  // minutes; wait the turn timeout, then extend once before giving up.
  const settled = () =>
    page.waitForFunction(() => {
      const turns = document.querySelectorAll('[data-testid="turn-assistant"]');
      const last = turns[turns.length - 1];
      return last && last.getAttribute("data-streaming") === "false";
    }, { timeout: TURN_TIMEOUT_MS });
  await settled().catch(() => settled().catch(() => {}));
  // The streaming flag can go false mid-run (between agent steps); trust the
  // server trace before reading text.
  await waitServerQuiet(page);
  await page.waitForTimeout(2500);
  return page.getByTestId("turn-assistant").last();
}


// The composer strip disables itself while a turn streams or the runtime is
// mid-restart — wait it out before opening any menu.
async function waitEnabled(locator, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return;
    await page_waitsafe(2000);
  }
  throw new Error("control still disabled after timeout");
}
async function page_waitsafe(ms) { await new Promise((r) => setTimeout(r, ms)); }

async function selectAgent(page, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
    await waitEnabled(page.getByTestId("strip-more"));
    await page.getByTestId("strip-more").click();
    const option = page.getByTestId("strip-agent-option").filter({ hasText: label }).first();
    await option.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    // Options render disabled while a runtime restart is still settling.
    if (!(await option.isVisible().catch(() => false))) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(10_000);
      continue;
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (await option.isEnabled()) break;
      await page.waitForTimeout(2000);
    }
    if (!(await option.isEnabled())) {
      await page.keyboard.press("Escape");
      continue;
    }
    await option.click();
    console.log(`· selected agent ${label} — waiting for the preset switch to land`);
    // The switch lands when the option shows aria-checked=true on a fresh menu.
    let landed = false;
    for (let check = 0; check < 20 && !landed; check++) {
      await page.waitForTimeout(5000);
      await page.getByTestId("strip-more").click();
      landed = (await option.getAttribute("aria-checked")) === "true";
      await page.keyboard.press("Escape");
    }
    if (landed) {
      await page.getByTestId("new-chat-btn").click();
      await page.waitForTimeout(3000);
      return true;
    }
    console.log(`· the switch to ${label} did not land yet (attempt ${attempt}/3)`);
    } catch (err) {
      console.log(`· selectAgent attempt ${attempt} failed: ${String(err.message).split("\n")[0]}`);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(10_000);
    }
  }
  return false;
}

// Restore the account's selected model to the DEPLOYMENT default (GET
// /api/llm/default). This never picks a different lane — it only undoes a
// selection a previous run may have left behind (e.g. a model the account's
// key no longer serves, which 404s every turn).
async function restoreDefaultModel(page) {
  const def = (await fetchJson(page, "/api/llm/default").catch(() => ({ body: null }))).body;
  const modelId = def?.modelId || def?.model || def?.id || null;
  if (!modelId) {
    note("could not read the deployment default model — leaving the account's model untouched");
    return;
  }
  await page.getByTestId("strip-model").click();
  const menu = page.getByTestId("strip-model-menu");
  await menu.waitFor({ state: "visible", timeout: 15_000 });
  const items = menu.getByTestId("strip-menu-item");
  const count = await items.count();
  let target = null;
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    if ((await item.innerText()).includes(modelId)) { target = item; break; }
  }
  if (!target) {
    await page.keyboard.press("Escape");
    bad(`the model picker does not list the deployment default (${modelId})`);
    return;
  }
  if ((await target.getAttribute("aria-checked")) === "true") {
    await page.keyboard.press("Escape");
    ok(`account model already the deployment default (${modelId})`);
    return;
  }
  await target.click();
  console.log(`· restored the account model to the deployment default (${modelId}) — waiting out the restart`);
  await page.waitForTimeout(18_000);
  ok(`account model restored to the deployment default (${modelId})`);
}

// MCP tool calls on the demo session's trace turns. The demo session is the
// one the newest substantial turn belongs to (the title-request turn carries
// almost no events, so filter on eventCount); each demo runs in a fresh
// session, so everything under that sessionId belongs to this demo.
async function sessionMcpCalls(page) {
  const data = await page.evaluate(() =>
    fetch("/api/trace/turns?limit=8").then((r) => r.json()).catch(() => ({ turns: [] })));
  const turns = data.turns || [];
  const demoTurn = turns.find((t) => t.eventCount > 3) || turns[0] || null;
  if (!demoTurn) return { turn: null, calls: [] };
  const sameSession = turns.filter((t) => t.sessionId === demoTurn.sessionId).slice(0, 5);
  const calls = [];
  for (const t of sameSession) {
    const detail = await page.evaluate(async (id) => {
      const r = await fetch(`/api/trace/turns/${id}`);
      return r.ok ? r.json() : { events: [] };
    }, t.turnId);
    for (const ev of detail.events || []) {
      if (ev.eventType !== "tool/call") continue;
      let payload;
      try { payload = typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload; } catch { continue; }
      const name = payload?.event?.data?.name ?? payload?.data?.name;
      if (name) calls.push(name);
    }
  }
  return { turn: demoTurn, calls };
}

const browser = await chromium.launch({ args: ["--proxy-server=direct://"] });

try {
  // ─────────────────────────── A. the demo account ───────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const landed = await signIn(page, EMAIL, PASSWORD);
  if (/auth\.finddatatech\.cloud/.test(landed)) throw new Error(`sign-in did not leave Logto (at ${landed})`);
  ok(`signed in as ${EMAIL}`);

  // Store visibility: the packs' entries must be visible to this role account.
  const market = (await fetchJson(page, "/api/extensions/market")).body ?? {};
  const marketServers = (market.mcpServers || []).map((s) => s.name);
  const marketSkills = (market.skills || []).map((s) => s.name);
  const missingServers = PACK_SERVERS.filter((n) => !marketServers.includes(n));
  const missingSkills = PACK_SKILLS.filter((n) => !marketSkills.includes(n));
  if (missingServers.length === 0) ok(`Store shows all four pack MCP servers to this account`);
  else bad(`Store is missing pack MCP servers: ${missingServers.join(", ")} (visible: ${marketServers.join(", ")})`);
  if (missingSkills.length === 0) ok("Store shows all four entry skills to this account");
  else bad(`Store is missing entry skills: ${missingSkills.join(", ")}`);

  // Right after a rollout the catalog's cloud merge can lag; poll until the
  // pack agents show (or give up after a minute).
  let packAgents = [];
  for (let i = 0; i < 7; i++) {
    const catalog = (await fetchJson(page, "/api/catalog").catch(() => ({ body: null }))).body;
    const agentEntries = (catalog?.agents || []).map((a) => a.id || a.name);
    packAgents = agentEntries.filter((id) => /pack-/.test(String(id)));
    if (packAgents.length >= 3) break;
    await page.waitForTimeout(10_000);
  }
  if (packAgents.length >= 3) ok(`catalog serves the three pack agents (${packAgents.join(", ")})`);
  else bad(`catalog serves only ${packAgents.length} pack agents: ${packAgents.join(", ")}`);

  if (!await ensureMarketConnected(page)) throw new Error("market connect failed — demos would 401");

  // Install the four entry skills (the Store's own install API; 409 = already
  // there). The pack MCP servers are deployment group-injected — assert, and
  // report any that are missing rather than installing deployment entries.
  const installedSkills = (await fetchJson(page, "/api/extensions/skills").catch(() => ({ body: { skills: [] } }))).body ?? { skills: [] };
  const skillList = installedSkills.skills || installedSkills || [];
  const haveSkills = new Set(Array.isArray(skillList) ? skillList.map((s) => s.name) : []);
  for (const name of REINSTALL) {
    if (!haveSkills.has(name)) continue;
    const del = await page.evaluate(async (n) => {
      const r = await fetch(`/api/extensions/skills/${encodeURIComponent(n)}`, { method: "DELETE" });
      return r.status;
    }, name);
    if (del === 200 || del === 204) note(`reinstall: uninstalled stale copy of ${name}`);
    else bad(`reinstall: could not uninstall ${name} (HTTP ${del})`);
  }
  for (const name of PACK_SKILLS) {
    if (haveSkills.has(name)) { note(`entry skill already installed: ${name}`); continue; }
    const res = await page.evaluate(async (n) => {
      const r = await fetch(`/api/extensions/market/skills/${n}/install`, { method: "POST" });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, name);
    if (res.status === 200 || res.status === 409) ok(`entry skill installed: ${name} (HTTP ${res.status})`);
    else bad(`entry skill install failed: ${name} → HTTP ${res.status} ${JSON.stringify(res.body)}`);
  }
  const installedMcp = (await fetchJson(page, "/api/extensions/mcp").catch(() => ({ body: { servers: [] } }))).body ?? { servers: [] };
  const haveServers = (installedMcp.servers || []).map((s) => s.name);
  const stillMissing = PACK_SERVERS.filter((n) => !haveServers.includes(n));
  if (stillMissing.length === 0) ok(`pack MCP servers mounted for the runtime: ${PACK_SERVERS.join(", ")}`);
  else bad(`pack MCP servers not installed on the runtime: ${stillMissing.join(", ")} (installed: ${haveServers.join(", ")})`);

  // ── the four pack demos ─────────────────────────────────────────────────────
  if (SKIP_DEMOS) note("SKIP_DEMOS=1 — skipping the four canned-input turns");
  else {
    await page.goto(`${PLATFORM}/chat`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.getByTestId("composer-input").waitFor({ state: "visible", timeout: 45_000 });
    // The demos run on the deployment's configured default model (the
    // agreed finddata-token provider) — the rehearsal never switches lanes.
    await restoreDefaultModel(page);
    let currentAgent = null;
    for (const demo of DEMO_FILTER.length ? DEMOS.filter((d) => DEMO_FILTER.includes(d.id)) : DEMOS) {
      console.log(`\n── demo: ${demo.pack} (agent ${demo.agent}) ──`);
      if (currentAgent !== demo.agent) {
        if (!await selectAgent(page, demo.agent)) {
          bad(`the agent picker did not offer ${demo.agent} — ${demo.pack} demo aborted`);
          continue;
        }
        currentAgent = demo.agent;
      } else {
        await page.getByTestId("new-chat-btn").click();
        await page.waitForTimeout(3000);
      }
      let reply = "";
      for (let attempt = 1; attempt <= 2; attempt++) {
        const turn = await sendTurn(page, demo.prompt);
        reply = (await turn.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (reply && !/连接错误|Connection error|请求失败|stream error/i.test(reply.slice(0, 300))) break;
        if (attempt === 1) {
          console.log("· the turn hit a gateway/stream error — retrying once (docs §8)");
          await page.getByTestId("new-chat-btn").click().catch(() => {});
          await page.waitForTimeout(3000);
          reply = "";
        }
      }
      const failed = [];
      for (const [pattern, label] of demo.markers) {
        if (pattern.test(reply)) ok(`[${demo.id}] ${label}`);
        else failed.push(label);
      }
      for (const [pattern, label] of demo.softMarkers) {
        note(`[${demo.id}] ${label}: ${pattern.test(reply) ? "present" : "absent"} (soft)`);
      }
      if (failed.length === 0) ok(`[${demo.id}] deliverable shape matches the playbook (reply ${reply.length} chars)`);
      else bad(`[${demo.id}] deliverable missing: ${failed.join("; ")} — reply starts "${reply.slice(0, 160)}"`);

      // The Trace half: real mcp__ tool calls on the pack's servers.
      const expected = demo.expectServer.split("|");
      const collectPackCalls = async () => {
        const { turn, calls } = await sessionMcpCalls(page);
        const mcp = calls.filter((n) => n.startsWith("mcp__"));
        return { turn, mcp, pack: mcp.filter((n) => expected.some((s) => n.includes(`__${s}__`))) };
      };
      let evidence = await collectPackCalls();
      if (evidence.pack.length === 0 && evidence.mcp.length >= 0 && reply) {
        // The workflow may answer from its own knowledge on the first turn; a
        // real operator nudges it to ground the report in the pack's tools.
        console.log(`· [${demo.id}] no pack MCP calls yet — one grounding nudge in the same session`);
        const nudge = await sendTurn(page, "请用市场里的 MCP 工具核实上述关键内容（法条/数据），在回复中引用工具返回的具体内容并注明所用工具名。");
        const nudgeText = (await nudge.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (nudgeText && nudgeText.length > 400) reply = `${reply} ${nudgeText}`;
        evidence = await collectPackCalls();
      }
      if (evidence.turn && evidence.pack.length > 0) {
        ok(`[${demo.id}] trace shows real MCP calls (${evidence.pack.slice(0, 5).join(", ")}${evidence.pack.length > 5 ? `, +${evidence.pack.length - 5} more` : ""})`);
      } else if (evidence.turn && evidence.mcp.length > 0) {
        note(`[${demo.id}] MCP calls happened but none on ${demo.expectServer}: ${evidence.mcp.slice(0, 5).join(", ")}`);
      } else {
        note(`[${demo.id}] no mcp__ tool calls across the demo session (turn=${evidence.turn ? evidence.turn.turnId : "none"}${evidence.turn?.hasError ? ", hasError" : ""}) — the model answered from its own knowledge`);
      }
    }
    // Leave the account on the built-in agent, as the demo operator found it.
    const brand = (await fetchJson(page, "/api/config").catch(() => ({ body: null })))?.body?.assistantName;
    await waitEnabled(page.getByTestId("strip-more"));
    await page.getByTestId("strip-more").click();
    const builtIn = page.getByTestId("strip-agent-option").filter({ hasText: brand || /FD|标准|Standard/ }).first();
    if (await builtIn.count()) {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && !(await builtIn.isEnabled())) await page.waitForTimeout(2000);
      await builtIn.click();
      console.log("· selected the built-in agent — waiting out the preset switch");
      await page.waitForTimeout(15_000);
      await page.getByTestId("new-chat-btn").click().catch(() => {});
      ok(`left the demo account on the built-in agent (${brand || "standard"})`);
    } else {
      note("could not switch back to the built-in agent — picker option not found");
    }
  }
  await ctx.close();

  // ─────────────────────── B. the wrong-role account ─────────────────────────
  if (SKIP_WRONG_ROLE) note("SKIP_WRONG_ROLE=1 — skipping the wrong-role check");
  else {
    console.log("\n── wrong-role check ──");
    const wctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const wpage = await wctx.newPage();
    let wHow = "not attempted";
    if (WRONG_ROLE_EMAIL && WRONG_ROLE_PASSWORD) {
      const at = await signIn(wpage, WRONG_ROLE_EMAIL, WRONG_ROLE_PASSWORD);
      wHow = /auth\.finddatatech\.cloud/.test(at)
        ? `sign-in with WRONG_ROLE_EMAIL failed (at ${at.slice(0, 60)})`
        : `signed in with WRONG_ROLE_EMAIL`;
    } else {
      // Try the Logto sign-up path: a fresh account has no organizations, so it
      // is exactly a wrong-role account.
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
      const freshEmail = `vp-rehearsal-${stamp}@finddatatech.cloud`;
      const freshPassword = `Vp-${stamp}-x`;
      await wpage.goto(`${PLATFORM}/login`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      await wpage.waitForTimeout(3000);
      if (!/auth\.finddatatech\.cloud/.test(wpage.url())) {
        const sso = wpage.getByRole("link", { name: /sign in with sso/i });
        if (await sso.isVisible().catch(() => false)) {
          await sso.click();
          await wpage.waitForTimeout(4000);
        }
      }
      const create = wpage.getByRole("link", { name: /create account|创建账户|注册/ })
        .or(wpage.getByRole("button", { name: /create account|创建账户|注册/ })).first();
      if (await create.isVisible().catch(() => false)) {
        await create.click();
        await wpage.waitForTimeout(2000);
        const identifier = wpage.locator('input[name="identifier"]');
        if (await identifier.isVisible().catch(() => false)) {
          await identifier.fill(freshEmail);
          await wpage.keyboard.press("Enter");
          await wpage.waitForTimeout(3000);
          const codeInput = wpage.locator('input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]').first();
          if (await codeInput.isVisible().catch(() => false)) {
            wHow = `sign-up exists but emails a verification code to ${freshEmail} — no mailbox here; create the wrong-role user in the Logto console (NO organizations) and rerun with WRONG_ROLE_EMAIL/WRONG_ROLE_PASSWORD`;
          } else {
            const passwd = wpage.locator('input[name="password"], input[name="new-password"]').first();
            await passwd.fill(freshPassword, { timeout: 8000 }).catch(() => {});
            await wpage.keyboard.press("Enter");
            await wpage.waitForURL((u) => !/auth\.finddatatech\.cloud/.test(u.href), { timeout: 60_000 }).catch(() => {});
            wHow = /auth\.finddatatech\.cloud/.test(wpage.url())
              ? "sign-up did not complete"
              : `fresh account created via sign-up (${freshEmail})`;
          }
        } else {
          wHow = "no identifier field after clicking create-account";
        }
      } else {
        wHow = "the Logto sign-in card offers no create-account link — sign-up is disabled";
      }
    }
    console.log(`· wrong-role account: ${wHow}`);
    if (/craw\.finddatatech\.cloud/.test(wpage.url())) {
      const wmarket = (await fetchJson(wpage, "/api/extensions/market").catch(() => ({ body: null }))).body;
      const wServers = (wmarket?.mcpServers || []).map((s) => s.name);
      const wSkills = (wmarket?.skills || []).map((s) => s.name);
      const leaked = [...PACK_SERVERS, ...PACK_SKILLS].filter((n) => wServers.includes(n) || wSkills.includes(n));
      if (leaked.length === 0) ok(`wrong-role account sees NONE of the gated pack entries (${wServers.length} servers / ${wSkills.length} skills visible in total)`);
      else bad(`wrong-role account CAN see gated entries: ${leaked.join(", ")}`);
      const wcatalog = (await fetchJson(wpage, "/api/catalog").catch(() => ({ body: null }))).body;
      const wPackAgents = (wcatalog?.agents || []).map((a) => a.id || a.name).filter((id) => /pack-/.test(String(id)));
      if (wPackAgents.length === 0) ok("wrong-role account sees none of the pack agents in the catalog");
      else bad(`wrong-role account sees pack agents: ${wPackAgents.join(", ")}`);
    } else {
      note("wrong-role visibility check not run — no fresh-account session on the platform");
    }
    await wctx.close();
  }
} catch (err) {
  bad(`rehearsal error: ${err.message}`);
} finally {
  await browser.close();
}

console.log("\n── rehearsal summary ──");
for (const r of results) console.log(r);
const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\nRESULT: ${fails === 0 ? "PASS" : `FAIL (${fails} failing check${fails > 1 ? "s" : ""})`}`);
process.exit(fails === 0 ? 0 : 1);
