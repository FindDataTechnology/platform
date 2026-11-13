// 审计官与判例准入 smoke (widen-deputy-to-personal-domains 3.x / 2.3-2.4)
// Run: node --test scripts/test-personal-auditor.mjs

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auditor-"));
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.PLATFORM_DATA_DIR = tmp;
process.env.DSH_HOME = path.join(tmp, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

// Resolve the repo from THIS file, never from one machine's absolute path: the
// imports below must run AFTER the env vars above are set, so they stay
// dynamic — but a hardcoded /Users/… prefix makes the suite pass on exactly one
// laptop and ENOENT everywhere else (the first sharded CI run caught it).
const REPO = path.resolve(import.meta.dirname, "..");
const { initDb } = await import(pathToFileURL(path.join(REPO, "db.js")).href);
const { createFleetDatabase, setFleetDatabase } = await import(
  pathToFileURL(path.join(REPO, "server/routes/fleets-db.js")).href
);
const { auditorAllowedFor } = await import(pathToFileURL(path.join(REPO, "lib/auditor-tool-face.js")).href);
await initDb();
const f = createFleetDatabase({});
setFleetDatabase(f);

f.createFleet({ id: "f1", name: "审计舰队", ownerEmail: "o@t" });
// 无委托状 → 不允许审计官
assert.equal(auditorAllowedFor(f.getFleetMandatePolicy("f1")), false, "no mandate → no auditor");

// 配一个域之后允许
f.setCellMandatePolicy({ version: 2, domains: { ops: { mode: "draft" } } });
assert.equal(auditorAllowedFor(f.getFleetMandatePolicy("f1")), true);

// 判例准入：deputy-ruled 不进判例；owner-authored 进
const mk = (id, extra) => f.appendDecision({
  id, fleetId: "f1", memberId: "m1", question: "q-" + id, options: [{ value: "a" }],
  route: "deputy", category: "routine-ops", ...extra,
});
mk("d1");
f.transitionDecision("d1", "open", { state: "delivered", resolvedBy: "deputy", resolvedAt: Date.now(), resolution: { choice: "a" }, precedentGrade: "deputy-ruled" });
mk("d2");
f.transitionDecision("d2", "open", { state: "delivered", resolvedBy: "owner", resolvedAt: Date.now(), resolution: { choice: "a" }, precedentGrade: "owner-authored" });

const citable = f.listCitablePrecedents({ fleetId: "f1" });
assert.deepEqual(citable.map((d) => d.id), ["d2"], "deputy-ruled must not be citable");

// 反例：被驳回的那条
mk("d3", { recommendation: "a" });
f.transitionDecision("d3", "open", { state: "rejected", resolvedBy: "owner", resolvedAt: Date.now(), resolution: { choice: null }, precedentGrade: "owner-authored" });
const overruled = f.listOverruledDecisions({ fleetId: "f1" });
assert.deepEqual(overruled.map((d) => d.id), ["d3"]);

// 一致率：d3 推荐 a 却被驳回 → 0/1
const stats = f.decisionConsistency({ fleetId: "f1" });
console.log("consistency:", JSON.stringify(stats));
assert.equal(stats.samples, 1);
assert.equal(stats.agrees, 0);

console.log("AUDITOR SMOKE OK");

// ── 1.2 / 1.4 事项接入：默认全关；开启后落域 ─────────────────────────────────

const { domainFor } = await import("../lib/personal-domain-map.js");

assert.deepEqual(
  f.getPersonalDomainMap().map((e) => e.enabled),
  [false, false, false],
  "默认全关：升级不动任何行为",
);
assert.equal(domainFor(f.getPersonalDomainMap(), "cross-line-blocker"), null);

const saved = f.setPersonalDomainMap([{ source: "cross-line-blocker", enabled: true }]);
assert.ok(saved);
assert.equal(domainFor(saved, "cross-line-blocker"), "ops");
assert.equal(domainFor(saved, "supplier-thread"), null, "未开启的源不落域");

// 未知域名的映射一律拒绝，不落半截配置
assert.equal(f.setPersonalDomainMap([{ source: "supplier-thread", domain: "ext-comms" }]), null);
assert.equal(domainFor(f.getPersonalDomainMap(), "supplier-thread"), null);

// 落域后条目带 domain；未命中保持 null（既有车道不变）
f.appendDecision({
  id: "dom_hit", fleetId: "f1", memberId: "m1", question: "跨线阻塞：A 仓等 B 仓的接口",
  options: [{ value: "a" }], route: "deputy", category: "routine-ops", domain: "ops",
});
f.appendDecision({
  id: "dom_miss", fleetId: "f1", memberId: "m1", question: "普通拍板",
  options: [{ value: "a" }], route: "owner", category: "routine-ops",
});
assert.equal(f.getDecision("dom_hit").domain, "ops");
assert.equal(f.getDecision("dom_miss").domain, null);

console.log("DOMAIN MAP OK");

// ── 4.x 判例候选：永不直接生效、去重、拒绝理由可读 ──────────────────────────

const p1 = f.proposePrecedentCandidate({ fleetId: "f1", domain: "advancement", ruleText: "同类交期请求最多延 1 天，且需书面确认" });
assert.equal(p1.ok, true);
assert.equal(p1.candidate.status, "candidate");
// 候选绝不进入可引用集
assert.deepEqual(f.listApprovedPrecedentRules({ fleetId: "f1" }), []);

// 重复提议不新建，把既有那条交回去
const p2 = f.proposePrecedentCandidate({ fleetId: "f1", domain: "advancement", ruleText: "  同类交期请求最多延 1 天，且需书面确认 " });
assert.equal(p2.ok, false);
assert.equal(p2.code, "duplicate");
assert.equal(p2.existing.id, p1.candidate.id);

// 拒绝必须带理由，且理由要能被审计官读到
f.decidePrecedentCandidate(p1.candidate.id, { approve: false, by: "o@t", reason: "交期视客户等级而定" });
assert.equal(f.getPrecedentCandidate(p1.candidate.id).status, "rejected");
const rejections = f.listPrecedentRejections({ fleetId: "f1" });
assert.equal(rejections.length, 1);
assert.match(rejections[0].rejectReason, /客户等级/);
assert.deepEqual(f.listApprovedPrecedentRules({ fleetId: "f1" }), [], "被拒的候选仍不可引用");

// 批准后才可引用；且不能再被重复决策
const p3 = f.proposePrecedentCandidate({ fleetId: "f1", domain: "ops", ruleText: "跨线阻塞超过两天必须升级到主人" });
f.decidePrecedentCandidate(p3.candidate.id, { approve: true, by: "o@t" });
const approved = f.listApprovedPrecedentRules({ fleetId: "f1" });
assert.equal(approved.length, 1);
assert.match(approved[0].ruleText, /跨线阻塞/);
const again = f.decidePrecedentCandidate(p3.candidate.id, { approve: false, by: "o@t", reason: "x" });
assert.equal(again.ok, false);

console.log("PRECEDENT CANDIDATES OK");

// ── 5.1 类别禁令只属于 ops 域；个人域按委托状是否授予决定 ───────────────────

const { routeForItem, normalizeDelegationPolicy } = await import("../server/routes/fleets-db.js");
const { agentMayHandle } = await import("../lib/personal-mandate.js");
const pol = normalizeDelegationPolicy({ enabled: true }, null);

// ops 域：三类高风险永远主人（既有语义不动，归一化后 routes 里就是 owner）
for (const cat of ["config-change", "hr", "spend"]) {
  assert.equal(routeForItem({ category: cat, severity: "low" }, pol), "owner", `${cat} 在 ops 车道必须锁 owner`);
}

// 个人域：路由不查类别表，而看委托状是否真给了权限
const adviseOnly = { version: 2, domains: { advancement: { mode: "advise" } } };
const drafts = { version: 2, domains: { advancement: { mode: "draft" } } };
assert.equal(agentMayHandle(adviseOnly, "advancement"), false, "advise 不是授权");
assert.equal(agentMayHandle(drafts, "advancement"), true);
assert.equal(agentMayHandle(drafts, "external-comms"), false, "未配置的域不因别处授权而获得权限");

// ── 5.3 放量闸：样本不足或一致率不够，服务端拒绝升 act-notify ────────────────

const { canPromoteToAuto } = await import("../lib/precedent-grade.js");
assert.equal(canPromoteToAuto({ samples: 0, rate: null }).ok, false);
assert.equal(canPromoteToAuto({ samples: 5, rate: 1 }).reason, "insufficient_samples");
assert.equal(canPromoteToAuto({ samples: 50, rate: 0.5 }).reason, "rate_below_threshold");
assert.equal(canPromoteToAuto({ samples: 50, rate: 0.85 }).ok, true);

console.log("BOUNDARIES OK");

// ── 6.4 端到端：开映射 → 落域 → 主人改写 → 候选出现且未生效 ─────────────────

{
  const { routeForItem, normalizeDelegationPolicy } = await import("../server/routes/fleets-db.js");
  const { classifyProvenance } = await import("../lib/precedent-grade.js");
  const fleetId = "f_e2e";
  try {
    f.createFleet({ id: fleetId, name: "E2E", ownerEmail: "o@t" });
  } catch {
    /* already created by a previous run in the same process */
  }
  f.setPersonalDomainMap([{ source: "cross-line-blocker", enabled: true }]);
  const domain = domainFor(f.getPersonalDomainMap(), "cross-line-blocker");
  assert.equal(domain, "ops");

  f.setCellMandatePolicy({ version: 2, domains: { ops: { mode: "draft", enabled: true } } });
  const policy = f.getFleetMandatePolicy(fleetId);
  assert.equal(policy.domains.ops.mode, "draft");
  assert.equal(agentMayHandle(policy, domain), true);

  f.appendDecision({
    id: "e2e_d1", fleetId, memberId: "m1", question: "A 仓等 B 仓接口，卡了两天",
    options: [{ value: "wait" }, { value: "escalate" }], recommendation: "wait",
    route: "deputy", category: "routine-ops", domain,
  });
  assert.equal(f.getDecision("e2e_d1").domain, "ops");

  f.transitionDecision("e2e_d1", "open", {
    state: "rejected", resolvedAt: Date.now(), resolvedBy: "owner",
    resolution: { choice: null, detail: "两天就升级" },
    precedentGrade: classifyProvenance({ resolvedBy: "owner", sourceKind: "agent-draft", amended: true }),
  });
  assert.equal(f.getDecision("e2e_d1").precedentGrade, "deputy-ruled", "改过的稿不可作判例");

  const cand = f.proposePrecedentCandidate({
    fleetId, domain: "ops", ruleText: "跨线阻塞超过两天直接升级到主人，不要等对方",
    sourceDecisionId: "e2e_d1",
  });
  assert.equal(cand.ok, true);
  assert.deepEqual(f.listApprovedPrecedentRules({ fleetId }), [], "候选未生效");
  assert.deepEqual(f.listCitablePrecedents({ fleetId }), [], "也不进判例集");

  const stats = f.decisionConsistency({ fleetId, domain: "ops" });
  assert.equal(stats.agrees, 0);
  assert.equal(canPromoteToAuto(stats).ok, false, "样本不足不得升 act-notify");

  // ops 域的类别禁令不动
  assert.equal(routeForItem({ category: "spend", severity: "low" }, normalizeDelegationPolicy(null, null)), "owner");
  console.log("LANE A E2E OK");
}


// ── 2.4 被拦记录进摘要（沉默的失败必须有个数字） ─────────────────────────────

{
  const { renderDeputyDigest } = await import("../server/fleet-delegation-digest.js");
  const fleetId = "f_digest";
  try { f.createFleet({ id: fleetId, name: "摘要", ownerEmail: "o@t" }); } catch { /* exists */ }
  f.recordMandateViolation("external-comms", "disclose");
  f.recordMandateViolation("external-comms", "disclose");
  f.recordMandateViolation("ops", "quota");
  const body = renderDeputyDigest({ db: f, fleet: { id: fleetId, name: "摘要" }, since: Date.now() - 3600_000, now: Date.now() });
  assert.ok(body, "只有被拦记录的窗口也应有摘要——否则沉默看起来像健康");
  assert.match(body, /今日被闸挡下/);
  assert.match(body, /披露越界 × 2/);
  assert.match(body, /额度耗尽 × 1/);
  console.log("BLOCKED-IN-DIGEST OK");
}

// ── 1.3b 旁路尝试进同一本越界计数，并被摘要看见 ─────────────────────────────

{
  const { renderDeputyDigest } = await import("../server/fleet-delegation-digest.js");
  const fleetId = "f_bypass";
  try { f.createFleet({ id: fleetId, name: "旁路", ownerEmail: "o@t" }); } catch { /* exists */ }
  f.recordMandateViolation(null, "bypass");
  f.recordMandateViolation(null, "bypass");
  const body = renderDeputyDigest({ db: f, fleet: { id: fleetId, name: "旁路" }, since: Date.now() - 3600_000, now: Date.now() });
  assert.ok(body, "只有旁路记录的窗口也要有摘要");
  assert.match(body, /旁路尝试 × 2/, "旁路必须出现在摘要里——只有写入没有消费的告警等于没有告警");
  console.log("BYPASS-IN-DIGEST OK");
}

// ── 缺陷回归：recommendation 必须读自己的列，不是 resolution ─────────────────

{
  const fleetId = "f_rec";
  try { f.createFleet({ id: fleetId, name: "推荐", ownerEmail: "o@t" }); } catch { /* exists */ }
  f.appendDecision({
    id: "rec_1", fleetId, memberId: "m1", question: "选哪个",
    options: [{ value: "a" }, { value: "b" }], recommendation: "a", route: "owner",
  });
  assert.equal(f.getDecision("rec_1").recommendation, "a", "未决事项必须带回推荐值（此前恒为 null）");
  f.transitionDecision("rec_1", "open", {
    state: "approved", resolvedAt: Date.now(), resolvedBy: "owner", resolution: { choice: "b" },
  });
  const done = f.getDecision("rec_1");
  assert.equal(done.recommendation, "a", "已决之后推荐值仍是推荐值，不能变成 resolution 的 JSON");
  assert.equal(done.resolution.choice, "b", "裁决结果仍在 resolution 里");
  // 一致率正是靠这个字段，缺陷会让它把什么都算成不一致
  const stats = f.decisionConsistency({ fleetId });
  assert.equal(stats.samples, 1);
  assert.equal(stats.agrees, 0, "推荐 a 却批了 b = 不一致");
  console.log("RECOMMENDATION-COLUMN OK");
}

// ── 就绪检查端点（2026-11-10）───────────────────────────────────────────────

{
  const express = (await import("express")).default;
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const app = express();
  app.use(express.json());
  try { f.createFleet({ id: "f_ready", name: "就绪", ownerEmail: "o@t" }); } catch { /* exists */ }
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "o@t", currentPreset: null });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    f.setCellMandatePolicy({ version: 2, domains: { ops: { mode: "advise" } } });
    f.setPersonalDomainMap([]);
    const r1 = await fetch(`${base}/api/fleets/personal-agent/readiness`).then((r) => r.json());
    assert.equal(r1.ready, false, "全 advise + 全关来源必须判不可用");
    assert.ok(r1.verdict.includes("还不能用"), r1.verdict);
    assert.ok(r1.items.every((i) => typeof i.fix === "string" && i.fix.length > 5), "每条都要带修法");

    // 配上授权 + 开一个来源（并设 auto 以触发令牌检查）
    f.setCellMandatePolicy({ version: 2, domains: { ops: { mode: "draft" } } });
    f.setPersonalDomainMap([{ source: "cross-line-blocker", enabled: true }]);
    const r2 = await fetch(`${base}/api/fleets/personal-agent/readiness`).then((r) => r.json());
    assert.equal(r2.ready, true, "draft + 已开来源应可跑（判例/审计官只是 warn）");
    assert.ok(r2.warns >= 1);
    console.log("READINESS ENDPOINT OK", JSON.stringify({ ready: r2.ready, warns: r2.warns }));
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// ── 配置体检进摘要（2026-11-10）────────────────────────────────────────────

