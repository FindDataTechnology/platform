// plaza real-browser acceptance (add-agent-materials-plaza v2): tab clicks,
// three-domain doors, five-locale rendering + screenshots (task 4.1 evidence).
// Run BY PATH:  node scripts/test-plaza-browser.mjs   (uses the repo's playwright)
//
// NOT a unit test. docs/registry-maintenance.md §9 commits to the same thing
// ("playwright 依赖，不入 unit 冒烟"), yet the file name matches the unit lane's
// `scripts/test-*.mjs` glob, so `npm run test:unit` used to spawn it: 20s of
// live network plus assertions pinned to the catalog counts of one day
// (75/197/13). The afternoon the supply catalog grew, that turned the whole unit
// lane red for a reason unrelated to any code — a gate nobody can trust. Hence
// the guard below: under the runner this script reports why it does not apply
// and exits clean; run it by path for the real acceptance.

import { chromium } from "playwright";
import fs from "node:fs";

// node --test runs every test file in a child with NODE_TEST_CONTEXT set.
if (process.env.NODE_TEST_CONTEXT) {
  console.log("SKIP: live browser acceptance — run it by path (node scripts/test-plaza-browser.mjs), not under `node --test`");
  process.exit(0);
}

const BASE = "https://agent.finddatatech.cloud";
const SHOT = "/tmp/plaza-shots";
fs.mkdirSync(SHOT, { recursive: true });
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
page.on("pageerror", (e) => { console.log("✗ pageerror:", e.message); failures += 1; });

// ── 1. hero counts + tab clicks on agent. ──
await page.goto(`${BASE}/?lang=zh-CN`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const hero = await page.locator("#counters").innerText();
ok(/75/.test(hero) && /197/.test(hero) && /13/.test(hero) && /649/.test(hero), `hero four counts (75/197/13/649): ${hero.replace(/\n/g, " ")}`);

const cardCount = async () => page.locator("#invGrid article.inv-card").count();
const allN = await cardCount();
ok(allN >= 280, `全部 tab shows ${allN} cards (≥285 expected)`);

await page.getByRole("button", { name: "智能体", exact: true }).click();
await page.waitForTimeout(300);
const agentsN = await cardCount();
ok(agentsN === 75, `智能体 tab: ${agentsN} cards (75)`);

await page.getByRole("button", { name: "技能", exact: true }).click();
await page.waitForTimeout(300);
const skillsN = await cardCount();
ok(skillsN === 197, `技能 tab: ${skillsN} cards (197) — THE reported failure`);

await page.getByRole("button", { name: "MCP 服务", exact: true }).click();
await page.waitForTimeout(300);
const mcpN = await cardCount();
ok(mcpN === 13, `MCP 服务 tab: ${mcpN} cards (13)`);

const badgeOnMcp = await page.locator("#invGrid article.inv-card").first().innerText();
ok(/MCP/.test(badgeOnMcp), "mcp tab first card carries the MCP species badge");

await page.screenshot({ path: `${SHOT}/agent-tabs-mcp.png`, fullPage: false });

// search within a tab
await page.getByRole("button", { name: "技能", exact: true }).click();
await page.locator("#invSearch").fill("合同");
await page.waitForTimeout(300);
const searchN = await cardCount();
ok(searchN >= 1 && searchN < 197, `search within skills tab narrows: ${searchN}`);
await page.locator("#invSearch").fill("");

// ── 2. three-domain doors ──
await page.goto("https://skills.finddatatech.cloud/", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const skillsActive = await page.locator(".inv-tab.active").getAttribute("data-tab");
ok(skillsActive === "skills", `skills. door preselects the skills tab (active=${skillsActive})`);
await page.screenshot({ path: `${SHOT}/skills-door.png` });

await page.goto("https://mcp.finddatatech.cloud/", { waitUntil: "load" });
const mcpUrl = page.url();
ok(/agent\.finddatatech\.cloud\/\?species=mcp/.test(mcpUrl), `mcp. anonymous root redirects → ${mcpUrl}`);
await page.waitForTimeout(1200);
const mcpActive = await page.locator(".inv-tab.active").getAttribute("data-tab");
ok(mcpActive === "mcp", `mcp. door preselects the MCP tab (active=${mcpActive})`);
const mcpCards = await cardCount();
ok(mcpCards === 13, `mcp. door gallery: ${mcpCards} cards (13)`);
await page.screenshot({ path: `${SHOT}/mcp-door.png` });

// ── 3. five-locale rendering + screenshots (task 4.1 evidence) ──
const expectBrand = {
  "zh-CN": "壹座·智能体素材广场",
  en: "Yizuo Agent Materials Plaza",
  es: "Plaza de Materiales",
  fr: "Place des Matériaux",
  ja: "素材広場",
};
const expectTabs = { "zh-CN": "技能", en: "Skills", es: "Habilidades", fr: "Compétences", ja: "スキル" };
for (const loc of ["zh-CN", "en", "es", "fr", "ja"]) {
  await page.goto(`${BASE}/?lang=${loc}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const brand = await page.locator(".brand-name").first().innerText();
  ok(brand.includes(expectBrand[loc]), `${loc} brand reads: ${brand}`);
  const tabText = await page.locator('[data-tab="skills"]').innerText();
  ok(tabText === expectTabs[loc], `${loc} skills tab label: ${tabText}`);
  // mobile width pass on zh and en only (two-client evidence)
  if (loc === "zh-CN" || loc === "en") {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT}/locale-${loc}-mobile.png`, fullPage: false });
    await page.setViewportSize({ width: 1366, height: 900 });
  }
  await page.screenshot({ path: `${SHOT}/locale-${loc}.png`, fullPage: false });
}

await browser.close();
console.log(failures === 0 ? "\nALL BROWSER CHECKS PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
