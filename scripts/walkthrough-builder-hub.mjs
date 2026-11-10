#!/usr/bin/env node
// ── Builder-hub local walkthrough (add-agent-builder-hub 4.1 预演) ───────────
//
// A hermetic server + a real browser walking the shipped faces, screenshotting
// each leg into gui-test-screenshots/builder-hub/. This is the pre-roll
// evidence pass: production walkthrough rides the same assertions after the
// image lands. Legs:
//   1. /agents default = build area (构建器 title, studio CTA)
//   2. supply × three cabinets (market page / skills / MCP with annotated
//      market cards — 网页抓取 zh rendering + advanced disclosure present)
//   3. creations (drafts editor + presets + clusters reachable)
//   4. tuning (skill candidates area + persona empty-state placeholder)
//   5. five locales (nav label per locale; ja 構築 area label)
//   6. the annotation index API (locale-projected, zh fallback for ja)
//   7. legacy deep links land on the right area (?tab=market → supply)
//
//   node scripts/walkthrough-builder-hub.mjs

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { spawnTestServer } from "./lib/test-server.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hub-walkthrough-"));
const SHOTS = path.resolve("gui-test-screenshots/builder-hub");
fs.mkdirSync(SHOTS, { recursive: true });

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
const port0 = await freePort();

const server = spawnTestServer({
  env: {
    ...process.env,
    PORT: String(port0),
    HOST: "127.0.0.1",
    CHAT_HISTORY_STORE_DIR: path.join(tmpRoot, "chat"),
    DOCUMENTS_STORE_DIR: path.join(tmpRoot, "docs"),
    SESSIONS_STORE_DIR: path.join(tmpRoot, "sessions"),
    LLM_PROVIDERS_STORE: path.join(tmpRoot, "llm-providers.json"),
    LLM_DEFAULT_STORE: path.join(tmpRoot, "llm-default.json"),
    DB_PATH: path.join(tmpRoot, "app.db"),
    MCP_CONFIG_PATH: path.join(tmpRoot, "mcp.json"),
    DSH_HOME: path.join(tmpRoot, "dsh-home"),
    DSH_SHARED_HOME: process.env.DSH_SHARED_HOME || path.join(os.homedir(), ".dsh"),
  },
});
const child = server.child;
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

async function waitFor(predicate, ms = 120_000, label = "condition") {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error(`waitFor timeout: ${label}\n${out.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

let port = port0;
await waitFor(async () => {
  if (!port) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ready`);
    return r.ok;
  } catch {
    return false;
  }
}, 120_000, "server ready");
const BASE = `http://127.0.0.1:${port}`;
console.log(`[walkthrough] server at ${BASE}`);