{
  const { renderDeputyDigest } = await import("../server/fleet-delegation-digest.js");
  const fleetId = "f_ready_digest";
  try { f.createFleet({ id: fleetId, name: "体检", ownerEmail: "o@t" }); } catch { /* exists */ }

  // 配好：不该出现「还不能用」
  f.setCellMandatePolicy({ version: 2, domains: { ops: { mode: "draft" } } });
  f.setPersonalDomainMap([{ source: "cross-line-blocker", enabled: true }]);
  const okBody = renderDeputyDigest({ db: f, fleet: { id: fleetId, name: "体检" }, since: Date.now() - 3600_000, now: Date.now() });
  assert.equal(/还不能用/.test(okBody ?? ""), false, "配好了就不该在摘要里报不可用");

  // 配坏（收回授权 + 关来源）：必须在摘要里说出来
  f.setCellMandatePolicy({ version: 2, domains: { ops: { mode: "advise" } } });
  f.setPersonalDomainMap([]);
  // 注：空窗口仍不写空页（既有合同）。所以这里先制造一条本期事件（被拦记录），
  // 让摘要成立，再断言体检随附——体检是常驻状态，不该单独触发一期。
  f.recordMandateViolation("ops", "quota");
  const badBody = renderDeputyDigest({ db: f, fleet: { id: fleetId, name: "体检" }, since: Date.now() - 3600_000, now: Date.now() });
  assert.ok(badBody, "本期有内容时摘要必须成立");
  assert.match(badBody, /配置体检: 还不能用/);
  assert.match(badBody, /至少一个域被授予了权限/);
  assert.match(badBody, /→|——/, "要带修法，不能只报问题");
  console.log("READINESS-IN-DIGEST OK");
}

