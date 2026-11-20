// 拍板委托 (add-deputy-decision-delegate) — 策略路由、强制授权、归并、角标口径。
//
// 这些用例钉的是「服务端闸」而不是提示词：draft 里最硬的一条是"AI 越权由
// 代码拦下"，所以每条越权路径都必须有一条断言说 403 且条目原样保留。
//
// Run: node --test scripts/test-fleet-delegation.mjs

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-delegation-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { initDb } = await import("../db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");
const {
  createFleetDatabase,
  setFleetDatabase,
  normalizeDelegationPolicy,
  routeForItem,
} = await import("../server/routes/fleets-db.js");

await initDb();
const fleetDb = createFleetDatabase({});
setFleetDatabase(fleetDb);

const FLEET = "fleet_dlg_1";
const DEPUTY = "m_deputy";
const WORKER = "m_worker";
const OWNER = "owner@test";

// The deputy is identified by the turn's current preset — the same attribution
// path escalate uses. Tests flip `ctx.currentPreset` to act as either post.
const ctx = { authEnabled: false, cellUserEmail: OWNER, currentPreset: null };

async function startServer() {
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { server, call };
}

before(() => {
  fleetDb.createFleet({ id: FLEET, name: "委托舰队", ownerEmail: OWNER });
  // Persona posts whose targetId doubles as the preset id — attribution
  // resolves the running turn's preset against these.
  fleetDb.createMember({
    id: DEPUTY, fleetId: FLEET, title: "常务", targetKind: "persona", targetId: "preset-deputy",
    cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", enabled: true },
  });
  fleetDb.createMember({
    id: WORKER, fleetId: FLEET, title: "投稿岗", targetKind: "persona", targetId: "preset-worker",
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  });
});

// ── 策略模型（纯函数） ───────────────────────────────────────────────────────

test("policy:高风险类别不可委托——写进来也被归一为 owner", () => {
  const p = normalizeDelegationPolicy(
    { enabled: true, routes: { "config-change": "deputy", hr: "deputy", spend: "deputy", "routine-ops": "deputy" } },
    null,
  );
  assert.equal(p.routes["config-change"], "owner");
  assert.equal(p.routes.hr, "owner");
  assert.equal(p.routes.spend, "owner");
  assert.equal(p.routes["routine-ops"], "deputy", "可委托类别照常生效");
});

test("policy:默认关闭委托，行为与未启用一致", () => {
  const p = normalizeDelegationPolicy(null, null);
  assert.equal(p.enabled, false);
  // 2026-11-13 订正（fix-mandate-write-preserves-deputy）：这里原先钉的是
  // 「enabled=false 时路由字段仍按策略算」⇒ routine-ops 落 deputy。那是缺陷不是契约：
  // 未启用委托的舰队没有常务岗，落到 deputy 的条目**谁都不能裁**（deputyGuard 403），
  // 只能等过期。路由必须与授权同源——能不能裁由 enabled 决定，派给谁也由它决定。
  assert.equal(routeForItem({ category: "routine-ops", severity: "low" }, { ...p, enabled: false }), "owner");
  assert.equal(
    routeForItem({ category: "routine-ops", severity: "low" }, { ...p, enabled: true }),
    "deputy",
    "启用后同一类别仍按策略路由给常务岗",
  );
  // 舰队覆写可把 routes.default 设 owner
  const off = normalizeDelegationPolicy(null, { enabled: false, routes: { default: "owner" } });
  assert.equal(off.enabled, false);
});

test("policy:严重度超过上限一律路由 owner", () => {
  const p = normalizeDelegationPolicy({ enabled: true, maxSeverity: "normal" }, null);
  assert.equal(routeForItem({ category: "routine-ops", severity: "high" }, p), "owner");
  assert.equal(routeForItem({ category: "routine-ops", severity: "normal" }, p), "deputy");
});

test("policy:config-change 类型即使无类别也路由 owner", () => {
  const p = normalizeDelegationPolicy({ enabled: true }, null);
  assert.equal(routeForItem({ itemType: "config-change", severity: "low" }, p), "owner");
});

test("policy:舰队覆写只改自己写到的键", () => {
  const cell = { enabled: true, dailyBudget: 20, maxSeverity: "normal", routes: { "routine-ops": "deputy" } };
  const merged = normalizeDelegationPolicy(cell, { maxSeverity: "low" });
  assert.equal(merged.maxSeverity, "low");
  assert.equal(merged.dailyBudget, 20, "未覆写的键沿用 cell 默认");
  assert.equal(merged.routes["routine-ops"], "deputy");
});

// ── serve 路径：escalate 路由 + 归并 ────────────────────────────────────────

test("escalate:按策略路由，并把路由写进响应", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setCellSetting("delegationPolicy", { enabled: true, routes: { "routine-ops": "deputy" }, maxSeverity: "high" });
    ctx.currentPreset = "preset-worker";
    const r = await call("POST", "/api/fleets/escalate", {
      question: "本周视频是否提前发布",
      options: [{ value: "now", label: "立即发布" }, { value: "fri", label: "周五发布" }],
      severity: "normal",
      category: "routine-ops",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.route, "deputy");
    const item = fleetDb.getDecision(r.body.itemId);
    assert.equal(item.route, "deputy");
    assert.equal(item.category, "routine-ops");
  } finally {
    server.close();
  }
});

