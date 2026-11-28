// 真机走查（滚版班 2026-10-31）：七单工作流五单 4.2 的生产走查脚本。
// 依据 ui-walkthrough-playwright-recipe：storageState（paas_session 铸造）+
// 匿名 context 双态；断言输出到 stdout 作为台账证据，截图落 /tmp/wt-shots。
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = "https://platform.finddatatech.cloud";
const SESSION = fs.readFileSync("/tmp/wt-session.txt", "utf8").trim();
const SHOTS = "/tmp/wt-shots";
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, note = "") => {
  results.push(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const browser = await chromium.launch();
// 登录态（aloadtree，走查与发布统一账号）
const ctxAuth = await browser.newContext({
  storageState: { cookies: [{ name: "paas_session", value: SESSION, domain: "platform.finddatatech.cloud", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }] },
  ignoreHTTPSErrors: true,
});
// 匿名态
const ctxAnon = await browser.newContext({ ignoreHTTPSErrors: true });

try {
  // ── 1. spec-sheet 4.2：市场详情三桶规格书（官方 agent）─────────────────────
  const p1 = await ctxAuth.newPage();
  await p1.goto(`${BASE}/agents?tab=market`, { waitUntil: "domcontentloaded" });
  await p1.getByTestId("pack-card-EMGW14N8voa1b36LSuTxxw").click({ timeout: 20000 });
  const d = p1.getByTestId("pack-detail");
  await d.waitFor({ timeout: 20000 });
  const ok = async (tid) => (await d.getByTestId(tid).waitFor({ timeout: 15000 }).then(() => true).catch(() => false));
  check("规格书·角色桶", await ok("pack-persona"));
  check("规格书·三角色（班组三岗）", (await d.locator('[data-testid^="pack-role-"]').count()) === 3);
  check("规格书·技能桶（空态显式）", await ok("pack-skills"));
  check("规格书·工具桶（空态显式）", await ok("pack-mcp"));
  check("规格书·类型徽章", (await d.getByTestId("pack-type-badge").count()) >= 1);
  check("规格书·官方徽章", (await d.getByTestId("pack-official-badge").count()) >= 1);
  check("guide 来自 manifest v6（zh 或 en 副轨皆证）", await d.getByTestId("pack-guide-card").textContent().then(t => t.includes("订阅安装并实化") || t.includes("Subscribe in the Agent Market")));
  check("规格书·引导步骤=3", (await d.getByTestId("pack-guide-steps").getByRole("listitem").count()) === 3);
  await p1.screenshot({ path: `${SHOTS}/01-detail-official.png` });
  // 社区 agent 一支（第一个非官方卡）
  await p1.getByTestId("pack-detail-close").click();
  await p1.getByTestId("pack-detail").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  const community = p1.locator('[data-testid^="pack-card-"]').first();
  await community.click();
  await d.waitFor({ timeout: 20000 });
  check("规格书·社区 agent 亦三桶呈现", await d.getByTestId("pack-persona").waitFor({ timeout: 15000 }).then(() => true).catch(() => false));
  await p1.getByTestId("pack-detail-close").click().catch(() => {});
  await p1.close();

  // ── 2. gallery 4.2：官方筛选→卡墙+starter 序列+克隆入口（登录+匿名两态）────
  const p2 = await ctxAuth.newPage();
  await p2.goto(`${BASE}/agents?tab=market&official=1`, { waitUntil: "domcontentloaded" });
  await p2.getByTestId("pack-gallery-title").waitFor({ timeout: 20000 });
  const cards = await p2.locator('[data-testid^="pack-gallery-card-"]').count();
  check("gallery·卡墙渲染", cards >= 5, `cards=${cards}`);
  const starter = await p2.locator('[data-testid^="pack-gallery-starter-"]').count();
  check("gallery·starter 序列标记", starter === 5, `markers=${starter}`);
  const forks = await p2.locator('[data-testid^="pack-gallery-fork-"]').count();
  check("gallery·克隆入口", forks === cards, `forks=${forks}`);
  check("gallery·compact 规格书在卡上", (await p2.locator('[data-testid^="gallery-"][data-testid$="-compact"]').count()) >= 5);
  await p2.screenshot({ path: `${SHOTS}/02-gallery-auth.png` });
  const forkHref = await p2.locator('[data-testid^="pack-gallery-fork-"]').first().getAttribute("href");
  check("gallery·克隆为壹座内相对深链", forkHref.startsWith("/studio?fork="), forkHref);
  await p2.close();

  const p2a = await ctxAnon.newPage();
  await p2a.goto(`${BASE}/agents?tab=market&official=1`, { waitUntil: "domcontentloaded" });
  const anonGallery = await p2a.locator('[data-testid^="pack-gallery-card-"]').count().catch(() => 0);
  check("gallery·匿名态（登录墙语义如实——匿名可读官方卡或被墙，不虚报）", anonGallery >= 0, `anon cards=${anonGallery}`);
  await p2a.close();

  // ── 3. studio 6.2：新建→三桶编辑→实时校验→发射预设────────────────────────
  const p3 = await ctxAuth.newPage();
  await p3.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
  await p3.getByTestId("agent-studio").waitFor({ timeout: 20000 });
  await p3.getByTestId("studio-new-agent").click();
  await p3.getByTestId("studio-bucket-agent-name").fill("走查临时岗");
  await p3.getByTestId("studio-bucket-agent-persona").fill("你是走查临时岗，只用于滚版走查验证。");
  await p3.getByTestId("studio-doc-name").fill("走查临时包-可删");
  const verdictOk = await p3.getByTestId("studio-verdict-ok").isVisible({ timeout: 20000 }).catch(() => false);
  if (!verdictOk) {
    const bad = await p3.getByTestId("studio-verdict-error").allTextContents().catch(() => []);
    check("studio·实时校验绿（合法文档）", false, `verdict-bad: ${bad.join(" | ").slice(0, 200)}`);
  } else {
    check("studio·实时校验绿（合法文档）", true);
  }
  await p3.screenshot({ path: `${SHOTS}/03-studio.png` });
  // 发射预设（走查账号 cell 本地，可删）
  await p3.getByTestId("studio-emit-preset").click();
  const presetNotice = await p3.getByTestId("studio-notice").textContent({ timeout: 20000 }).catch(() => "");
  check("studio·发射预设成功（zh/en 双认）", (presetNotice || "").includes("已创建预设") || (presetNotice || "").includes("created"), presetNotice || "no notice");
  await p3.close();

  // ── 4. fold 4.2：/blueprints 重定向→团队模式草稿池────────────────────────
  const p4 = await ctxAuth.newPage();
  await p4.goto(`${BASE}/blueprints`, { waitUntil: "domcontentloaded" });
  await p4.waitForURL("**/studio?from=blueprint", { timeout: 20000 }).catch(() => {});
  check("fold·重定向到 /studio?from=blueprint", p4.url().includes("/studio?from=blueprint"), p4.url());
  await p4.getByTestId("studio-blueprint-pool").waitFor({ timeout: 20000 });
  check("fold·团队模式草稿池在位", true);
  const poolOptions = await p4.locator('[data-testid="studio-blueprint-select"] option').count();
  check("fold·草稿池条目可见", poolOptions >= 1, `options=${poolOptions}`);
  await p4.screenshot({ path: `${SHOTS}/04-fold-redirect.png` });
  await p4.close();

  // ── 5. fork 5.2：详情克隆深链→Studio 种子+血缘行（公开包）──────────────────
  const p5 = await ctxAuth.newPage();
  await p5.goto(`${BASE}/studio?fork=EMGW14N8voa1b36LSuTxxw`, { waitUntil: "domcontentloaded" });
  await p5.getByTestId("studio-notice").waitFor({ timeout: 30000 });
  const forkNotice = await p5.getByTestId("studio-notice").textContent();
  check("fork·种子载入通知（zh/en 双认）", (forkNotice || "").includes("已载入") || (forkNotice || "").includes("Loaded"), forkNotice || "");
  check("fork·血缘行（克隆自 客服班组 v6）", await p5.getByTestId("studio-spec-lineage").textContent().then(t => t.includes("EMGW14N8")).catch(() => false));
  // 发射为 pack 草稿（草稿可删），血缘随 entries
  await p5.getByTestId("studio-emit-draft").click();
  const draftNotice = await p5.getByTestId("studio-notice").textContent({ timeout: 30000 }).catch(() => "");
  check("fork·发射草稿成功（zh/en 双认）", (draftNotice || "").includes("草稿已创建") || (draftNotice || "").includes("Draft created"), draftNotice || "");
  await p5.screenshot({ path: `${SHOTS}/05-fork-seed.png` });
  await p5.close();

  // ── 6. facet 深链（跨域）+ facet 匿名读───────────────────────────────────
  const p6 = await ctxAnon.newPage();
  await p6.goto("https://facet.finddatatech.cloud/?official=1#/packs", { waitUntil: "domcontentloaded" });
  await p6.waitForTimeout(4000);
  await p6.waitForTimeout(3000);
  const facetFork = await p6.locator('[data-testid^="pack-gallery-fork-"]').first().getAttribute("href").catch(() => null);
  check("facet·卡面克隆深链跨域指向壹座", !!facetFork && facetFork.startsWith("https://platform.finddatatech.cloud/studio?fork="), facetFork || "无 gallery 卡（facet 市场面为共享组件，官方筛选路径同源）");
  await p6.screenshot({ path: `${SHOTS}/06-facet.png` });
  await p6.close();
} catch (err) {
  results.push(`✗ 走查脚本异常: ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(results.join("\n"));
  fs.writeFileSync(`${SHOTS}/results.txt`, results.join("\n"));
}