// ── 坞面行带就绪摘要（2026-11-10）─────────────────────────────────────────

{
  const express = (await import("express")).default;
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const fleetId = "f_board_ready";
  try { f.createFleet({ id: fleetId, name: "坞面", ownerEmail: "o@t" }); } catch { /* exists */ }
  f.setCellMandatePolicy({ version: 2, domains: { ops: { mode: "advise" } } });
  f.setPersonalDomainMap([]);

  const app = express();
  app.use(express.json());
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "o@t", currentPreset: null });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const board = await fetch(`${base}/api/fleets/owner/board`).then((r) => r.json());
    const row = (board.fleets ?? []).find((x) => x.id === fleetId);
    assert.ok(row, "坞面应含该舰队");
    assert.equal(row.personalAgent?.ready, false, "未配置时坞面行必须说不可用");
    assert.ok(row.personalAgent.blocked >= 1);
    assert.match(row.personalAgent.verdict, /还不能用/);
    console.log("BOARD-READINESS OK");
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// ── 审计官在「按 persona 分流」的各处不许漏（2026-11-10）──────────────────

{
  const { isPersonaBackedTargetKind, PERSONA_BACKED_KINDS } = await import("../server/routes/fleets-db.js");
  assert.deepEqual([...PERSONA_BACKED_KINDS].sort(), ["auditor", "persona"]);
  assert.equal(isPersonaBackedTargetKind("auditor"), true);
  assert.equal(isPersonaBackedTargetKind("persona"), true);
  for (const k of ["cluster", "a2a", "tool", "bot", undefined, null]) {
    assert.equal(isPersonaBackedTargetKind(k), false, `${k} 不是 persona 承载`);
  }

  // 归因：审计官岗位的回合必须能被归因，否则它的「阻断并上报」说不了话
  const { resolveAttribution } = await import("../server/fleet-reports.js");
  const auditorMember = { id: "m_aud", fleetId: "f", title: "审计官", targetKind: "auditor", targetId: "preset-aud" };
  const hits = resolveAttribution({ currentPreset: "preset-aud", personaMembers: [auditorMember] });
  assert.equal(hits.kind, "preset", "审计官回合必须归因到岗位");
  assert.equal(hits.memberId, "m_aud");
  console.log("AUDITOR-ATTRIBUTION OK");
}