test("escalate:同岗位同主题重复升级被归并，不落新行", async () => {
  const { server, call } = await startServer();
  try {
    ctx.currentPreset = "preset-worker";
    const payload = {
      question: "电商部报告 fleet 服务端重复岗位注册导致 report_status 持续被拒",
      options: [{ value: "fix", label: "修" }, { value: "wait", label: "等" }],
      severity: "high",
      topicKey: "dup-post-registry",
    };
    const first = await call("POST", "/api/fleets/escalate", payload);
    assert.equal(first.status, 201);
    assert.equal(first.body.merged, undefined);
    const before = fleetDb.listDecisions({ fleetId: FLEET, state: "open", memberId: WORKER }).length;

    const second = await call("POST", "/api/fleets/escalate", {
      ...payload,
      // 措辞不同但 topicKey 相同 —— 归并的判据是声明主题，不是文本
      question: "重复岗位注册仍未修复，report_status 继续被拒（第三轮）",
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.merged, true);
    assert.equal(second.body.itemId, first.body.itemId, "归并指回既有条目");
    const after = fleetDb.listDecisions({ fleetId: FLEET, state: "open", memberId: WORKER }).length;
    assert.equal(after, before, "没有新行");
    assert.equal(fleetDb.getDecision(first.body.itemId).escalations, 1);
  } finally {
    server.close();
  }
});

test("escalate:不同主题不误并", async () => {
  const { server, call } = await startServer();
  try {
    ctx.currentPreset = "preset-worker";
    const a = await call("POST", "/api/fleets/escalate", {
      question: "本周视频是否提前发布", options: [{ value: "y", label: "是" }, { value: "n", label: "否" }],
      severity: "low", topicKey: "video-timing",
    });
    const b = await call("POST", "/api/fleets/escalate", {
      question: "客服排班是否改为两班制", options: [{ value: "y", label: "是" }, { value: "n", label: "否" }],
      severity: "low", topicKey: "support-shift",
    });
    assert.notEqual(a.body.itemId, b.body.itemId);
    assert.equal(b.body.merged, undefined);
  } finally {
    server.close();
  }
});

test("escalate:归并也计入每日防洪上限", async () => {
  const { server, call } = await startServer();
  try {
    const fleetId = "fleet_cap";
    fleetDb.createFleet({ id: fleetId, name: "上限舰队", ownerEmail: OWNER });
    fleetDb.createMember({
      id: "m_cap", fleetId, title: "闸岗", targetKind: "persona", targetId: "preset-cap",
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
    });
    fleetDb.updateFleet(fleetId, { decisionPolicy: { expiryHours: 72, dailyCapPerMember: 2 } });
    ctx.currentPreset = "preset-cap";
    const p = (i) => ({
      question: `第 ${i} 次升级同一个阻塞问题`, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "low", topicKey: "same-blocker",
    });
    assert.equal((await call("POST", "/api/fleets/escalate", p(1))).status, 201);
    assert.equal((await call("POST", "/api/fleets/escalate", p(2))).status, 200, "第二次是归并");
    const third = await call("POST", "/api/fleets/escalate", p(3));
    assert.equal(third.status, 429, "第三次触顶——归并同样计入上限");
  } finally {
    server.close();
  }
});

// ── 服务端强制授权 ─────────────────────────────────────────────────────────

test("deputy:非常务岗调队列被拒（403）", async () => {
  const { server, call } = await startServer();
  try {
    ctx.currentPreset = "preset-worker";
    const r = await call("POST", "/api/fleets/deputy/queue", {});
    assert.equal(r.status, 403);
  } finally {
    server.close();
  }
});

test("deputy:越出委托类别被服务端拒绝，条目原样保留", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    ctx.currentPreset = "preset-worker";
    // 手工造一条 config-change 但强行 route=deputy（模拟历史数据/被绕过）
    const item = fleetDb.appendDecision({
      id: "d_forbidden", fleetId: FLEET, memberId: WORKER,
      question: "把 defaultModel 改成 cheap-m", options: [{ value: "y", label: "批准" }, { value: "n", label: "驳回" }],
      severity: "low", itemType: "config-change", route: "deputy", category: "config-change",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: item.id, kind: "approve", choice: "y", evidence: "例行",
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /beyond delegation mandate/);
    const after = fleetDb.getDecision(item.id);
    assert.equal(after.state, "open", "条目原样保留");
  } finally {
    server.close();
  }
});

test("deputy:严重度超上限被拒", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "low", dailyBudget: 20,
    });
    const item = fleetDb.appendDecision({
      id: "d_sev", fleetId: FLEET, memberId: WORKER, question: "一个 high 严重度的例行选择",
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "high", route: "deputy", category: "routine-ops",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: item.id, kind: "approve", choice: "a", evidence: "x",
    });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /severity/);
  } finally {
    server.close();
  }
});

test("deputy:预算内的裁决生效并记录身份与依据", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    const item = fleetDb.appendDecision({
      id: "d_ok", fleetId: FLEET, memberId: WORKER, question: "例行运营选择：周报是否包含图表",
      options: [{ value: "yes", label: "包含" }, { value: "no", label: "不包含" }],
      severity: "normal", route: "deputy", category: "routine-ops",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: item.id, kind: "approve", choice: "yes",
      evidence: "主人 2026-10 判例：周报一律附图", model: "deepseek-v4.1-flash",
    });
    assert.equal(r.status, 200);
    const after = fleetDb.getDecision(item.id);
    assert.equal(after.state, "approved");
    assert.equal(after.resolvedBy, "deputy");
    assert.match(after.rulingEvidence, /判例/);
    assert.equal(after.resolution.choice, "yes");
    // 裁决模型只由服务端从本回合子进程的 request/header 取——这个 ctx 没有
    // 回合账本，所以如实为空。请求体自报的 "deepseek-v4.1-flash" MUST NOT 落库
    // （生产 2026-10-29 实证：照抄自报值会让审计记录变成代理的自我声明）。
    assert.equal(after.resolvedByModel, null, "自报的 model 不得被当作裁决事实");
  } finally {
    server.close();
  }
});

test("deputy:裁决模型取自本回合真实 header，不信调用方自报", async () => {
  // 一个最小的回合账本替身：observedModelFor 返回子进程实际发出的模型。
  const ledger = { observedModelFor: (memberId) => (memberId === DEPUTY ? "observed-real-model" : null) };
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: OWNER, currentPreset: "preset-deputy", fleetTurnLedger: ledger });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) =>
    fetch(`${base}${p}`, {
      method, headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    const item = fleetDb.appendDecision({
      id: "d_model_src", fleetId: FLEET, memberId: WORKER, question: "裁决模型的来源校验",
      options: [{ value: "a", label: "A" }], severity: "normal", route: "deputy", category: "routine-ops",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: item.id, kind: "approve", choice: "a", evidence: "依据",
      model: "caller-claims-this-model", // 必须被忽略
    });
    assert.equal(r.status, 200);
    const after = fleetDb.getDecision(item.id);
    assert.equal(after.resolvedByModel, "observed-real-model", "落库的是 header 观测值");
    assert.notEqual(after.resolvedByModel, "caller-claims-this-model", "调用方自报的值不得生效");
  } finally {
    server.close();
  }
});

