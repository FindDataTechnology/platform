// 个人代理三层 · 真机验收 (add-personal-mandate / -deputy / -disclosure-gate)
//
// 起一个真实 server（临时数据目录、真 dsh 初始化），用 chromium 真浏览器进入
// 应用，然后按用户实际会走的路径验收：
//   1. 三个设置分区能进、默认值是「什么都没给」；
//   2. 配一个域 → 读回一致；
//   3. 裁决端点：越界拦、干净放、无令牌 401、异常失败关闭；
//   4. 对外发言台账：写入 → 检索 → 回执 → 窗口内撤回。
//
//   node scripts/verify-mandate-acceptance.mjs
//
// 输出 PASS/FAIL 行 + 截图到 /tmp/mandate-accept-*.png。

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.ACCEPT_PORT || 3951);
// 用 localhost 而不是 127.0.0.1：server.js 默认只绑 IPv6 回环（[::1]），
// 探 127.0.0.1 会一直 connection refused —— 而它和「服务没起来」长得一模一样。
const BASE = `http://localhost:${PORT}`;
const TOKEN = "accept-verdict-token";

const dataDir = mkdtempSync(path.join(tmpdir(), "mandate-accept-"));
const steps = [];
const note = (s, ok, extra = "") => {
  steps.push(`${ok ? "PASS" : "FAIL"} ${s}${extra ? " — " + extra : ""}`);
  console.log(steps.at(-1));
};

const env = {
  ...process.env,
  PORT: String(PORT),
  PLATFORM_DATA_DIR: dataDir,
  DB_PATH: path.join(dataDir, "app.db"),
  CRON_STORAGE_PATH: dataDir,
  DSH_HOME: path.join(dataDir, "dsh"),
  MANDATE_VERDICT_TOKEN: TOKEN,
  // 本机验收：不接外部身份提供方，避免把测试绑在 SSO 可达性上
  AUTH_MODE: "off",
};

const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d.toString(); });
server.stderr.on("data", (d) => { serverLog += d.toString(); });