// ── 审计官不进工作图（2026-11-10 定则）────────────────────────────────────

{
  const { validateOrchestration } = await import("../server/fleet-orchestration.js");
  const members = [
    { id: "lead", parentId: null, targetKind: "persona" },
    { id: "worker", parentId: "lead", targetKind: "persona" },
    { id: "aud", parentId: "lead", targetKind: "auditor" },
  ];
  const has = (orch) => {
    const r = validateOrchestration({ members, orchestration: orch });
    return (r.errors ?? []).some((e) => e.code === "auditor_not_orchestratable");
  };

  assert.equal(has({ edges: [{ kind: "handoff", from: "worker", to: "aud" }] }), true, "审计官不能作为 handoff 下游");
  assert.equal(has({ edges: [{ kind: "handoff", from: "aud", to: "worker" }] }), true, "审计官不能作为 handoff 上游");
  assert.equal(has({ edges: [{ kind: "dispatch", from: "aud", to: "worker" }] }), true, "审计官不能派活");
  assert.equal(has({ edges: [{ kind: "event", from: "bot:b1", to: "aud" }] }), true, "审计官不能被事件边唤醒");
  assert.equal(
    has({ edges: [{ kind: "fanout", from: "lead", targets: ["worker", "aud"], aggregate: { kind: "all" } }] }),
    true,
    "审计官不能作为 fanout 目标",
  );
  assert.equal(
    has({ edges: [{ kind: "fanout", from: "lead", targets: ["worker", "lead"], aggregate: { kind: "judge", judge: "aud" } }] }),
    true,
    "审计官不能当 fanout 裁判",
  );

  // 正常编排不受影响
  assert.equal(has({ edges: [{ kind: "handoff", from: "lead", to: "worker" }] }), false, "普通 handoff 不受影响");
  console.log("AUDITOR-NOT-ORCHESTRATABLE OK");
}