test("deputy:日预算用尽后拒绝", async () => {
  const { server, call } = await startServer();
  try {
    // 独立舰队：日预算是 per-fleet-per-day，共用舰队会被前序用例消耗。
    const fleetId = "fleet_budget";
    fleetDb.createFleet({ id: fleetId, name: "预算舰队", ownerEmail: OWNER });
    fleetDb.createMember({
      id: "m_budget_deputy", fleetId, title: "预算常务", targetKind: "persona", targetId: "preset-budget-deputy",
      cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", enabled: true },
    });
    fleetDb.createMember({
      id: "m_budget_worker", fleetId, title: "预算岗", targetKind: "persona", targetId: "preset-budget-worker",
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
    });
    fleetDb.setFleetDelegationPolicy(fleetId, {
      enabled: true, deputyMemberId: "m_budget_deputy", routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 1,
    });
    const mk = (id) => fleetDb.appendDecision({
      id, fleetId, memberId: "m_budget_worker", question: `预算用例 ${id}`,
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "low", route: "deputy", category: "routine-ops",
    });
    ctx.currentPreset = "preset-budget-deputy";
    mk("d_b1");
    assert.equal((await call("POST", "/api/fleets/deputy/resolve", {
      itemId: "d_b1", kind: "approve", choice: "a", evidence: "e",
    })).status, 200);
    mk("d_b2");
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: "d_b2", kind: "approve", choice: "a", evidence: "e",
    });
    assert.equal(r.status, 429);
    assert.match(r.body.error, /budget/);
  } finally {
    server.close();
  }
});

test("deputy:判不了可上报主人（转路由 owner）", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    const item = fleetDb.appendDecision({
      id: "d_esc", fleetId: FLEET, memberId: WORKER, question: "空缺岗位如何处置——需要主人偏好",
      options: [{ value: "a", label: "补岗" }, { value: "b", label: "撤销" }],
      severity: "normal", route: "deputy", category: "routine-ops",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/escalate-to-owner", {
      itemId: item.id, analysis: "两种处置都可行，取决于主人对这个岗位的投入意愿",
    });
    assert.equal(r.status, 200);
    const after = fleetDb.getDecision(item.id);
    assert.equal(after.route, "owner", "转回主人队列");
    assert.equal(after.state, "open", "仍待裁");
    assert.match(after.detail.deputyAnalysis.analysis, /投入意愿/);
  } finally {
    server.close();
  }
});

test("deputy:主人可收回委托条目", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    const item = fleetDb.appendDecision({
      id: "d_recall", fleetId: FLEET, memberId: WORKER, question: "先委托后来想自己裁的一条",
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "low", route: "deputy", category: "routine-ops",
    });
    const r = await call("POST", `/api/fleets/${FLEET}/decisions/${item.id}/recall`, {});
    assert.equal(r.status, 200);
    assert.equal(fleetDb.getDecision(item.id).route, "owner");
  } finally {
    server.close();
  }
});

// ── 角标口径 ───────────────────────────────────────────────────────────────

test("角标只计 route=owner，deputy 的另计", async () => {
  const { server, call } = await startServer();
  try {
    const fleetId = "fleet_badge";
    fleetDb.createFleet({ id: fleetId, name: "角标舰队", ownerEmail: OWNER });
    fleetDb.createMember({
      id: "m_badge", fleetId, title: "角标岗", targetKind: "persona", targetId: "preset-badge",
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
    });
    for (let i = 0; i < 3; i += 1) {
      fleetDb.appendDecision({
        id: `d_owner_${i}`, fleetId, memberId: "m_badge", question: `主人待裁 ${i}`,
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], severity: "low", route: "owner",
      });
    }
    for (let i = 0; i < 2; i += 1) {
      fleetDb.appendDecision({
        id: `d_deputy_${i}`, fleetId, memberId: "m_badge", question: `常务待裁 ${i}`,
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], severity: "low", route: "deputy",
      });
    }
    const r = await call("GET", "/api/fleets");
    const row = (r.body.fleets ?? []).find((f) => f.id === fleetId);
    assert.equal(row.openDecisions, 3, "「等你 N 件」只计 owner");
    assert.equal(row.deputyOpen, 2, "deputy 队列另计");
  } finally {
    server.close();
  }
});

// ── 执行事实 ───────────────────────────────────────────────────────────────

test("执行事实：送达即回填 executed_at，「批了没执行」可区分", () => {
  const fleetId = "fleet_exec";
  fleetDb.createFleet({ id: fleetId, name: "执行舰队", ownerEmail: OWNER });
  fleetDb.createMember({
    id: "m_exec", fleetId, title: "执行岗", targetKind: "persona", targetId: "preset-exec",
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  });
  const item = fleetDb.appendDecision({
    id: "d_exec", fleetId, memberId: "m_exec", question: "批准后要确认执行",
    options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], severity: "low",
  });
  fleetDb.transitionDecision(item.id, "open", {
    state: "approved", resolvedAt: Date.now(), resolvedBy: "owner",
    resolution: { kind: "approve", choice: "a", note: null, by: OWNER, at: Date.now() },
  });
  const approved = fleetDb.getDecision(item.id);
  assert.equal(approved.state, "approved");
  assert.equal(approved.executedAt, null, "已批未送达 = 还没执行");

  fleetDb.markDelivered("m_exec", { sessionId: "sess-1" });
  const delivered = fleetDb.getDecision(item.id);
  assert.equal(delivered.state, "delivered");
  assert.ok(delivered.executedAt, "送达回合完成即执行事实");
  assert.equal(delivered.executedSessionId, "sess-1");
});
// ── 存量 triage（发布迁移路径） ──────────────────────────────────────────────

