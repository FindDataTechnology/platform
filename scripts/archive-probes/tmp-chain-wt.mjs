// 全链走查（fold 4.2 终章）：Studio 团队模式驱动 蓝图创建→编辑→校验→试跑→签字→批准→铸造。
// 种子内容=池内已验证可铸造的「走查钉库试跑」（cast v3），改名 -乙班 避同名 409。
// 产物：铸造 pack 走查钉库试跑-乙班 v1 → 走查后 unlist 下架（市场隐藏，版本不可变留存）。
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = "https://platform.finddatatech.cloud";
const SESSION = fs.readFileSync("/tmp/wt-session.txt", "utf8").trim();
const results = [];
const check = (name, ok, note = "") => {
  results.push(`${ok ? "✓" : "✗"} ${name}${note ? ` — ${note}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const cookie = { name: "paas_session", value: SESSION, domain: "platform.finddatatech.cloud", path: "/", httpOnly: true, secure: true, sameSite: "Lax" };

const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: { cookies: [cookie] }, ignoreHTTPSErrors: true });
const p = await ctx.newPage();
try {
  // 读种子内容（API 与 Studio 同源）
  const seed = await p.request.get(`${BASE}/api/blueprints`).then((r) => r.json());
  const src = seed.blueprints.find((b) => b.name === "走查钉库试跑");
  if (!src) throw new Error("种子蓝图不在池");
  const detail = await p.request.get(`${BASE}/api/blueprints/${src.id}`).then((r) => r.json());
  const content = detail.blueprint.content;
  const renamed = JSON.parse(JSON.stringify(content));
  renamed.boundary = { ...(renamed.boundary ?? {}), name: "走查钉库试跑-乙班" };
  if (renamed.fleet?.name) renamed.fleet.name = "走查钉库试跑-乙班";

  await p.goto(`${BASE}/studio?from=blueprint`, { waitUntil: "domcontentloaded" });
  await p.getByTestId("studio-blueprint-pool").waitFor({ timeout: 20000 });

  // 新建 → JSON 轨灌入改名内容 → 应用 → 保存并校验
  await p.getByTestId("studio-blueprint-new").click();
  await p.getByTestId("studio-blueprint-track-json").click();
  await p.getByTestId("studio-blueprint-json").fill(JSON.stringify(renamed, null, 2));
  await p.getByTestId("studio-blueprint-json-apply").click();
  await p.getByTestId("studio-blueprint-save").click();
  const verdictOk = await p.locator('[data-testid="studio-blueprint-verdict"] .text-emerald-600, [data-testid="studio-blueprint-side"] >> text=校验通过').first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  check("全链·保存并校验绿", verdictOk);
  await p.screenshot({ path: "/tmp/wt-shots/07-chain-validated.png" });

  // 管线序：批准（校验绿即可）→ 铸造 → 试跑（铸造产物上验收）→ 签字
  await p.getByTestId("studio-blueprint-approve").click();
  const stA = await p.getByTestId("studio-blueprint-status").textContent({ timeout: 30000 }).catch(() => "");
  check("全链·批准→approved", (stA || "").includes("approved"), stA || "");
  await p.getByTestId("studio-blueprint-cast").click();
  const castRefEarly = await p.getByTestId("studio-blueprint-cast-ref").textContent({ timeout: 30000 }).catch(() => "");
  check("全链·铸造→packId", !!(castRefEarly || "").match(/pack [A-Za-z0-9_-]+/), castRefEarly || "no ref");
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.getByTestId("studio-blueprint-pool").waitFor({ timeout: 20000 });
  const cid = await p.request.get(`${BASE}/api/blueprints`).then((r) => r.json()).then((d) => d.blueprints.find((b) => b.name === "走查钉库试跑-乙班")?.id);
  await p.getByTestId("studio-blueprint-select").selectOption(cid);
  await p.getByTestId("studio-blueprint-trial").waitFor({ timeout: 30000 });
  await p.getByTestId("studio-blueprint-trial").click();
  let report = null;
  for (let i = 0; i < 40; i++) {
    await p.waitForTimeout(15000);
    report = await p.evaluate(async (url) => {
      const r = await fetch(url);
      const d = await r.json();
      return d.report ?? null;
    }, `${BASE}/api/blueprints/${detail.blueprint.id}/trial-report`).catch(() => null);
    // 注意：上面 fetch 的是打开中的草稿 id（新建后 detail.blueprint.id 已是当前草稿）
    if (report) break;
  }
  // 报告以 UI 内刷新为准（拿当前草稿 id）
  const currentId = await p.evaluate(async () => (await (await fetch("/api/blueprints")).json()).blueprints.find((b) => b.name === "走查钉库试跑-乙班")?.id ?? null);
  for (let i = 0; i < 20 && !report; i++) {
    await p.waitForTimeout(15000);
    report = await p.evaluate(async (url) => (await (await fetch(url)).json()).report ?? null, `${BASE}/api/blueprints/${currentId}/trial-report`).catch(() => null);
  }
  check("全链·试跑报告落账", !!report, report ? `green=${report.green} assertions=${(report.assertions ?? []).length}` : "10 分钟无报告");
  if (report) check("全链·试跑判绿", report.green === true, JSON.stringify(report.assertions ?? []).slice(0, 200));

  // 签字（双钥匙终审）→ 批准 → 铸造
  if (report && report.green) {
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.getByTestId("studio-blueprint-pool").waitFor({ timeout: 20000 });
    await p.getByTestId("studio-blueprint-select").selectOption({ label: /乙班/.source ? undefined : undefined }).catch(() => {});
    // selectOption by value：直接用 id
    await p.getByTestId("studio-blueprint-select").selectOption(currentId).catch(async () => {
      await p.getByTestId("studio-blueprint-select").evaluate((el, id) => {
        el.value = id;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, currentId);
    });
    await p.getByTestId("studio-blueprint-trial").waitFor({ timeout: 20000 }).catch(() => {});
    // 打开草稿后按钮组出现（签字在报告在位时显示）
    const signBtn = p.getByTestId("studio-blueprint-sign");
    if (await signBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
      await signBtn.click();
      await p.getByTestId("studio-blueprint-unsign").waitFor({ timeout: 30000 }).catch(() => {});
      check("全链·签字（撤签钮出现=签上）", await p.getByTestId("studio-blueprint-unsign").isVisible().catch(() => false));
    } else {
      check("全链·签字", false, "签字钮未出现（报告未在位或已签）");
    }
    await p.getByTestId("studio-blueprint-approve").click();
    await p.getByTestId("studio-blueprint-status").textContent().then((t) => check("全链·批准→approved", (t || "").includes("approved"), t || ""));
    await p.screenshot({ path: "/tmp/wt-shots/08-chain-approved.png" });
    await p.getByTestId("studio-blueprint-cast").click();
    const castRef = await p.getByTestId("studio-blueprint-cast-ref").textContent({ timeout: 30000 }).catch(() => "");
    const packId = (castRef || "").match(/pack ([A-Za-z0-9_-]+)/)?.[1] ?? null;
    check("全链·铸造→packId", !!packId, castRef || "no ref");
    if (packId) {
      const pack = await p.request.get(`${BASE}/api/packs/${packId}`).then((r) => (r.ok ? r.json() : null));
      check("全链·市场实体可读（v1）", !!pack && pack.version === 1, pack ? `${pack.name} v${pack.version} official=${pack.official}` : "404");
      await p.screenshot({ path: "/tmp/wt-shots/09-chain-cast.png" });
      // 收尾：unlist（下架=浏览隐藏；版本不可变留存）
      const up = await p.request.post(`${BASE}/api/packs/${packId}/unpublish`);
      check("收尾·unlist 下架", up.ok(), `status=${up.status()}`);
      const gone = await p.request.get(`${BASE}/api/packs/${packId}`).then((r) => r.json());
      check("收尾·市场浏览已隐藏", gone.unlisted === true, `unlisted=${gone.unlisted}`);
    }
  }
} catch (err) {
  check("全链脚本异常", false, err.message.slice(0, 200));
} finally {
  await browser.close();
  console.log(results.join("\n"));
  fs.writeFileSync("/tmp/wt-shots/chain-results.txt", results.join("\n"));
}