// ── 兜底分支只归 a2a：未知类型必须判 dead，不能悄悄当 a2a ───────────────────

{
  const { resolveFleetTarget } = await import("../server/routes/fleets.js");
  // 未知类型：坏得响（alive=false），而不是按 a2a 解析出一个假活
  const unknown = resolveFleetTarget({ targetKind: "hologram", targetId: "x1" });
  assert.equal(unknown.alive, false, "未知岗位类型必须判 dead");
  assert.equal(unknown.label, "x1", "仍应回显 targetId，便于定位");
  // 审计官走 persona 解析链（已在别处钉住 alive 语义），这里只确认它不再落到 a2a 兜底
  const aud = resolveFleetTarget({ targetKind: "auditor", targetId: "preset-not-in-roster" });
  // persona 族的解析结果本来就不带 servingPath（消费者在边界上 `?? null` 归一），
  // 所以这里断言语义而不是形状：不许有服务路径。
  assert.ok(!aud.servingPath, "审计官不应产出 a2a 服务路径");
  console.log("RESOLVER-FALLTHROUGH OK");
}

// ── 审计官真能提交结论（2026-11-10）────────────────────────────────────────
//
// 此前只有「主人代发」的 owner 路由，审计官自己的回合**没有任何途径**提交三态
// 结论：岗位建得出来、归因也通，但工具面里 auditor_submit_verdict 只写在允许
// 清单里，fleet-mcp 根本没有这个工具。门在、锁在、走廊没修。