test("triage：重路由存量并按主题归并，第二次调用不再变化", async () => {
  const { server, call } = await startServer();
  try {
    const fleetId = "fleet_triage";
    fleetDb.createFleet({ id: fleetId, name: "迁移舰队", ownerEmail: OWNER });
    fleetDb.createMember({
      id: "m_triage", fleetId, title: "迁移岗", targetKind: "persona", targetId: "preset-triage",
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
    });
    fleetDb.setCellSetting("delegationPolicy", { enabled: true, routes: { "routine-ops": "deputy" }, maxSeverity: "high" });
    // 三条存量：两条同主题（应归并），一条不同主题（保留）；全部还是 route=owner
    const mk = (id, q, topic) => fleetDb.appendDecision({
      id, fleetId, memberId: "m_triage", question: q, topicKey: topic,
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      severity: "low", category: "routine-ops",
    });
    mk("t1", "重复岗位注册导致报数被拒（第一轮）", "dup-post");
    mk("t2", "重复岗位注册导致报数被拒（第三轮）", "dup-post");
    mk("t3", "客服排班是否改两班制", "shift");

    const first = await call("POST", `/api/fleets/${fleetId}/decisions/triage`, {});
    assert.equal(first.status, 200);
    assert.equal(first.body.scanned, 3);
    assert.equal(first.body.rerouted, 3, "存量全部按策略重路由");
    assert.equal(first.body.merged, 1, "同主题的一条被归并");

    const open = fleetDb.listDecisions({ fleetId, state: "open" });
    assert.equal(open.length, 2, "归并后剩两条待裁");
    assert.ok(open.every((i) => i.route === "deputy"), "重路由生效");

    const second = await call("POST", `/api/fleets/${fleetId}/decisions/triage`, {});
    assert.equal(second.body.rerouted, 0, "幂等：无变化");
    assert.equal(second.body.merged, 0);
  } finally {
    server.close();
  }
});

// ── 桥面鉴权（真机回归：生产 401） ──────────────────────────────────────────
//
// 2026-10-29 真机走查抓到的生产真缺陷：isInternalFleetBridge 的豁免名单
// 只列了 report/escalate/dispatch，新加的三条 deputy 路由没进去——常务岗的
// MCP 子进程调 decision_queue 一律 401「Authentication required」，而同一
// 子进程的 escalate 却通。上面所有用例都直接挂载路由、绕过了鉴权中间件，
// 所以单元测试全绿而生产全红。这条用例把真闸门也钉进来。
test("桥面鉴权：deputy 三条路由在 loopback 上被豁免，非桥面路径仍被挡", async () => {
  const { registerAuth } = await import("../server/auth.js");
  const app = express();
  app.use(express.json());
  const authCtx = {
    app,
    authEnabled: true,
    authMode: "logto",
    headerTrust: null,
    // 匿名：任何非豁免路径都拿不到身份，与生产里 MCP 子进程的处境一致。
    logtoAuth: { authenticate: () => null },
    ssoEnabled: false,
  };
  registerAuth(authCtx);
  const routeCtx = { authEnabled: false, cellUserEmail: OWNER, currentPreset: "preset-deputy" };
  createFleetRoutes(app, routeCtx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    for (const p of ["/api/fleets/deputy/queue", "/api/fleets/deputy/resolve", "/api/fleets/deputy/escalate-to-owner"]) {
      const r = await post(p);
      assert.notEqual(r.status, 401, `${p} 必须不被鉴权闸挡下（生产 2026-10-29 真缺陷）`);
      assert.equal(r.body?.error === "Authentication required", false, `${p} 不得返回鉴权错误`);
    }
    // 反向断言：豁免是名单制，不是 /api/fleets 前缀放行——否则任何新加的无鉴权
    // 路由都会被动继承一个后门。
    const control = await post("/api/fleets/deputy/not-a-bridge");
    assert.equal(control.status, 401, "名单外的路径仍要过完整鉴权");
  } finally {
    server.close();
  }
});

// ── 策略字段的落点（不留假旋钮） ────────────────────────────────────────────

test("policy.model：写进策略即落到常务岗岗位的 model（真正的解析链首跳）", async () => {
  const { server, call } = await startServer();
  try {
    // 先把常务岗指定出来，策略才有落点。
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    const r = await call("PUT", "/api/fleets/delegation-policy", {
      scope: "fleet", fleetId: FLEET,
      policy: { enabled: true, deputyMemberId: DEPUTY, model: "policy-declared-model" },
    });
    assert.equal(r.status, 200);
    assert.equal(fleetDb.getMember(DEPUTY).model, "policy-declared-model", "策略声明落到岗位 model");
    // 清空声明 = 回到继承链（岗位 model 清空），不是留一个陈旧值。
    const cleared = await call("PUT", "/api/fleets/delegation-policy", {
      scope: "fleet", fleetId: FLEET,
      policy: { enabled: true, deputyMemberId: DEPUTY, model: null },
    });
    assert.equal(cleared.status, 200);
    assert.equal(fleetDb.getMember(DEPUTY).model, null, "清空即回到继承");
  } finally {
    server.close();
  }
});

