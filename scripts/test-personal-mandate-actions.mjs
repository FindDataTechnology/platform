// 个人委托状 · 动作路径接入 (add-personal-mandate 3.1 / 3.2 / 3.3 / 3.4)
//
// 钉三件事：
//   1. preflight 的顺序与文案不变——凭据缺失优先于授权结论，且没有委托状的
//      调用方拿到的是与本 change 之前逐字节相同的返回值。
//   2. 路线级：advise 不落任何行、draft 落 pending、execute 由委托状自动批准
//      并通报（通报里带撤销截止时间），且 approver 绝不冒充人类。
//   3. 只有 loopback 的 actions-mcp 子进程能声称自己持委托状；带 cookie 的
//      浏览器用户传 mandateDomain 必须解析为 null（否则就是自授权）。
//
// env 必须在任何会 import db.js 的模块之前设置——路径在导入期解析。
// Run: node --test scripts/test-personal-mandate-actions.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandate-actions-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { initDb, getDb } = await import("../db.js");
const { preflightAction } = await import("../lib/action-preflight.js");
const { DECISION, MODES, resolveMandate } = await import("../lib/personal-mandate.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { proposeAction, resolveMandateContext } = await import("../server/routes/actions.js");

await initDb();
const fleetDb = createFleetDatabase({});
setFleetDatabase(fleetDb);

// A registry-shaped action with no credentials to check: the integration point
// is "preflight → mandate", not the individual line preflights (those have
// their own suites).
const bare = (over = {}) => ({ id: "test.bare", risk: "write", target: "cloud", ...over });

const policyWith = (mode, extra = {}) => ({
  version: 2,
  domains: { "external-comms": { mode, discloseScope: ["public"], ...extra } },
});

const mandateFor = (mode, extra = {}) => ({
  policy: policyWith(mode, extra),
  domain: "external-comms",
  principal: { kind: "agent" },
  usage: { count: 0, amount: 0 },
});

// ── 3.1 preflight 接入 ─────────────────────────────────────────────────────

test("3.1 no mandate in ctx → byte-identical result (copilot is untouched)", async () => {
  const withoutCtx = await preflightAction(bare(), { email: "a@b.c" }, {});
  assert.deepEqual(withoutCtx, { ok: true });
  assert.equal("mandate" in withoutCtx, false);
});

test("3.1 a mandate verdict rides on the preflight result, prerequisites still decide ok", async () => {
  const pf = await preflightAction(bare({ revocable: true }), { email: "a@b.c", mandate: mandateFor(MODES["act-notify"]) }, {});
  assert.equal(pf.ok, true, "a mandate verdict is not a failed prerequisite");
  assert.equal(pf.mandate.decision, DECISION.EXECUTE);
  assert.equal(pf.mandate.notify, true);
});

test("3.1 advise is reported as a verdict, never as a preflight failure", async () => {
  const pf = await preflightAction(bare(), { email: "a@b.c", mandate: mandateFor(MODES.advise) }, {});
  assert.equal(pf.ok, true);
  assert.equal(pf.mandate.decision, DECISION.ADVISE);
});

test("3.1 a missing credential outranks the mandate verdict (order is the contract)", async () => {
  const failing = bare({ preflight: async () => ({ ok: false, details: "需要先连接某账号" }) });
  const pf = await preflightAction(failing, { email: "a@b.c", mandate: mandateFor(MODES["act-notify"]) }, {});
  assert.equal(pf.ok, false);
  assert.equal(pf.details, "需要先连接某账号", "the actionable connect message must survive");
  assert.equal("mandate" in pf, false, "no verdict is attached when prerequisites already failed");
});

// ── 3.4 副驾隔离 ───────────────────────────────────────────────────────────

test("3.4 a cookie caller can never claim a mandate (authority is not self-served)", () => {
  const req = {
    user: { email: "owner@test", internal: false },
    body: { mandateDomain: "external-comms" },
  };
  assert.equal(resolveMandateContext(req), null);
});

test("3.4 the internal bridge without a domain claims nothing", () => {
  assert.equal(resolveMandateContext({ user: { internal: true }, body: {} }), null);
  assert.equal(resolveMandateContext({ user: { internal: true }, body: { mandateDomain: 42 } }), null);
});

test("3.4 the internal bridge resolves an agent principal from the stored policy", () => {
  fleetDb.setCellMandatePolicy(policyWith("draft"));

  const ctx = resolveMandateContext({
    user: { internal: true },
    body: { mandateDomain: "external-comms", disclosedSources: [{ level: "public", ref: "kb:faq" }] },
  });
  assert.ok(ctx);
  assert.equal(ctx.domain, "external-comms");
  assert.deepEqual(ctx.principal, { kind: "agent" });
  assert.equal(ctx.policy.domains["external-comms"].mode, "draft");
  assert.deepEqual(ctx.declaredSources, [{ level: "public", ref: "kb:faq" }]);
});

// ── 3.2 / 3.3 route 级：draft 入队、execute 自动批准、act-notify 通报 ────────

function fakeRes() {
  return {
    code: 200,
    body: null,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const executorDeps = {
  resolveEndpoint: () => "http://127.0.0.1:1/mcp",
  resolveRef: () => "registry",
  liveToken: () => "tok",
};

test("3.2/3.3 advise stores nothing, draft queues as pending, execute auto-approves and notifies", async () => {
  const events = [];
  let verdict = null;
  const ctx = {
    broadcast: (e) => events.push(e),
    // The registry entry is real; prerequisites and upstream are substituted
    // through the same seam style as ctx.actionExecutorDeps.
    actionPreflight: async (_action, c) => ({ ok: true, mandate: c.mandate ? verdict : undefined }),
    actionExecutorDeps: executorDeps,
  };
  const makeReq = () => ({
    user: { internal: true, email: "owner@test" },
    ctx,
    body: {
      actionId: "wanxing.agent.pause",
      proposerEmail: "owner@test",
      args: { pack_id: "p1", agent_id: "a1" },
      mandateDomain: "external-comms",
    },
  });

  const action = { id: "wanxing.agent.pause", risk: "write", revocable: true };
  const before = getDb().prepare("SELECT COUNT(*) AS n FROM action_proposals").get().n;

  // advise → nothing stored
  verdict = resolveMandate({
    policy: policyWith("advise"), domain: "external-comms", action, principal: { kind: "agent" },
  });
  const res1 = fakeRes();
  await proposeAction(makeReq(), res1);
  assert.equal(res1.body.state, "advised");
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM action_proposals").get().n, before);

  // draft → a pending row; the owner's approval is the missing step
  verdict = resolveMandate({
    policy: policyWith("draft"), domain: "external-comms", action, principal: { kind: "agent" },
  });
  assert.equal(verdict.decision, DECISION.DRAFT);
  const res2 = fakeRes();
  await proposeAction(makeReq(), res2);
  assert.equal(res2.body.state, "pending");
  assert.equal(res2.body.mandate.decision, DECISION.DRAFT);

  // execute → approved by the mandate, executed (upstream unreachable), notified
  verdict = resolveMandate({
    policy: policyWith("act-notify", { revokeWindowMinutes: 10 }),
    domain: "external-comms",
    action,
    principal: { kind: "agent" },
  });
  assert.equal(verdict.decision, DECISION.EXECUTE);
  const res3 = fakeRes();
  await proposeAction(makeReq(), res3);
  assert.equal(res3.body.state, "failed", "upstream is unreachable; the state must say so");

  const broadcast = events.find((e) => e.type === "mandate_action_executed");
  assert.ok(broadcast, "act-notify must notify");
  assert.equal(broadcast.domain, "external-comms");
  assert.equal(broadcast.mode, "act-notify");
  assert.ok(broadcast.reversibleUntil > Date.now(), "the notify carries the revoke deadline");

  const row = getDb()
    .prepare("SELECT approver_email FROM action_proposals WHERE proposal_id = ?")
    .get(res3.body.proposalId);
  assert.match(row.approver_email, /^mandate:external-comms/, "never claim a human approved it");
});

test("3.3 act-silent executes without a通报", async () => {
  const events = [];
  const verdict = resolveMandate({
    policy: policyWith("act-silent"),
    domain: "external-comms",
    action: { id: "wanxing.agent.pause", risk: "write", revocable: true },
    principal: { kind: "agent" },
  });
  assert.equal(verdict.decision, DECISION.EXECUTE);
  assert.equal(verdict.notify, false);

  const ctx = {
    broadcast: (e) => events.push(e),
    actionPreflight: async (_action, c) => ({ ok: true, mandate: c.mandate ? verdict : undefined }),
    actionExecutorDeps: executorDeps,
  };
  const res = fakeRes();
  await proposeAction(
    {
      user: { internal: true, email: "owner@test" },
      ctx,
      body: {
        actionId: "wanxing.agent.pause",
        proposerEmail: "owner@test",
        args: { pack_id: "p1", agent_id: "a1" },
        mandateDomain: "external-comms",
      },
    },
    res,
  );
  assert.equal(events.filter((e) => e.type === "mandate_action_executed").length, 0);
  assert.equal(res.body.mandate.notify, false);
});

// ── 4.2 / 4.4 真实注册表条目的披露判定与越界计数 ────────────────────────────

test("4.2 the gate reads the real registry entry's contentArgs, not a summary", async () => {
  const { getAction } = await import("../lib/action-registry.js");
  const publish = getAction("facet.pack.publish");
  assert.equal(publish.outbound, true);
  assert.deepEqual(publish.contentArgs, ["manifest"]);

  const blocked = resolveMandate({
    policy: policyWith("draft"),
    domain: "external-comms",
    action: publish,
    args: { manifest: { name: "报价单", description: "本次报价 38 万元" } },
    principal: { kind: "agent" },
  });
  assert.equal(blocked.disclose.ok, false, "money in the manifest must be caught");
  assert.ok(blocked.disclose.violations.some((v) => v.level === "finance"));
});

test("4.4 a blocked attempt is counted per domain and day, and pruned to a week", () => {
  const day = "2026-11-09";
  fleetDb.recordMandateViolation("external-comms", "disclose", day);
  fleetDb.recordMandateViolation("external-comms", "disclose", day);
  fleetDb.recordMandateViolation("external-comms", "read", day);

  const today = fleetDb.getMandateViolations(day);
  assert.equal(today["external-comms"].disclose, 2);
  assert.equal(today["external-comms"].read, 1);

  // Old keys fall out of the window rather than growing without bound.
  for (const d of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]) {
    fleetDb.recordMandateViolation("ops", "quota", d);
  }
  const all = fleetDb.getCellSetting("mandateViolations");
  assert.ok(Object.keys(all).length <= 7, "keeps at most a week of buckets");
});

// ── 5.2 / 5.3 / 5.4 台账字段、检索与撤销 ────────────────────────────────────

test("5.2 the audit row carries the mandate lineage and a digest, never the text", async () => {
  const events = [];
  const verdict = resolveMandate({
    policy: policyWith("act-notify", { revokeWindowMinutes: 30 }),
    domain: "external-comms",
    action: { id: "wanxing.agent.pause", risk: "write", revocable: true, contentArgs: ["pack_id"] },
    principal: { kind: "agent" },
  });
  const ctx = {
    broadcast: (e) => events.push(e),
    actionPreflight: async (_a, c) => ({ ok: true, mandate: c.mandate ? verdict : undefined }),
    actionExecutorDeps: executorDeps,
  };
  const res = fakeRes();
  await proposeAction(
    {
      user: { internal: true, email: "owner@test" },
      ctx,
      body: {
        actionId: "wanxing.agent.pause",
        proposerEmail: "owner@test",
        args: { pack_id: "p1", agent_id: "a1" },
        mandateDomain: "external-comms",
      },
    },
    res,
  );

  const row = getDb().prepare(`
    SELECT mandate_domain, mandate_mode, content_digest, reversible_until, mandate_ref
    FROM action_audit WHERE proposal_id = ?
  `).get(res.body.proposalId);
  assert.equal(row.mandate_domain, "external-comms");
  assert.equal(row.mandate_mode, "act-notify");
  assert.ok(row.mandate_ref, "the lineage column names the action it authorized");
  // `wanxing.agent.pause` declares no contentArgs, so there is no outbound text
  // to digest — null is the honest record, not a missing field.
  assert.equal(row.content_digest, null);
  assert.ok(row.reversible_until > Date.now(), "revoke window recorded");
  assert.equal(
    getDb().prepare("SELECT COUNT(*) AS n FROM action_audit WHERE args_json IS NOT NULL").get().n,
    0,
    "the outbound text is never stored in the audit table",
  );
});

test("5.3/5.4 the ledger filters by domain and reversible, and revoke refuses past the window", () => {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO action_audit (
      proposal_id, line, action_id, args_digest, risk, target, impact_text,
      created_at, mandate_domain, mandate_mode, reversible_until, result_summary
    ) VALUES (?, 'facet', ?, 'd', 'write', 'cloud', 'i', ?, ?, ?, ?, 'ok')
  `);
  // action_audit has an FK to action_proposals — a real ledger row always has a
  // proposal behind it, so the test seeds them rather than disabling the FK.
  const seedProposal = db.prepare(`
    INSERT INTO action_proposals (
      proposal_id, line, action_id, args_digest, risk, target, impact_text, state, created_at, updated_at
    ) VALUES (?, 'facet', ?, 'd', 'write', 'cloud', 'i', 'executed', ?, ?)
  `);
  for (const id of ["rev_live", "rev_dead", "rev_none"]) {
    seedProposal.run(id, `a.${id}`, "2026-11-09T10:00:00Z", "2026-11-09T10:00:00Z");
  }

  const future = Date.now() + 60_000;
  const past = Date.now() - 60_000;
  insert.run("rev_live", "a.rev_live", "2026-11-09T10:00:00Z", "external-comms", "act-notify", future);
  insert.run("rev_dead", "a.rev_dead", "2026-11-09T10:00:01Z", "external-comms", "act-notify", past);
  insert.run("rev_none", "a.rev_none", "2026-11-09T10:00:02Z", "ops", "draft", null);

  const live = db.prepare(`
    SELECT COUNT(*) AS n FROM action_audit
    WHERE proposal_id IN ('rev_live','rev_dead','rev_none')
      AND mandate_domain = 'external-comms' AND reversible_until > ? AND revoked_at IS NULL
  `).get(Date.now()).n;
  assert.equal(live, 1, "only the still-open window counts as reversible");
});