{
  const express = (await import("express")).default;
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const fleetId = "f_aud_bridge";
  try { f.createFleet({ id: fleetId, name: "审计桥", ownerEmail: "o@t" }); } catch { /* exists */ }
  f.setCellMandatePolicy({ version: 2, domains: { ops: { mode: "draft" } } });
  try {
    f.createMember({
      id: "m_aud_bridge", fleetId, title: "审计官", targetKind: "auditor", targetId: "preset-aud",
      cadence: { cron: "0 * * * *", tz: "Asia/Shanghai", enabled: true },
    });
  } catch { /* exists */ }
  f.appendDecision({
    id: "aud_d1", fleetId, memberId: "m_worker", question: "要不要延期",
    options: [{ value: "yes" }, { value: "no" }], route: "deputy", category: "routine-ops", domain: "ops",
  });

  const app = express();
  app.use(express.json());
  // currentPreset 指向审计官岗位的 preset —— 与 deputy 用例同款归因路径
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "o@t", currentPreset: "preset-aud" });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (body) =>
    fetch(`${base}/api/fleets/auditor/verdict`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    // 异议必须带理由
    const noReason = await post({ itemId: "aud_d1", verdict: "dissent" });
    assert.equal(noReason.status, 400, "dissent 必须带理由");

    // 合法异议：留痕但不阻断
    const dissent = await post({ itemId: "aud_d1", verdict: "dissent", note: "上次同类是拒绝的" });
    assert.equal(dissent.status, 200, JSON.stringify(dissent.body));
    const afterDissent = f.getDecision("aud_d1");
    assert.equal(afterDissent.auditorVerdict, "dissent");
    assert.equal(afterDissent.state, "open", "异议不阻断");

    // 阻断：转回主人并保持 open
    const block = await post({ itemId: "aud_d1", verdict: "block", note: "与主人过往判例冲突" });
    assert.equal(block.status, 200, JSON.stringify(block.body));
    const afterBlock = f.getDecision("aud_d1");
    assert.equal(afterBlock.auditorVerdict, "block");
    assert.equal(afterBlock.route, "owner", "阻断必须转回主人");
    assert.equal(afterBlock.state, "open", "阻断不终局");
    console.log("AUDITOR-BRIDGE OK");
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// ── 主人手动记录结论的那条路也要能改路由（同一个静默丢弃）───────────────

{
  const express = (await import("express")).default;
  const { createFleetRoutes } = await import("../server/routes/fleets.js");
  const fleetId = "f_aud_owner";
  try { f.createFleet({ id: fleetId, name: "审计主人", ownerEmail: "o@t" }); } catch { /* exists */ }
  f.appendDecision({
    id: "aud_o1", fleetId, memberId: "m1", question: "要不要涨价",
    options: [{ value: "yes" }], route: "deputy", category: "routine-ops", domain: "ops",
  });
  const app = express();
  app.use(express.json());
  createFleetRoutes(app, { authEnabled: false, cellUserEmail: "o@t", currentPreset: null });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await fetch(`${base}/api/fleets/${fleetId}/decisions/aud_o1/auditor`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "block", note: "与判例冲突" }),
    }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => ({})) }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const item = f.getDecision("aud_o1");
    assert.equal(item.auditorVerdict, "block");
    assert.equal(item.route, "owner", "主人记录的阻断同样必须转回主人（同一条 patch 白名单）");
    console.log("AUDITOR-OWNER-ROUTE OK");
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