test("deputy digest：按策略频率渲染裁决摘要，空窗口不写空页", async () => {
  const { renderDeputyDigest, determineDueDeputyDigests } = await import("../server/fleet-delegation-digest.js");
  const fleetId = "fleet_digest";
  fleetDb.createFleet({ id: fleetId, name: "摘要舰队", ownerEmail: OWNER });
  fleetDb.createMember({
    id: "m_dg_worker", fleetId, title: "投稿岗", targetKind: "persona", targetId: "preset-dgw",
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  });
  fleetDb.createMember({
    id: "m_dg_deputy", fleetId, title: "常务", targetKind: "persona", targetId: "preset-dgd",
    cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", enabled: true },
  });
  const fleet = fleetDb.getFleet(fleetId);

  // 空窗口：没裁决也没跟踪项 → null（不写空摘要页）
  assert.equal(renderDeputyDigest({ db: fleetDb, fleet, since: 0 }), null, "空窗口返回 null");

  // 一条已裁决（批了没执行）+ 一条跟踪中
  const now = Date.now();
  const ruled = fleetDb.appendDecision({
    id: "d_dg_ruled", fleetId, memberId: "m_dg_worker", question: "周报是否附图",
    options: [{ value: "yes", label: "附图" }], severity: "normal", route: "deputy", category: "routine-ops",
  });
  fleetDb.transitionDecision(ruled.id, "open", {
    state: "approved", resolution: { kind: "approve", choice: "yes", note: null, by: "deputy:常务", at: now },
    resolvedAt: now, resolvedBy: "deputy", resolvedByModel: "observed-x", rulingEvidence: "主人 10 月判例：一律附图",
  });
  fleetDb.appendDecision({
    id: "d_dg_track", fleetId, memberId: "m_dg_worker", question: "排班是否改两班制",
    options: [{ value: "a", label: "A" }], severity: "normal", route: "deputy", category: "routine-ops",
  });

  const body = renderDeputyDigest({ db: fleetDb, fleet: fleetDb.getFleet(fleetId), since: now - 3600_000, now });
  assert.ok(body, "有内容时必须渲染");
  assert.match(body, /本期裁决 1 条/, "裁决计数");
  assert.match(body, /待执行 1 条/, "批了没执行可见");
  assert.match(body, /附图/, "批的选项 label");
  assert.match(body, /一律附图/, "依据摘要");
  assert.match(body, /跟踪中的问题单 1 条/, "跟踪项计数");
  assert.match(body, /最老一条已待/, "最老未决多久（spec 明写）");

  // 频率门：digest=off 不排期；daily 且刚跑过不排期；时点推进后到期
  fleetDb.setFleetDelegationPolicy(fleetId, {
    enabled: true, deputyMemberId: "m_dg_deputy", digest: "off", routes: { "routine-ops": "deputy" },
  });
  assert.equal(determineDueDeputyDigests({ db: fleetDb, now }).filter((d) => d.fleet.id === fleetId).length, 0, "off 不排期");
  fleetDb.setFleetDelegationPolicy(fleetId, {
    enabled: true, deputyMemberId: "m_dg_deputy", digest: "daily", routes: { "routine-ops": "deputy" },
  });
  assert.equal(determineDueDeputyDigests({ db: fleetDb, now }).filter((d) => d.fleet.id === fleetId).length, 1, "从未跑过即到期");
  fleetDb.setCellSetting("delegationDigestAt:" + fleetId, now);
  assert.equal(determineDueDeputyDigests({ db: fleetDb, now }).filter((d) => d.fleet.id === fleetId).length, 0, "刚跑过不到期");
  assert.equal(
    determineDueDeputyDigests({ db: fleetDb, now: now + 25 * 3600_000 }).filter((d) => d.fleet.id === fleetId).length,
    1, "过一天到期（停机后补跑语义）",
  );
});

test("deputy digest：写不进记忆时不推进时点（宁可迟到不可丢）", async () => {
  const { runDueDeputyDigests } = await import("../server/fleet-delegation-digest.js");
  const fleetId = "fleet_digest_fail";
  fleetDb.createFleet({ id: fleetId, name: "摘要失败舰队", ownerEmail: OWNER });
  fleetDb.createMember({
    id: "m_dgf_worker", fleetId, title: "岗", targetKind: "persona", targetId: "preset-dgfw",
    cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
  });
  fleetDb.createMember({
    id: "m_dgf_deputy", fleetId, title: "常务", targetKind: "persona", targetId: "preset-dgfd",
    cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", enabled: true },
  });
  fleetDb.setFleetDelegationPolicy(fleetId, {
    enabled: true, deputyMemberId: "m_dgf_deputy", digest: "daily", routes: { "routine-ops": "deputy" },
  });
  fleetDb.appendDecision({
    id: "d_dgf_1", fleetId, memberId: "m_dgf_worker", question: "有一条跟踪项就够渲染",
    options: [{ value: "a", label: "A" }], severity: "normal", route: "deputy", category: "routine-ops",
  });
  const now = Date.now();
  const out = await runDueDeputyDigests({
    db: fleetDb, now, log: { warn: () => {} },
    memoryClientFor: async () => null, // 记忆未配置
  });
  assert.equal(out.written, 0);
  assert.equal(
    Number(fleetDb.getCellSetting("delegationDigestAt:" + fleetId)) || 0, 0,
    "写不进去时不推进时点——下一 tick 重试",
  );
});

test("deputy：resetPrompt 把存量岗位的职责提示词升到当前版本", async () => {
  // 这条钉的是「提示词三级取值的决议」，不是 reconcile——reconcile 需要任务
  // 引擎，而这条用例与引擎无关。直接调路由用的同一个常量断言语义：
  //   promptTemplate 显式值 > resetPrompt=true → 当前 DEPUTY_PROMPT
  //   > 岗位既有值 > 当前版本
  const { DEPUTY_PROMPT_FOR_TEST } = await import("../server/routes/fleets.js").catch(() => ({}));
  // 模块未导出时从源码读常量（导出会无谓扩大 API 面）
  const src = fs.readFileSync(new URL("../server/routes/fleets.js", import.meta.url), "utf8");
  const m = src.match(/const DEPUTY_PROMPT\s*=\s*([\s\S]*?);\n/);
  assert.ok(m, "DEPUTY_PROMPT 常量必须在源码里");
  assert.match(m[1], /不要为此另做检索/, "当前版本已含判例就地用的收紧");
  assert.match(m[1], /缺判例不是不裁的理由/, "当前版本已含「缺判例也要裁」");
  // 决议逻辑本身（照抄路由实现，防止两边漂移）
  const pick = ({ explicit, resetPrompt, existing }) =>
    typeof explicit === "string" && explicit.trim()
      ? explicit.trim()
      : resetPrompt === true
        ? "NEW"
        : existing ?? "NEW";
  assert.equal(pick({ explicit: " 手写 ", resetPrompt: true, existing: "旧" }), "手写", "显式值最高优先");
  assert.equal(pick({ resetPrompt: true, existing: "旧" }), "NEW", "resetPrompt 覆盖既有值");
  assert.equal(pick({ existing: "旧" }), "旧", "都不传时保留既有值（不静默改写）");
  assert.equal(pick({}), "NEW", "新建无既有值 → 当前版本");
  void DEPUTY_PROMPT_FOR_TEST;
});

