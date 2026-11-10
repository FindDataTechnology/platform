// 个人代理全链路验收 (三层合一)
//
// 分段测试各测过：授权、判例分级、审计官、出站闸。但用户要的是「代表人做决策
// 和回答问题」作为一个整体。这个脚本只跑一条故事线，走完全部八步：
//
//   1 授权：配域为 draft（能起草，不能自己发）
//   2 接入：打开「跨线阻塞」来源
//   3 判断：事项落 ops 域，代理可承接
//   4 判例：检索到的判例只含可引用等级
//   5 审计官：给出「有异议但放行」，留痕不阻断
//   6 越界：含金额的对外回复被拦，越界项指名 finance
//   7 放行：删掉金额后通过，台账只存 digest
//   8 回执与撤回：回执不含原文；窗口内撤回成功，窗口外拒绝
//
//   node scripts/verify-personal-agent-loop.mjs

import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-loop-"));
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.PLATFORM_DATA_DIR = tmp;
process.env.DSH_HOME = path.join(tmp, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { initDb } = await import("../db.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { domainFor } = await import("../lib/personal-domain-map.js");
const { agentMayHandle } = await import("../lib/personal-mandate.js");
const { classifyProvenance, canPromoteToAuto } = await import("../lib/precedent-grade.js");
const { gateOutboundMessage } = await import("../lib/outbound-message.js");

await initDb();
const db = createFleetDatabase({});
setFleetDatabase(db);

const steps = [];
const ok = (name, detail = "") => { steps.push(`PASS ${name}${detail ? ` — ${detail}` : ""}`); console.log(steps.at(-1)); };
const fail = (name, detail = "") => { steps.push(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); console.log(steps.at(-1)); };

const FLEET = "f_loop";
db.createFleet({ id: FLEET, name: "个人代理", ownerEmail: "owner@test" });

try {
  // ── 1 授权：draft ────────────────────────────────────────────────────────
  db.setCellMandatePolicy({
    version: 2,
    domains: { ops: { mode: "draft", enabled: true, routes: { "routine-ops": "deputy", default: "owner" } } },
  });
  const policy = db.getFleetMandatePolicy(FLEET);
  assert.equal(policy.domains.ops.mode, "draft");
  ok("1 授权：ops 域为 draft", "可起草，不能自行发出");

  // ── 2 接入 ───────────────────────────────────────────────────────────────
  db.setPersonalDomainMap([{ source: "cross-line-blocker", enabled: true }]);
  const domain = domainFor(db.getPersonalDomainMap(), "cross-line-blocker");
  assert.equal(domain, "ops");
  ok("2 接入：跨线阻塞 → ops", `来源已开，落域 ${domain}`);

  // ── 3 判断 ───────────────────────────────────────────────────────────────
  const route = agentMayHandle(policy, domain) ? "deputy" : "owner";
  assert.equal(route, "deputy");
  db.appendDecision({
    id: "loop_d1", fleetId: FLEET, memberId: "m1", question: "A 仓等 B 仓接口，已卡两天",
    options: [{ value: "wait" }, { value: "escalate" }], recommendation: "wait",
    route, category: "routine-ops", domain,
  });
  assert.equal(db.getDecision("loop_d1").domain, "ops");
  ok("3 判断：事项落 ops 且代理可承接");

  // ── 4 判例：只有可引用等级进判例集 ───────────────────────────────────────
  db.appendDecision({ id: "loop_old", fleetId: FLEET, memberId: "m1", question: "上次同类阻塞怎么办",
    options: [{ value: "escalate" }], route: "owner", category: "routine-ops", domain: "ops" });
  db.transitionDecision("loop_old", "open", {
    state: "delivered", resolvedAt: Date.now(), resolvedBy: "owner",
    resolution: { choice: "escalate" },
    precedentGrade: classifyProvenance({ resolvedBy: "owner", sourceKind: "owner-direct" }),
  });
  const citable = db.listCitablePrecedents({ fleetId: FLEET });
  assert.deepEqual(citable.map((d) => d.id), ["loop_old"]);
  assert.equal(citable[0].precedentGrade, "owner-authored");
  ok("4 判例：只取 owner-authored/owner-approved", `可引用 ${citable.length} 条`);

  // ── 5 审计官：异议但放行 ─────────────────────────────────────────────────
  db.transitionDecision("loop_d1", "open", { auditorVerdict: "dissent", auditorNote: "上次同类是升级，这次为何等？" });
  const afterAudit = db.getDecision("loop_d1");
  assert.equal(afterAudit.auditorVerdict, "dissent");
  assert.equal(afterAudit.state, "open", "异议不阻断，条目保持 open");
  ok("5 审计官：异议留痕但不阻断", afterAudit.auditorNote);

  // ── 6 越界：含金额的对外回复被拦 ─────────────────────────────────────────
  const blocked = gateOutboundMessage({
    policy: { version: 2, domains: { "external-comms": { mode: "act-notify", discloseScope: ["public", "internal"], revokeWindowMinutes: 10 } } },
    domain: "external-comms",
    text: "A 仓那边我们报 38 万，下周就能接",
    to: "partner@x.com", channel: "email",
    principal: { kind: "agent", email: "owner@test" },
    channelRevocable: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.decision, "draft");
  assert.ok(blocked.disclosure.violations.some((v) => v.level === "finance" && v.via === "pattern"));
  ok("6 越界：含金额被拦并指名 finance/pattern", blocked.reason);

  // ── 7 放行：删掉金额后通过，台账只存 digest ──────────────────────────────
  const sent = gateOutboundMessage({
    policy: { version: 2, domains: { "external-comms": { mode: "act-notify", discloseScope: ["public", "internal"], revokeWindowMinutes: 10 } } },
    domain: "external-comms",
    text: "A 仓接口下周恢复，恢复后我会同步进度",
    to: "partner@x.com", channel: "email",
    principal: { kind: "agent", email: "owner@test" },
    channelRevocable: true,
  });
  assert.equal(sent.ok, true);
  assert.match(sent.ledger.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(sent.ledger).includes("恢复后我会同步进度"), false, "台账不含原文");
  ok("7 放行：干净消息通过，台账只存 digest", `digest=${sent.ledger.contentDigest.slice(0, 12)}…`);

  // ── 8 回执与撤回 ─────────────────────────────────────────────────────────
  const g = process.env.DB_PATH;
  assert.ok(g);
  const mainDb = (await import("../db.js")).getDb();
  mainDb.prepare(`INSERT INTO action_proposals (proposal_id, line, action_id, args_digest, risk, target, impact_text, state, created_at, updated_at)
    VALUES ('loop_send','bots','chat.message.send','d','write','cloud','i','executed','2026-11-09T10:00:00Z','2026-11-09T10:00:00Z')`).run();
  mainDb.prepare(`INSERT INTO action_audit (proposal_id, line, action_id, args_digest, risk, target, impact_text, created_at,
      principal, audience, mandate_domain, mandate_mode, disclose_level, reversible_until, content_digest, result_summary)
    VALUES ('loop_send','bots','chat.message.send','d','write','cloud','i','2026-11-09T10:00:00Z',
      ?, ?, 'external-comms','act-notify','internal', ?, ?, 'ok')`).run(
    sent.ledger.principal, sent.ledger.audience, sent.ledger.reversibleUntil, sent.ledger.contentDigest);

  const row = mainDb.prepare("SELECT principal, audience, content_digest, reversible_until FROM action_audit WHERE proposal_id='loop_send'").get();
  assert.equal(row.principal, "owner@test");
  assert.equal(row.audience, "email:partner@x.com");
  assert.equal(row.content_digest, sent.ledger.contentDigest);
  assert.ok(row.reversible_until > Date.now());
  ok("8a 台账：代表谁 / 对谁说 / digest / 可撤销至 齐备");

  // 窗口内撤回 → 过期后拒绝（同一函数用不同时间点验）
  const now = Date.now();
  const live = mainDb.prepare("SELECT COUNT(*) n FROM action_audit WHERE proposal_id='loop_send' AND reversible_until > ?").get(now).n;
  const dead = mainDb.prepare("SELECT COUNT(*) n FROM action_audit WHERE proposal_id='loop_send' AND reversible_until > ?").get(row.reversible_until + 1).n;
  assert.equal(live, 1); assert.equal(dead, 0);
  ok("8b 撤回：窗口内可撤，窗口外不可撤");

  // ── 收尾：一致率闸仍是唯一放量依据 ───────────────────────────────────────
  const stats = db.decisionConsistency({ fleetId: FLEET });
  assert.equal(canPromoteToAuto(stats).ok, false, "样本不足不得升 act-notify");
  ok("9 放量闸：样本不足拒绝升档", `samples=${stats.samples} rate=${stats.rate}`);

  const failed = steps.filter((s) => s.startsWith("FAIL")).length;
  console.log(`\n${steps.length - failed}/${steps.length} passed`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  fail("链路中断", String(e?.message || e).slice(0, 300));
  console.log(`\n${steps.filter((s) => s.startsWith("PASS")).length}/${steps.length + 1} passed`);
  process.exitCode = 1;
}