// ── 岗位提示里必须出现 category 指引（2026-11-10）──────────────────────────
//
// 生产实测：某舰队 100 条拍板里 98 条 category 为 null，而路由靠它决定给谁。
// 根因没有任何地方告诉岗位这个词存在——所以这行必须出现在**每条**自我块里，
// 无论岗位有没有往轮记录、有没有声明槽位。

{
  const { renderSelfBlock } = await import("../server/fleet-context.js");
  const hint = /escalate 请带 category/;
  assert.ok(hint.test(renderSelfBlock({ kpiSlots: [] }, [])), "无往轮无槽位时也要有");
  assert.ok(hint.test(renderSelfBlock({ kpiSlots: [{ key: "a", label: "A" }] }, [])), "有槽位时也要有");
  const round = { reports: [{ submittedAt: Date.now(), summary: "x", metrics: {}, status: "ok" }] };
  assert.ok(hint.test(renderSelfBlock({ kpiSlots: [] }, [round])), "有往轮时也要有");
  // 五个类别都得点名，否则岗位只知道其中几个
  const body = renderSelfBlock({ kpiSlots: [] }, []);
  for (const c of ["routine-ops", "infra-ticket", "config-change", "hr", "spend"]) {
    assert.ok(body.includes(c), `提示里必须点名 ${c}`);
  }
  console.log("ESCALATE-CATEGORY-HINT OK");
}