// ── 队列载荷必须带 detail（2026-11-10）──────────────────────────────────────
//
// 起因：撞墙原因、步骤数、工具名这些都写在 decision_items.detail 里，而队列
// 响应一直不带它——常务岗只能看着标题拍板，看不到提交方的证据。同一个
// 「写入点 ≠ 读出面」在本项目里已经出现过七次，所以这里钉一条形状断言：
// detail 必须在队列里，且提交时写进去的内容要原样读得回来。
test("deputy:队列带出 detail，提交方写的证据读得回来", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    fleetDb.appendDecision({
      id: "d_with_detail", fleetId: FLEET, memberId: WORKER,
      question: "要不要重跑取数", options: [{ value: "y", label: "重跑" }, { value: "n", label: "等" }],
      severity: "low", itemType: "routine-ops", route: "deputy", category: "routine-ops",
      detail: { steps: 9, lastTool: "read", contextWindow: 128000, cause: "single_round_too_large" },
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/queue", {});
    assert.equal(r.status, 200);
    const hit = (r.body?.queue ?? []).find((q) => q.id === "d_with_detail");
    assert.ok(hit, "队列里应当有这条");
    assert.equal(typeof hit.detail, "object", "队列项必须带 detail 对象，不能省略");
    assert.equal(hit.detail.cause, "single_round_too_large", "提交方写的 cause 要原样读回");
    assert.equal(hit.detail.contextWindow, 128000);
  } finally {
    server.close();
  }
});

// ── 并发下的岗位身份（fix-deputy-attribution-self-report）─────────────────────
//
// 2026-11-13 生产：9 支舰队各一个常务岗，节奏错开在 :05…:55 —— **同时两轮在飞
// 是常态**。这些路由原先只信「唯一在飞回合」，于是同一时刻有多轮在飞时全部 409，
// 常务岗一轮读不到队列，整轮烧在退避重试上，全库零裁决。修法不是放宽歧义判据
// （那会把报数记到别人的岗位上），而是让这些路由与 report_status 走同一条
// 自报身份通道——身份由服务端写进成员私有 patch，中继逐请求注入。
const FLEET_B = "fleet_dlg_2";
const DEPUTY_B = "m_deputy_b";

function twoRoundsInFlight() {
  // 两个不同舰队的回合同时在飞，正是生产里的常态。
  ctx.fleetTurnLedger = {
    openTurns: () => [
      { fleetId: FLEET, memberId: WORKER },
      { fleetId: FLEET_B, memberId: DEPUTY_B },
    ],
  };
}

test("deputy: 两轮在飞且不自报身份 → 诚实拒收（不猜）", async () => {
  const { server, call } = await startServer();
  try {
    twoRoundsInFlight();
    ctx.currentPreset = null; // 运行时全局值，不许拿来兜底
    const r = await call("POST", "/api/fleets/deputy/queue", {});
    assert.equal(r.status, 409);
    assert.match(String(r.body?.error ?? ""), /several rounds are in flight/i);
  } finally {
    ctx.fleetTurnLedger = null;
    server.close();
  }
});

test("deputy: 两轮在飞但自报身份 → 读到本舰队队列（并发是常态）", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.createFleet({ id: FLEET_B, name: "委托舰队B", ownerEmail: OWNER });
    fleetDb.createMember({
      id: DEPUTY_B, fleetId: FLEET_B, title: "常务B", targetKind: "persona", targetId: "preset-deputy-b",
      cadence: { cron: "10 * * * *", tz: "Asia/Shanghai", enabled: true },
    });
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    fleetDb.appendDecision({
      id: "d_concurrent", fleetId: FLEET, memberId: WORKER,
      question: "并发下这条能不能读到", options: [{ value: "y", label: "读" }, { value: "n", label: "不读" }],
      severity: "low", itemType: "routine-ops", route: "deputy", category: "routine-ops",
    });

    twoRoundsInFlight();
    ctx.currentPreset = null;

    const r = await call("POST", "/api/fleets/deputy/queue", {
      selfIdentity: { fleetId: FLEET, memberId: DEPUTY, persona: "preset-deputy" },
    });
    assert.equal(r.status, 200, `自报身份后应受理，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.fleet?.id, FLEET);
    assert.ok((r.body?.queue ?? []).some((q) => q.id === "d_concurrent"), "队列里应有本舰队的待裁项");
  } finally {
    ctx.fleetTurnLedger = null;
    server.close();
  }
});

test("deputy: 自报身份必须真实存在且 persona 一致，否则仍拒收", async () => {
  const { server, call } = await startServer();
  try {
    twoRoundsInFlight();
    ctx.currentPreset = null;
    // ① 不存在的 pair ② 存在但 persona 不一致 —— 两关都过不去就不能采信
    for (const selfIdentity of [
      { fleetId: FLEET, memberId: "m_ghost", persona: "preset-deputy" },
      { fleetId: FLEET, memberId: DEPUTY, persona: "someone-else" },
      { fleetId: "fleet_other", memberId: DEPUTY, persona: "preset-deputy" },
    ]) {
      const r = await call("POST", "/api/fleets/deputy/queue", { selfIdentity });
      assert.equal(r.status, 409, `伪造的身份不得被采纳：${JSON.stringify(selfIdentity)}`);
    }
  } finally {
    ctx.fleetTurnLedger = null;
    server.close();
  }
});

test("deputy: 两轮在飞 + 自报身份时裁决能落库", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    fleetDb.appendDecision({
      id: "d_concurrent_resolve", fleetId: FLEET, memberId: WORKER,
      question: "并发下这条能不能裁", options: [{ value: "y", label: "裁" }, { value: "n", label: "不裁" }],
      severity: "low", itemType: "routine-ops", route: "deputy", category: "routine-ops",
    });
    twoRoundsInFlight();
    ctx.currentPreset = null;
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: "d_concurrent_resolve",
      kind: "approve",
      choice: "y",
      evidence: "并发窗口内自报身份后裁决，依据：同类项此前均由主人批准",
      selfIdentity: { fleetId: FLEET, memberId: DEPUTY, persona: "preset-deputy" },
    });
    assert.equal(r.status, 200, `自报身份后应裁决成功，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.decision?.resolvedBy, "deputy");
    const got = fleetDb.getDecision?.("d_concurrent_resolve");
    assert.equal(got?.state, "approved", "裁决必须真的落库，不是只回了个 200");
  } finally {
    ctx.fleetTurnLedger = null;
    server.close();
  }
});

