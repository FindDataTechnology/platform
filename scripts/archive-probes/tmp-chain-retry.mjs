import { chromium } from "@playwright/test";
import fs from "node:fs";
const BASE = "https://platform.finddatatech.cloud";
const SESSION = fs.readFileSync("/tmp/wt-session.txt", "utf8").trim();
const results = [];
const check = (n, ok, note = "") => { results.push(`${ok ? "✓" : "✗"} ${n}${note ? ` — ${note}` : ""}`); if (!ok) process.exitCode = 1; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: { cookies: [{ name: "paas_session", value: SESSION, domain: "platform.finddatatech.cloud", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }] }, ignoreHTTPSErrors: true });
const p = await ctx.newPage();
try {
  const pool = await p.request.get(`${BASE}/api/blueprints`).then((r) => r.json());
  const id = pool.blueprints.find((b) => b.name === "走查钉库试跑-乙班")?.id ?? null;
  if (!id) throw new Error("乙班草稿不在池");
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/studio?from=blueprint`, { waitUntil: "domcontentloaded" });
  await p2.getByTestId("studio-blueprint-pool").waitFor({ timeout: 20000 });
  await p2.getByTestId("studio-blueprint-select").selectOption(id);
  // 重开后 verdict 清空——试跑钮 gated on 校验绿，先保存并校验
  await p2.getByTestId("studio-blueprint-save").click();
  await p2.locator('[data-testid="studio-blueprint-verdict"] text=校验通过').first().waitFor({ timeout: 40000 }).catch(() => {});
  await p2.getByTestId("studio-blueprint-trial").waitFor({ timeout: 30000 });
  await p2.getByTestId("studio-blueprint-trial").click();
  let report = null;
  for (let i = 0; i < 40; i++) {
    await p.waitForTimeout(15000);
    report = await p.request.get(`${BASE}/api/blueprints/${id}/trial-report`).then((r) => r.json()).then((d) => d.report ?? null).catch(() => null);
    if (report) break;
  }
  check("重试·试跑报告", !!report, report ? `green=${report.green}` : "10 分钟无报告");
  if (report?.green) {
    await p2.reload({ waitUntil: "domcontentloaded" });
    await p2.getByTestId("studio-blueprint-pool").waitFor({ timeout: 20000 });
    await p2.getByTestId("studio-blueprint-select").selectOption(id);
    await p2.getByTestId("studio-blueprint-save").click();
    await p2.getByTestId("studio-blueprint-trial").waitFor({ timeout: 40000 }).catch(() => {});
    const signBtn = p2.getByTestId("studio-blueprint-sign");
    if (await signBtn.isVisible({ timeout: 15000 }).catch(() => false)) {
      await signBtn.click();
      check("全链·签字", await p2.getByTestId("studio-blueprint-unsign").waitFor({ timeout: 30000 }).then(() => true).catch(() => false));
    } else {
      check("全链·签字（或已签）", await p2.getByTestId("studio-blueprint-unsign").isVisible({ timeout: 5000 }).catch(() => false), "sign 钮不在且 unsign 在=已签");
    }
    await p2.getByTestId("studio-blueprint-approve").click();
    const st = await p2.getByTestId("studio-blueprint-status").textContent({ timeout: 30000 }).catch(() => "");
    check("全链·批准→approved", (st || "").includes("approved"), st || "");
    await p2.getByTestId("studio-blueprint-cast").click();
    const castRef = await p2.getByTestId("studio-blueprint-cast-ref").textContent({ timeout: 30000 }).catch(() => "");
    const packId = (castRef || "").match(/pack ([A-Za-z0-9_-]+)/)?.[1] ?? null;
    check("全链·铸造→packId", !!packId, castRef || "no ref");
    if (packId) {
      const pack = await p2.request.get(`${BASE}/api/packs/${packId}`).then((r) => (r.ok ? r.json() : null));
      check("全链·市场实体 v1", !!pack && pack.version === 1, pack ? `${pack.name} v${pack.version}` : "404");
      const up = await p2.request.post(`${BASE}/api/packs/${packId}/unpublish`);
      check("收尾·unlist", up.ok(), `status=${up.status()}`);
      const gone = await p2.request.get(`${BASE}/api/packs/${packId}`).then((r) => r.json());
      check("收尾·浏览隐藏", gone.unlisted === true, `unlisted=${gone.unlisted}`);
      await p2.screenshot({ path: "/tmp/wt-shots/09-chain-cast.png" });
    }
  } else if (report) {
    check("试跑仍未判绿（如实记录）", false, JSON.stringify(report.assertions ?? []).slice(0, 260));
  }
} catch (err) {
  check("脚本异常", false, err.message.slice(0, 200));
} finally {
  await browser.close();
  console.log(results.join("\n"));
  fs.appendFileSync("/tmp/wt-shots/chain-results.txt", "\n--retry--\n" + results.join("\n"));
}