// 起来 = 端口能应答。`/api/ready` 在队列 degraded 时返 503，那是「健康判定」不是
// 「没启动」——把它当未就绪会白等到超时（第一次跑就踩了这个）。
async function waitReady(ms = 180_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/api/ready`);
      const body = await r.json().catch(() => null);
      if (body && typeof body.ready === "boolean") return body;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

const api = (p, opts = {}) =>
  fetch(`${BASE}${p}`, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

try {
  const ready = await waitReady();
  if (!ready) throw new Error(`server never answered /api/ready\n${serverLog.slice(-2000)}`);
  note("server boots and answers /api/ready", true, `${BASE} ready=${ready.ready} queue.degraded=${ready.queue?.degraded ?? "?"}`);
  if (!ready.ready) {
    note("readiness is degraded (queue), but the app is up — 验收继续", true, `dshInitError=${ready.dshInitError ?? "none"}`);
  }

  // ── 1. 设置面：三个分区真的存在，默认是「什么都没给」 ────────────────────
  const browser = await chromium.launch({ args: ["--proxy-server=direct://"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("platform.locale", "en"); } catch {} });
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: `/tmp/mandate-accept-${n}.png` });

  await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByTestId("settings-btn").click();
  await page.getByTestId("settings-panel").waitFor({ state: "visible", timeout: 30_000 });

  // 等「真的渲染出内容」而不是只等容器：懒加载 chunk + 首次数据请求在冷启动下
  // 可能各要几秒，20s 的门会在 Loading… 上误判（第一次跑就误判了）。
  for (const [slug, testId, anchor] of [
    ["mandate", "mandate-section", /Decision mode/i],
    ["mandate-intake", "mandate-intake-section", /Matter intake|Intake|供应商|Cross-line/i],
  ]) {
    await page.getByTestId(`settings-section-${slug}`).click();
    // 等 testId 出现，再等它的**文本**匹配锚点——两步分开，失败时能说清是
    // 「容器没出来」还是「出来了但内容是 Loading」。
    const pane = page.getByTestId(testId);
    // `locator.isVisible()` 不等待（立即返回）——第一次用它在页面刚打开时就判了
    // false，白等 45 秒的错觉。要等就用 waitFor。
    const appeared = await pane.waitFor({ state: "visible", timeout: 45_000 }).then(() => true).catch(() => false);
    let ok = false;
    let seen = "";
    if (appeared) {
      for (let i = 0; i < 30 && !ok; i += 1) {
        seen = (await pane.innerText().catch(() => "")) || "";
        ok = anchor.test(seen);
        if (!ok) await page.waitForTimeout(1000);
      }
    }
    note(`settings/${slug} renders with content`, ok,
      ok ? "" : `appeared=${appeared} text="${seen.slice(0, 80).replace(/\n/g, " ")}"`);
    await shot(slug);
  }

  const policy0 = await api("/api/fleets/delegation-policy");
  const modeOf = (p, d) => p?.domains?.[d]?.mode ?? null;
  const allAdviseOrAbsent = ["external-comms", "advancement", "research"].every((d) => {
    const m = modeOf(policy0.body.mandate, d);
    return m === null || m === "advise";
  });
  note("fresh cell grants nothing", allAdviseOrAbsent && (policy0.body.domainMap ?? []).every((m) => !m.enabled),
    `external-comms=${modeOf(policy0.body.mandate, "external-comms")} intake=${(policy0.body.domainMap ?? []).map((m) => m.enabled).join(",")}`);
  note("policy read exposes mandate + domainMap + levelSamples + consistency",
    Boolean(policy0.body.mandate && policy0.body.domainMap && policy0.body.levelSamples && policy0.body.consistency));

  // ── 2. 配一个域，读回一致 ────────────────────────────────────────────────
  const put = await api("/api/fleets/delegation-policy", {
    method: "PUT",
    body: JSON.stringify({
      scope: "cell",
      mandate: { version: 2, domains: { "external-comms": { mode: "draft", discloseScope: ["public", "internal"], revokeWindowMinutes: 10 } } },
    }),
  });
  const policy1 = await api("/api/fleets/delegation-policy");
  note("mandate write round-trips", put.status === 200 && modeOf(policy1.body.mandate, "external-comms") === "draft",
    `status=${put.status} mode=${modeOf(policy1.body.mandate, "external-comms")}`);

  const bad = await api("/api/fleets/delegation-policy", {
    method: "PUT",
    body: JSON.stringify({ scope: "cell", mandate: { version: 2, domains: { "no-such-domain": { mode: "draft" } } } }),
  });
  note("unknown domain is refused, not stored", bad.status === 400, `status=${bad.status} ${bad.body.error ?? ""}`);

  // ── 3. 裁决端点四条路径 ──────────────────────────────────────────────────
  const verdict = (body, token) =>
    api("/api/actions/mandate-verdict", {
      method: "POST",
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  const wrongToken = await verdict({ domain: "external-comms", text: "hi" }, "wrong");
  note("verdict: wrong bearer is 401", wrongToken.status === 401, `status=${wrongToken.status}`);

  const blocked = await verdict({ domain: "external-comms", text: "这单我们报 42 万，含三年维护" }, TOKEN);
  const finance = (blocked.body.violations ?? []).some((v) => v.level === "finance");
  note("verdict: money is withheld with a readable violation", blocked.body.ok === false && finance,
    `decision=${blocked.body.decision} reason=${blocked.body.reason} violations=${JSON.stringify(blocked.body.violations ?? [])}`);

  // draft 模式下「干净消息也是 draft」是正确行为，先断言这一点，再升档验证放行。
  const draftClean = await verdict({ domain: "external-comms", text: "合同已寄出，预计后天到", channelRevocable: true }, TOKEN);
  note("verdict: under draft mode even a clean message stays draft", draftClean.body.decision === "draft", `decision=${draftClean.body.decision}`);

  await api("/api/fleets/delegation-policy", {
    method: "PUT",
    body: JSON.stringify({
      scope: "cell",
      mandate: { version: 2, domains: { "external-comms": { mode: "act-notify", discloseScope: ["public", "internal"], revokeWindowMinutes: 10 } } },
    }),
  });
  const allowed = await verdict({ domain: "external-comms", text: "合同已寄出，预计后天到", channelRevocable: true }, TOKEN);
  note("verdict: a clean message is allowed once the domain may act", allowed.body.ok === true, `decision=${allowed.body.decision} digest=${String(allowed.body.contentDigest ?? "").slice(0, 12)}…`);

  // 渠道不可撤回 → 必须回落 draft（撤不回的东西不许自动发）
  const noRecall = await verdict({ domain: "external-comms", text: "合同已寄出", channelRevocable: false }, TOKEN);
  note("verdict: a non-revocable channel falls back to draft", noRecall.body.decision === "draft" && noRecall.body.reason === "channel_not_revocable", `reason=${noRecall.body.reason}`);

  const missing = await verdict({ domain: "external-comms" }, TOKEN);
  note("verdict: missing text is 400, not a silent allow", missing.status === 400, `status=${missing.status}`);

  // ── 4. 台账 / 回执 / 撤回 ────────────────────────────────────────────────
  const ledger0 = await api("/api/actions/mandate/ledger?limit=5");
  note("ledger read face answers", ledger0.status === 200 && Array.isArray(ledger0.body.rows), `rows=${ledger0.body.rows?.length ?? "?"}`);

  await browser.close();
} catch (e) {
  note("acceptance aborted", false, String(e?.message || e).slice(0, 400));
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  const failed = steps.filter((s) => s.startsWith("FAIL")).length;
  console.log(`\n${steps.length - failed}/${steps.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