// ── 判例等级：主人裁决不缺声明也必须可引用（fix-precedent-grade-derivation）──
//
// 2026-11-13 实测：全库 346 条 decision_items 的 precedent_grade 一律是
// `deputy-ruled`，含两条主人亲裁（resolution.by = 主人邮箱）。原因是实时路径
// 只在调用方声明 `sourceKind` 时才判得出可引用等级，而管理面两处拍板 fetch 只发
// `{choice, note}` —— 又一个「字段只在服务端校验里存在、没人产出」。后果是判例集
// 永远为空，常务岗只能「无同类判例」自裁，学不到主人口径。
//
// 这组用例钉的是：**不带 sourceKind** 时，主人裁决也必须落可引用级。
test("判例: 主人不带 sourceKind 批准（选推荐值）→ owner-approved 可引用", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.appendDecision({
      id: "d_grade_appr", fleetId: FLEET, memberId: WORKER,
      question: "按推荐值批准的口径问题", options: [{ value: "y", label: "批准" }, { value: "n", label: "驳回" }],
      severity: "low", itemType: "routine-ops", route: "owner", category: "routine-ops",
      recommendation: "y",
    });
    const r = await call("POST", `/api/fleets/${FLEET}/decisions/d_grade_appr/approve`, {
      choice: "y", note: "同意",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const got = fleetDb.getDecision("d_grade_appr");
    assert.equal(got.state, "approved");
    assert.equal(got.precedentGrade, "owner-approved", "选推荐值＝规格定义的『原样发出代理的稿』，必须可引用");
  } finally {
    server.close();
  }
});

test("判例: 主人不带 sourceKind 选了另一项 → owner-authored 可引用", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.appendDecision({
      id: "d_grade_other", fleetId: FLEET, memberId: WORKER,
      question: "否决代理倾向的口径问题", options: [{ value: "y", label: "批准" }, { value: "n", label: "驳回" }],
      severity: "low", itemType: "routine-ops", route: "owner", category: "routine-ops",
      recommendation: "y",
    });
    const r = await call("POST", `/api/fleets/${FLEET}/decisions/d_grade_other/approve`, { choice: "n" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fleetDb.getDecision("d_grade_other").precedentGrade, "owner-authored");
  } finally {
    server.close();
  }
});

test("判例: 主人不带 sourceKind 驳回推荐 → owner-authored（驳回即不采纳推荐）", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.appendDecision({
      id: "d_grade_rej", fleetId: FLEET, memberId: WORKER,
      question: "驳回带推荐值的条目", options: [{ value: "y", label: "批准" }, { value: "n", label: "驳回" }],
      severity: "low", itemType: "routine-ops", route: "owner", category: "routine-ops",
      recommendation: "y",
    });
    const r = await call("POST", `/api/fleets/${FLEET}/decisions/d_grade_rej/reject`, { note: "不同意" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(
      fleetDb.getDecision("d_grade_rej").precedentGrade,
      "owner-authored",
      "带推荐值却被驳回＝主人独立判断；落 deputy-ruled 会把主人裁决废掉",
    );
  } finally {
    server.close();
  }
});

test("判例: 代理自裁仍不可引用（不能借这条通道洗白）", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy" }, maxSeverity: "high", dailyBudget: 20,
    });
    fleetDb.appendDecision({
      id: "d_grade_dep", fleetId: FLEET, memberId: WORKER,
      question: "常务岗自裁项", options: [{ value: "y", label: "批准" }, { value: "n", label: "驳回" }],
      severity: "low", itemType: "routine-ops", route: "deputy", category: "routine-ops", recommendation: "y",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: "d_grade_dep", kind: "approve", choice: "y", evidence: "例行",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fleetDb.getDecision("d_grade_dep").precedentGrade, "deputy-ruled");
  } finally {
    ctx.currentPreset = null;
    fleetDb.setCellSetting("delegationPolicy", { enabled: true, routes: { "routine-ops": "deputy" }, maxSeverity: "high" });
    server.close();
  }
});

test("policy: 未启用委托的舰队不产出无人可裁的条目（fix-mandate-write-preserves-deputy）", async () => {
  const { server, call } = await startServer();
  try {
    const OFF = "fleet_dlg_off";
    // cell 级 delegate 设置是全 cell 共享的，本文件前面的用例把它打开过——这里是
    // 「从未启用委托的舰队」，必须先把 cell 默认也关掉，否则测的是别人的状态。
    fleetDb.setCellSetting("delegationPolicy", { enabled: false });
    fleetDb.createFleet({ id: OFF, name: "未启用委托", ownerEmail: OWNER });
    fleetDb.createMember({
      id: "m_off_worker", fleetId: OFF, title: "投稿岗", targetKind: "persona", targetId: "preset-off-worker",
      cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", enabled: true },
    });
    ctx.currentPreset = "preset-off-worker";
    const r = await call("POST", "/api/fleets/escalate", {
      question: "未启用委托的舰队里一条本可委托的例行项",
      options: [{ value: "y", label: "做" }, { value: "n", label: "不做" }],
      severity: "low", category: "routine-ops",
    });
    assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
    const items = fleetDb.listDecisions({ fleetId: OFF, state: "open" });
    assert.equal(items.length, 1);
    assert.equal(
      items[0].route, "owner",
      "未启用委托就没有常务岗来裁；落 deputy 等于让这条永远过期",
    );
  } finally {
    ctx.currentPreset = null;
    fleetDb.setCellSetting("delegationPolicy", { enabled: true, routes: { "routine-ops": "deputy" }, maxSeverity: "high" });
    server.close();
  }
});

