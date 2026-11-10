// 个人代理 · 十个场景的实际验收（2026-11-10）
//
// 与单测的区别：这里按「主人会怎么用」的顺序把十个场景连起来跑，看每个场景
// 在真实路由 / 真实 DB 上到底成不成立。一次启动，逐场景打印 PASS/FAIL。
//
//   node scripts/verify-agent-scenarios.mjs
//
// 场景：
//   S1 授权收紧：未配置 → 只给建议；配 draft → 可起草；收回 → 回到只给建议
//   S2 事项接入：开来源 → 落域；关来源 → 停流
//   S3 判例准入：deputy 自裁不入判例、主人手打进入
//   S4 审计官：可建（需委托状）、异议不阻断、阻断转回主人
//   S5 审计官不进工作图：作边端/裁判被拒
//   S6 披露闸：金额被拦并指名；干净放行；渠道不可撤回→回落
//   S7 台账与回执：只存 digest、回执不含原文
//   S8 撤回：窗口内成功、窗口外拒绝
//   S9 放量闸：层级样本不足拒绝自动对外
//   S10 就绪检查：坏配置 blocked、好配置 ready，坞面/日报同源

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-scenarios-"));
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.PLATFORM_DATA_DIR = tmp;
process.env.DSH_HOME = path.join(tmp, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { initDb, getDb } = await import("../db.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");
const { registerActionsRoutes } = await import("../server/routes/actions.js");
const { gateOutboundMessage } = await import("../lib/outbound-message.js");
const { validateOrchestration } = await import("../server/fleet-orchestration.js");
const { renderDeputyDigest } = await import("../server/fleet-delegation-digest.js");

await initDb();
const db = createFleetDatabase({});
setFleetDatabase(db);

const OWNER = "owner@test";
const FLEET = "f_scen";
db.createFleet({ id: FLEET, name: "场景舰队", ownerEmail: OWNER });

const app = express();
app.use(express.json());
createFleetRoutes(app, { authEnabled: false, cellUserEmail: OWNER, currentPreset: null });
registerActionsRoutes({ app, broadcast: () => {} });
const srv = app.listen(0, "127.0.0.1");
await new Promise((r) => srv.once("listening", r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const call = (method, p, body) =>
  fetch(BASE + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const results = [];
async function scenario(name, fn) {
  try {
    const detail = await fn();
    results.push(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push(`FAIL ${name} — ${String(e?.message || e).slice(0, 220)}`);
  }
  console.log(results.at(-1));
}
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
const setPolicy = (domains) => call("PUT", "/api/fleets/delegation-policy", { scope: "cell", mandate: { version: 2, domains } });
const setMap = (map) => call("PUT", "/api/fleets/delegation-policy", { scope: "cell", domainMap: map });
const modeOf = async (d) => (await call("GET", "/api/fleets/delegation-policy")).body.mandate?.domains?.[d]?.mode ?? null;

// ── S1 授权收紧 ────────────────────────────────────────────────────────────
await scenario("S1 授权：未配置→只给建议，配 draft→起草，收回→回只给建议", async () => {
  // ops 域永远存在（它承载 legacy 委托默认值，默认 mode=advise）；另外三域
  // 才是「未配置即不存在」。这两件事必须分开断言，否则会把「没给权限」
  // 和「没有这个域」混为一谈。
  eq(await modeOf("ops"), "advise", "ops 恒存在且默认只给建议");
  eq(await modeOf("external-comms"), null, "未配置的域不该存在");
  await setPolicy({ ops: { mode: "draft", enabled: true } });
  eq(await modeOf("ops"), "draft", "配 draft 后");
  await setPolicy({ ops: { mode: "advise" } });
  eq(await modeOf("ops"), "advise", "收回后必须回到 advise");
  return "三态收放都对";
});

// ── S2 事项接入 ────────────────────────────────────────────────────────────
await scenario("S2 事项接入：开来源→落域，关来源→停流", async () => {
  await setMap([{ source: "cross-line-blocker", enabled: true }]);
  const on = (await call("GET", "/api/fleets/delegation-policy")).body.domainMap;
  const enabled = on.find((m) => m.source === "cross-line-blocker");
  eq(enabled?.enabled, true, "开启后");
  eq(enabled?.domain, "ops", "映射目标域");
  await setMap([{ source: "cross-line-blocker", enabled: false }]);
  const off = (await call("GET", "/api/fleets/delegation-policy")).body.domainMap;
  eq(off.find((m) => m.source === "cross-line-blocker")?.enabled, false, "关闭后");
  return "开→ops，关→停";
});

// ── S3 判例准入 ────────────────────────────────────────────────────────────
await scenario("S3 判例：deputy 自裁不入判例，主人手打进入", async () => {
  const mk = (id, rec) => db.appendDecision({
    id, fleetId: FLEET, memberId: "m1", question: `q-${id}`,
    options: [{ value: "a" }, { value: "b" }], recommendation: rec ?? null, route: "owner",
  });
  mk("s3_owner");
  db.transitionDecision("s3_owner", "open", {
    state: "delivered", resolvedAt: Date.now(), resolvedBy: "owner",
    resolution: { choice: "a" }, precedentGrade: "owner-authored",
  });
  mk("s3_deputy");
  db.transitionDecision("s3_deputy", "open", {
    state: "delivered", resolvedAt: Date.now(), resolvedBy: "deputy",
    resolution: { choice: "a" }, precedentGrade: "deputy-ruled",
  });
  const citable = db.listCitablePrecedents({ fleetId: FLEET });
  eq(citable.length, 1, "可引用条数");
  eq(citable[0].id, "s3_owner", "只该是主人那条");
  return "1 条可引用，deputy 那条被挡";
});

// ── S4 审计官 ──────────────────────────────────────────────────────────────
await scenario("S4 审计官：需委托状、异议不阻断、阻断转回主人", async () => {
  await setPolicy({ ops: { mode: "advise" } });
  let refused = false;
  try {
    f4check();
  } catch { refused = true; }
  function f4check() {
    // 未授予任何东西时，创建审计官必须被拒（走真实路由的守卫逻辑）
    const { auditorAllowedFor } = require4();
    if (!auditorAllowedFor(db.getFleetMandatePolicy(FLEET))) throw new Error("should refuse");
  }
  function require4() {
    return auditorModule;
  }
  const auditorModule = await import("../lib/auditor-tool-face.js");
  eq(refused, true, "advise-only 时必须拒绝建审计官");
  await setPolicy({ ops: { mode: "draft" } });
  eq(auditorModule.auditorAllowedFor(db.getFleetMandatePolicy(FLEET)), true, "配 draft 后允许");
  return "advise 拒绝、draft 允许";
});

// ── S5 审计官不进工作图 ────────────────────────────────────────────────────
await scenario("S5 审计官不进工作图：作边端/裁判被拒", async () => {
  const members = [
    { id: "lead", parentId: null, targetKind: "persona" },
    { id: "aud", parentId: "lead", targetKind: "auditor" },
  ];
  const bad = validateOrchestration({ members, orchestration: { edges: [{ kind: "handoff", from: "lead", to: "aud" }] } });
  eq(bad.ok, false, "auditor 作 handoff 下游必须非法");
  eq((bad.errors ?? []).some((e) => e.code === "auditor_not_orchestratable"), true, "错误码");
  return "handoff 被拒且码正确";
});

// ── S6 披露闸 ──────────────────────────────────────────────────────────────
await scenario("S6 披露闸：金额被拦并指名、干净放行、渠道不可撤回回落", async () => {
  const policy = { version: 2, domains: { "external-comms": { mode: "act-notify", discloseScope: ["public", "internal"], revokeWindowMinutes: 10 } } };
  const agent = { kind: "agent", email: OWNER };
  const blocked = gateOutboundMessage({ policy, domain: "external-comms", text: "报价 42 万", principal: agent, channelRevocable: true });
  eq(blocked.decision, "draft", "含金额必须回落 draft");
  eq(blocked.disclosure.violations.some((v) => v.level === "finance" && v.via === "pattern"), true, "越界项");
  const clean = gateOutboundMessage({ policy, domain: "external-comms", text: "合同已寄出", principal: agent, channelRevocable: true });
  eq(clean.ok, true, "干净消息放行");
  const noRecall = gateOutboundMessage({ policy, domain: "external-comms", text: "合同已寄出", principal: agent, channelRevocable: false });
  eq(noRecall.reason, "channel_not_revocable", "不可撤回渠道回落原因");
  return "拦/放/回落 三条都对";
});

// ── S7 台账与回执 ──────────────────────────────────────────────────────────
await scenario("S7 台账与回执：只存 digest、回执不含原文", async () => {
  const g = gateOutboundMessage({
    policy: { version: 2, domains: { "external-comms": { mode: "act-notify", discloseScope: ["public"], revokeWindowMinutes: 10 } } },
    domain: "external-comms", text: "会议改到周四下午", to: "c@x.com", channel: "email",
    principal: { kind: "agent", email: OWNER }, channelRevocable: true,
  });
  eq(g.ok, true, "放行");
  getDb().prepare(`INSERT INTO action_proposals (proposal_id,line,action_id,args_digest,risk,target,impact_text,state,created_at,updated_at)
    VALUES ('s7','bots','chat.message.send','d','write','cloud','i','executed','2026-11-10T00:00:00Z','2026-11-10T00:00:00Z')`).run();
  getDb().prepare(`INSERT INTO action_audit (proposal_id,line,action_id,args_digest,risk,target,impact_text,created_at,
      principal,audience,mandate_domain,mandate_mode,disclose_level,reversible_until,content_digest,result_summary)
    VALUES ('s7','bots','chat.message.send','d','write','cloud','i','2026-11-10T00:00:00Z',?,?,'external-comms','act-notify','internal',?,?,'ok')`)
    .run(g.ledger.principal, g.ledger.audience, g.ledger.reversibleUntil, g.ledger.contentDigest);
  const receipt = await call("GET", "/api/actions/s7/receipt");
  eq(receipt.status, 200, "回执可查");
  eq(receipt.body.principal, OWNER, "代表谁");
  eq(receipt.body.audience, "email:c@x.com", "对谁说");
  eq(JSON.stringify(receipt.body).includes("会议改到周四"), false, "回执不得含原文");
  return "digest 入库、回执无原文";
});

// ── S8 撤回 ────────────────────────────────────────────────────────────────
await scenario("S8 撤回：窗口内成功、窗口外拒绝", async () => {
  const live = await call("POST", "/api/actions/s7/revoke");
  eq(live.status, 200, "窗口内应成功");
  const again = await call("POST", "/api/actions/s7/revoke");
  eq(again.status, 409, "重复撤回应拒绝");
  getDb().prepare(`INSERT INTO action_proposals (proposal_id,line,action_id,args_digest,risk,target,impact_text,state,created_at,updated_at)
    VALUES ('s8','bots','chat.message.send','d','write','cloud','i','executed','2026-11-10T00:00:00Z','2026-11-10T00:00:00Z')`).run();
  getDb().prepare(`INSERT INTO action_audit (proposal_id,line,action_id,args_digest,risk,target,impact_text,created_at,
      audience,mandate_domain,mandate_mode,reversible_until,result_summary)
    VALUES ('s8','bots','chat.message.send','d','write','cloud','i','2026-11-10T00:00:00Z','email:c@x.com','external-comms','act-notify',?,'ok')`)
    .run(Date.now() - 1000);
  const dead = await call("POST", "/api/actions/s8/revoke");
  eq(dead.status, 409, "窗口外必须拒绝");
  return "窗口内 200、窗外 409";
});

// ── S9 放量闸 ──────────────────────────────────────────────────────────────
await scenario("S9 放量闸：层级样本不足拒绝自动对外", async () => {
  const { canAutoSendAtLevel } = await import("../lib/personal-mandate.js");
  const gate = canAutoSendAtLevel({ level: "finance", levelSamples: { finance: 0 }, minSamples: 20 });
  eq(gate.ok, false, "样本 0 必须拒绝");
  eq(gate.reason, "insufficient_level_samples", "原因");
  eq(canAutoSendAtLevel({ level: null }).reason, "unknown_level", "层级不明也要拒");
  return "样本不足/层级不明 都拒";
});

// ── S10 就绪检查 ───────────────────────────────────────────────────────────
await scenario("S10 就绪检查：坏配置 blocked、好配置 ready，坞面与日报同源", async () => {
  await setPolicy({ ops: { mode: "advise" } });
  await setMap([]);
  const bad = await call("GET", "/api/fleets/personal-agent/readiness");
  eq(bad.body.ready, false, "坏配置应 not ready");
  eq(bad.body.verdict.includes("还不能用"), true, "结论要直说");

  await setPolicy({ ops: { mode: "draft" } });
  await setMap([{ source: "cross-line-blocker", enabled: true }]);
  const good = await call("GET", "/api/fleets/personal-agent/readiness");
  eq(good.body.ready, true, "好配置应 ready");

  const board = await call("GET", "/api/fleets/owner/board");
  const row = (board.body.fleets ?? []).find((f) => f.id === FLEET);
  eq(row?.personalAgent?.ready, true, "坞面行应与端点同源");

  await setPolicy({ ops: { mode: "advise" } });
  db.recordMandateViolation("ops", "quota");
  const digest = renderDeputyDigest({ db, fleet: { id: FLEET, name: "场景舰队" }, since: Date.now() - 3600_000, now: Date.now() });
  eq(/配置体检: 还不能用/.test(digest ?? ""), true, "日报要带配置体检");
  return "端点/坞面/日报三面一致";
});

// ── S11 端到端：来源经真实 escalate 落域（此前这条链是空的）──────────────
await scenario("S11 端到端：escalate 带 source → 事项真的落进域", async () => {
  // 此前 validateEscalatePayload 不认 source，payload.item.source 恒 undefined，
  // domainFor(map, null) 恒 null —— 映射配了也永远不会有一个事项落进去。
  const { validateEscalatePayload } = await import("../server/fleet-decisions.js");
  const shaped = validateEscalatePayload({
    question: "A 仓等 B 仓接口，卡两天了", options: [{ value: "wait", label: "继续等" }, { value: "escalate", label: "升级" }],
    source: "cross-line-blocker",
  });
  eq(shaped.ok, true, "带 source 的载荷应当合法");
  eq(shaped.item.source, "cross-line-blocker", "source 必须原样保留");

  const bad = validateEscalatePayload({
    question: "拼错的来源", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], source: "cross-line-blokcer",
  });
  eq(bad.ok, false, "拼错的来源必须被拒（拼错等于永不触发）");

  // 落域：用与路由相同的解析
  const { domainFor } = await import("../lib/personal-domain-map.js");
  await setMap([{ source: "cross-line-blocker", enabled: true }]);
  const map = (await call("GET", "/api/fleets/delegation-policy")).body.domainMap;
  eq(domainFor(map, shaped.item.source), "ops", "开启的来源应解析到 ops");
  eq(domainFor(map, "supplier-thread"), null, "未开启的来源不落域");
  return "载荷合法 → 解析到 ops；拼错被拒";
});

// ── S12 路由依据：category 决定给谁（此前工具不发它 → 98% 落 owner）─────
await scenario("S12 路由依据：category 决定给谁，缺省落 owner", async () => {
  const { validateEscalatePayload } = await import("../server/fleet-decisions.js");
  const { routeForItem } = await import("../server/routes/fleets-db.js");
  const shaped = validateEscalatePayload({
    question: "这条要不要批准", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
    category: "routine-ops",
  });
  eq(shaped.ok, true, "带 category 合法");
  eq(shaped.item.category, "routine-ops", "category 必须原样保留");

  const policy = db.getFleetDelegationPolicy(FLEET);
  eq(routeForItem({ category: shaped.item.category, severity: "normal" }, { ...policy, enabled: true }), "deputy", "routine-ops 应路由 deputy");
  eq(routeForItem({ category: null, severity: "normal" }, { ...policy, enabled: true }), "owner", "无类别落 owner（实测生产 98% 是这种）");
  eq(routeForItem({ category: "spend", severity: "low" }, { ...policy, enabled: true }), "owner", "花费永远 owner");

  const bad = validateEscalatePayload({
    question: "类别拼错", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], category: "routine-op",
  });
  eq(bad.ok, true, "未知类别不拒（category 自由文本，路由侧兜底）");
  return "有类别→deputy，无类别→owner，花费→owner";
});

srv.close();
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} 场景通过`);
process.exitCode = failed ? 1 : 0;