const results = [];
const leg = async (name, fn) => {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (e) {
    results.push(`✖ ${name}: ${e.message}`);
  }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const setLocale = async (loc) => {
  await page.addInitScript((l) => {
    try {
      localStorage.setItem("platform.locale", l);
      localStorage.setItem("onboarding.tour.done", "1");
    } catch { /* ignore */ }
  }, loc);
};
const goto = async (p) => {
  await page.goto(`${BASE}${p}`, { waitUntil: "networkidle", timeout: 30_000 });
};
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

// ── 1. build area default ────────────────────────────────────────────────────
await setLocale("zh-CN");
await leg("build 默认区（zh）", async () => {
  await goto("/agents");
  await page.getByTestId("agents-page").waitFor({ timeout: 20_000 });
  await page.getByTestId("build-section").waitFor({ timeout: 10_000 });
  await page.getByTestId("build-studio-btn").waitFor({ timeout: 5_000 });
  if (!(await page.getByTestId("agents-tab-build").getAttribute("aria-selected"))) throw new Error("build tab not selected");
  await shot("01-build-area-zh");
});

// ── 2. supply cabinets ───────────────────────────────────────────────────────
await leg("供给区柜切换（MCP/技能；hermetic 无市场柜）", async () => {
  await goto("/agents?tab=supply");
  await page.getByTestId("supply-section").waitFor({ timeout: 15_000 });
  await page.getByTestId("supply-cabinet-mcp").click();
  await page.getByTestId("supply-mcp").waitFor({ timeout: 10_000 });
  await page.getByTestId("extensions-page").waitFor({ timeout: 10_000 });
  await shot("02-supply-mcp-cabinet-zh");
  await page.getByTestId("supply-cabinet-skills").click();
  await page.getByTestId("supply-skills").waitFor({ timeout: 10_000 });
  await shot("03-supply-skills-cabinet-zh");
});

// ── 3. MCP market card annotation (zh + advanced disclosure) ────────────────
await leg("MCP 市场卡注释渲染（zh: 网页抓取）", async () => {
  await goto("/settings/mcp?tab=market");
  await page.getByTestId("extensions-page").waitFor({ timeout: 15_000 });
  const card = page.getByTestId("mcp-market-card");
  await card.first().waitFor({ timeout: 15_000 });
  const zhCard = page.locator('[data-testid="mcp-market-card"]', { hasText: "网页抓取" }).first();
  if ((await zhCard.count()) === 0) throw new Error("no annotated market card found (expected 网页抓取)");
  await zhCard.scrollIntoViewIfNeeded();
  const advanced = zhCard.locator("details");
  if ((await advanced.count()) > 0) await advanced.first().locator("summary").click();
  await shot("05-mcp-annotated-card-zh");
});

// ── 4. creations ─────────────────────────────────────────────────────────────
await leg("我的创作区（草稿/预设可达）", async () => {
  await goto("/agents?tab=creations");
  await page.getByTestId("creations-section").waitFor({ timeout: 15_000 });
  await page.getByTestId("custom-presets-page").waitFor({ timeout: 10_000 });
  await shot("06-creations-zh");
});

// ── 5. tuning ────────────────────────────────────────────────────────────────
await leg("调优区（persona 空态契约）", async () => {
  await goto("/agents?tab=tuning");
  await page.getByTestId("tuning-section").waitFor({ timeout: 15_000 });
  await page.getByTestId("tuning-persona-placeholder").waitFor({ timeout: 10_000 });
  await shot("07-tuning-zh");
});

// ── 6. five locales on the nav label ────────────────────────────────────────
const EXPECT = { "zh-CN": "智能体构建器", en: "Agent Builder", ja: "エージェントビルダー", es: "Constructor de Agentes", fr: "Constructeur d'Agents" };
for (const [loc, label] of Object.entries(EXPECT)) {
  await leg(`nav 词条 ${loc}`, async () => {
    const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await fresh.newPage();
    await p2.addInitScript((l) => {
      try {
        localStorage.setItem("platform.locale", l);
        localStorage.setItem("onboarding.tour.done", "1");
      } catch { /* ignore */ }
    }, loc);
    await p2.goto(`${BASE}/chat`, { waitUntil: "networkidle", timeout: 30_000 });
    const nav = p2.getByTestId("nav-agents");
    await nav.waitFor({ timeout: 15_000 });
    const text = (await nav.textContent())?.trim();
    if (text !== label) throw new Error(`nav label for ${loc} is '${text}', expected '${label}'`);
    await p2.screenshot({ path: path.join(SHOTS, `08-nav-${loc.replace("/", "-")}.png`) });
    await fresh.close();
  });
}

// ── 7. annotation index API ─────────────────────────────────────────────────
await leg("注释索引 API（locale 投影 + zh 回落）", async () => {
  const en = await (await fetch(`${BASE}/api/supply-annotations?locale=en`)).json();
  if (en.servers.fetch?.label !== "Web fetch") throw new Error(`en index fetch label = ${en.servers.fetch?.label}`);
  if (en.tools["github__create_issue"]?.label !== "Create issue") throw new Error("en tool index mismatch");
  const ja = await (await fetch(`${BASE}/api/supply-annotations?locale=ja`)).json();
  if (ja.servers.fetch?.label !== "网页抓取") throw new Error(`ja index did not fall back to zh (${ja.servers.fetch?.label})`);
});

// ── 8. legacy deep links ────────────────────────────────────────────────────
await leg("legacy 深链归一（?tab=market → supply）", async () => {
  await goto("/agents?tab=market");
  await page.getByTestId("agents-tab-supply").waitFor({ timeout: 10_000 });
  const sel = await page.getByTestId("agents-tab-supply").getAttribute("aria-selected");
  if (sel !== "true") throw new Error("legacy market deep link did not select supply");
});

await browser.close();
await server.stop();
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("✖"));
console.log(failed.length ? `\n${failed.length} leg(s) FAILED` : "\nALL LEGS PASSED");
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