// ── 分诊档必须有人消费（fix-triage-lane-has-no-consumer）──────────────────────
//
// 实测（2026-11-14）：路由词典里有 `deputy-triage`，设置面能选，DEFAULT 更把它设为
// infra-ticket 的默认——但 decision_queue 只查 route='deputy'，全仓没有第二个读面。
// 于是 24 条 infra-ticket 横跨 10 支舰队压了三天，既不在主人角标（只计 owner），
// 也不在常务岗队列，等于「声明有人负责、实际无人可见」。
test("triage: 分诊档条目出现在常务岗队列里并标明处置方式", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setCellSetting("delegationPolicy", { enabled: true, routes: { "routine-ops": "deputy" }, maxSeverity: "high" });
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy", "infra-ticket": "deputy-triage" },
      maxSeverity: "high", dailyBudget: 20,
    });
    fleetDb.appendDecision({
      id: "d_triage_1", fleetId: FLEET, memberId: WORKER,
      question: "分诊档的问题单：取数通道超时", options: [{ value: "y", label: "处理" }],
      severity: "low", itemType: "infra-ticket", route: "deputy-triage", category: "infra-ticket",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/queue", {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const hit = (r.body?.queue ?? []).find((q) => q.id === "d_triage_1");
    assert.ok(hit, "分诊档条目必须进入队列——否则这条车道无人消费");
    assert.equal(hit.disposition, "triage");
    assert.equal(r.body?.triageCount, 1);
  } finally {
    ctx.currentPreset = null;
    server.close();
  }
});

test("triage: 对分诊项提交裁决被拒，且话术指向上报而不是「越权」", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy", "infra-ticket": "deputy-triage" },
      maxSeverity: "high", dailyBudget: 20,
    });
    fleetDb.appendDecision({
      id: "d_triage_2", fleetId: FLEET, memberId: WORKER,
      question: "分诊档条目不可裁决", options: [{ value: "y", label: "处理" }],
      severity: "low", itemType: "infra-ticket", route: "deputy-triage", category: "infra-ticket",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: "d_triage_2", kind: "approve", choice: "y", evidence: "试着裁一下",
    });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body?.code, "TRIAGE_NOT_RULABLE");
    assert.match(String(r.body?.error ?? ""), /triage lane/i);
    assert.match(String(r.body?.error ?? ""), /decision_escalate_to_owner/);
    assert.equal(fleetDb.getDecision("d_triage_2").state, "open", "被拒后条目必须原样保留");
  } finally {
    ctx.currentPreset = null;
    server.close();
  }
});

test("triage: 分诊项不消耗当日裁决预算", async () => {
  const { server, call } = await startServer();
  try {
    // 预算按「今日已用 + 1」动态设：本文件前面的用例今天也裁过，写死 1 会被它们吃光，
    // 测到的就不是「分诊项算不算」而是别人的残留。
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const used = fleetDb
      .listDecisions({ fleetId: FLEET })
      .filter((d) => d.resolvedBy === "deputy" && (d.resolvedAt ?? 0) > dayStart.getTime() && d.route !== "deputy-triage")
      .length;
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy", "infra-ticket": "deputy-triage" },
      maxSeverity: "high", dailyBudget: used + 1,
    });
    // 一条分诊项（resolved_by 手工写成 deputy，模拟带外数据漂移）
    fleetDb.appendDecision({
      id: "d_triage_budget", fleetId: FLEET, memberId: WORKER,
      question: "分诊项不该占预算", options: [{ value: "y", label: "处理" }],
      severity: "low", itemType: "infra-ticket", route: "deputy-triage", category: "infra-ticket",
    });
    fleetDb.transitionDecision?.("d_triage_budget", "open", {
      state: "approved", resolvedAt: Date.now(), resolvedBy: "deputy", precedentGrade: "deputy-ruled",
    });
    // 预算仍应可用：分诊项被排除了
    fleetDb.appendDecision({
      id: "d_rule_after", fleetId: FLEET, memberId: WORKER,
      question: "预算仍应可用", options: [{ value: "y", label: "批准" }, { value: "n", label: "驳回" }],
      severity: "low", itemType: "routine-ops", route: "deputy", category: "routine-ops",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/resolve", {
      itemId: "d_rule_after", kind: "approve", choice: "y", evidence: "预算内",
    });
    assert.equal(r.status, 200, `分诊项不该吃掉预算，实际 ${r.status} ${JSON.stringify(r.body)}`);
  } finally {
    ctx.currentPreset = null;
    server.close();
  }
});

test("triage: 分诊项可以上报主人（它没有裁决权，上报是它唯一出口）", async () => {
  const { server, call } = await startServer();
  try {
    fleetDb.setFleetDelegationPolicy(FLEET, {
      enabled: true, deputyMemberId: DEPUTY, routes: { "routine-ops": "deputy", "infra-ticket": "deputy-triage" },
      maxSeverity: "high", dailyBudget: 20,
    });
    fleetDb.appendDecision({
      id: "d_triage_esc", fleetId: FLEET, memberId: WORKER,
      question: "分诊项应能上报主人", options: [{ value: "y", label: "处理" }],
      severity: "low", itemType: "infra-ticket", route: "deputy-triage", category: "infra-ticket",
    });
    ctx.currentPreset = "preset-deputy";
    const r = await call("POST", "/api/fleets/deputy/escalate-to-owner", {
      itemId: "d_triage_esc", analysis: "同根因两单已归并，请主人定夺",
    });
    assert.equal(r.status, 200, `分诊项的唯一出口必须开着，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const got = fleetDb.getDecision("d_triage_esc");
    assert.equal(got.route, "owner", "上报后转回主人队列");
    assert.equal(got.state, "open", "仍待主人裁，不是已裁决");
    assert.ok(got.detail?.deputyAnalysis?.analysis, "分析必须随条目保存");
  } finally {
    ctx.currentPreset = null;
    server.close();
  }
});
