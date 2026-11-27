// 对外披露闸 · 台账与撤回 (add-principal-disclosure-gate 3.x/4.3/5.x)
//
// 钉四件事：
//   1. 台账只存 digest，不存原文；
//   2. 回执按 id 可查，且不含原文；
//   3. 撤回：窗口内成功并留痕，窗口过拒绝，渠道不可撤回时说明原因；
//   4. 四种检索面（域/对象/代表谁/层级）。
//
// Run: node --test scripts/test-outbound-gate.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-gate-"));
process.env.CRON_STORAGE_PATH = tmp;
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.PLATFORM_DATA_DIR = tmp;
process.env.DSH_HOME = path.join(tmp, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { initDb, getDb } = await import("../db.js");
const { registerActionsRoutes } = await import("../server/routes/actions.js");
const { gateOutboundMessage } = await import("../lib/outbound-message.js");

await initDb();

function seedProposal(id) {
  getDb().prepare(`
    INSERT INTO action_proposals (
      proposal_id, line, action_id, args_digest, risk, target, impact_text, state, created_at, updated_at
    ) VALUES (?, 'bots', 'chat.message.send', 'd', 'write', 'cloud', 'i', 'executed', ?, ?)
  `).run(id, "2026-11-09T10:00:00Z", "2026-11-09T10:00:00Z");
}

function seedAudit(id, { audience = null, reversibleUntil = null, principal = null, domain = null, level = null, digest = null } = {}) {
  seedProposal(id);
  getDb().prepare(`
    INSERT INTO action_audit (
      proposal_id, line, action_id, args_digest, risk, target, impact_text, created_at,
      principal, audience, mandate_domain, mandate_mode, disclose_level, reversible_until, content_digest, result_summary
    ) VALUES (?, 'bots', 'chat.message.send', 'd', 'write', 'cloud', 'i', ?, ?, ?, ?, 'act-notify', ?, ?, ?, 'ok')
  `).run(id, "2026-11-09T10:00:00Z", principal, audience, domain, level, reversibleUntil, digest);
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  registerActionsRoutes({ app, broadcast: () => {} });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p) => fetch(base + p, { method }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    await fn(call);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("3.2/4.3 the ledger carries a digest and the receipt never carries the text", async () => {
  const gated = gateOutboundMessage({
    policy: { version: 2, domains: { "external-comms": { mode: "act-notify", discloseScope: ["public", "internal"], revokeWindowMinutes: 10 } } },
    domain: "external-comms",
    text: "明天下午三点见，会议室我订好了",
    to: "customer@x.com",
    channel: "email",
    principal: { kind: "agent", email: "owner@test" },
    channelRevocable: true,
    now: Date.now(),
  });
  assert.equal(gated.ok, true);

  seedAudit("ob_1", {
    audience: gated.ledger.audience,
    reversibleUntil: gated.ledger.reversibleUntil,
    principal: gated.ledger.principal,
    domain: gated.ledger.domain,
    level: "internal",
    digest: gated.ledger.contentDigest,
  });

  const row = getDb().prepare("SELECT principal, audience, content_digest, reversible_until FROM action_audit WHERE proposal_id = ?").get("ob_1");
  assert.equal(row.principal, "owner@test");
  assert.equal(row.audience, "email:customer@x.com");
  assert.match(row.content_digest, /^[0-9a-f]{64}$/);
  const raw = getDb().prepare("SELECT COUNT(*) AS n FROM action_audit WHERE args_json IS NOT NULL").get().n;
  assert.equal(raw, 0, "原文不得落入台账");

  await withServer(async (call) => {
    const res = await call("GET", "/api/actions/ob_1/receipt");
    assert.equal(res.status, 200);
    assert.equal(res.body.principal, "owner@test");
    assert.equal(res.body.audience, "email:customer@x.com");
    assert.equal(JSON.stringify(res.body).includes("会议室"), false, "回执不含原文");
    assert.equal(res.body.authorizedBy, "owner-mandate");
  });
});

test("3.3 the ledger filters by audience, principal and disclose level", async () => {
  seedAudit("ob_a", { audience: "wecom:u1", principal: "owner@test", domain: "ops", level: "internal" });
  seedAudit("ob_b", { audience: "email:c2@x.com", principal: "owner@test", domain: "external-comms", level: "finance" });
  seedAudit("ob_c", { audience: "feishu:u3", principal: "other@test", domain: "ops", level: "public" });

  await withServer(async (call) => {
    const byAudience = await call("GET", "/api/actions/mandate/ledger?audience=wecom:u1");
    assert.deepEqual(byAudience.body.rows.map((r) => r.proposal_id).sort(), ["ob_a"]);

    const byLevel = await call("GET", "/api/actions/mandate/ledger?discloseLevel=finance");
    assert.deepEqual(byLevel.body.rows.map((r) => r.proposal_id).sort(), ["ob_b"]);

    const byDomain = await call("GET", "/api/actions/mandate/ledger?domain=ops");
    assert.deepEqual(byDomain.body.rows.map((r) => r.proposal_id).sort(), ["ob_a", "ob_c"]);

    const byPrincipal = await call("GET", "/api/actions/mandate/ledger?principal=other@test");
    assert.deepEqual(byPrincipal.body.rows.map((r) => r.proposal_id).sort(), ["ob_c"]);
  });
});

test("5.3 revoke succeeds inside the window and leaves a trace", async () => {
  seedAudit("rv_live", { audience: "email:c@x.com", reversibleUntil: Date.now() + 60_000 });
  await withServer(async (call) => {
    const res = await call("POST", "/api/actions/rv_live/revoke");
    assert.equal(res.status, 200);
    assert.ok(res.body.revokedAt);
  });
  const row = getDb().prepare("SELECT revoked_at FROM action_audit WHERE proposal_id = ?").get("rv_live");
  assert.ok(row.revoked_at, "撤回留痕");
});

test("5.3 revoke refuses after the window and names the channel when it cannot recall", async () => {
  seedAudit("rv_dead", { audience: "email:c@x.com", reversibleUntil: Date.now() - 60_000 });
  seedAudit("rv_none", { audience: "wecom:u9", reversibleUntil: null });

  await withServer(async (call) => {
    const closed = await call("POST", "/api/actions/rv_dead/revoke");
    assert.equal(closed.status, 409);
    assert.match(closed.body.error, /revoke window closed/);

    const nocap = await call("POST", "/api/actions/rv_none/revoke");
    assert.equal(nocap.status, 409);
    assert.match(nocap.body.error, /cannot recall/);
    assert.equal(nocap.body.channel, "wecom");
  });
});

test("5.3/3.3 a revoked row drops out of the reversible filter", async () => {
  seedAudit("rv_filter", { audience: "email:c@x.com", reversibleUntil: Date.now() + 60_000 });
  await withServer(async (call) => {
    const before = await call("GET", "/api/actions/mandate/ledger?reversible=1");
    assert.ok(before.body.rows.some((r) => r.proposal_id === "rv_filter"));
    await call("POST", "/api/actions/rv_filter/revoke");
    const after = await call("GET", "/api/actions/mandate/ledger?reversible=1");
    assert.equal(after.body.rows.some((r) => r.proposal_id === "rv_filter"), false);
  });
});

// ── 6.3 端到端：含金额的对外回复回落 draft，越界项可读 ──────────────────────

test("6.3 a reply quoting money is withheld with a readable violation, not a vague refusal", () => {
  const policy = { version: 2, domains: { "external-comms": { mode: "act-notify", discloseScope: ["public", "internal"], revokeWindowMinutes: 5 } } };
  const blocked = gateOutboundMessage({
    policy,
    domain: "external-comms",
    text: "这单我们报 42 万，含三年维护",
    to: "buyer@x.com",
    channel: "email",
    principal: { kind: "agent", email: "o@t" },
    channelRevocable: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.decision, "draft");
  assert.equal(blocked.reason, "disclose_out_of_scope");
  const v = blocked.disclosure.violations.find((x) => x.level === "finance");
  assert.ok(v, "越界项必须点名 finance，否则主人不知道要改什么");
  assert.equal(v.via, "pattern");
});

test("6.3 a clean reply passes and yields a complete ledger row", () => {
  const policy = { version: 2, domains: { "external-comms": { mode: "act-notify", discloseScope: ["public", "internal"], revokeWindowMinutes: 5 } } };
  const sent = gateOutboundMessage({
    policy,
    domain: "external-comms",
    text: "合同已寄出，预计后天到",
    to: "buyer@x.com",
    channel: "email",
    principal: { kind: "agent", email: "o@t" },
    channelRevocable: true,
  });
  assert.equal(sent.ok, true);
  assert.deepEqual(
    Object.keys(sent.ledger).sort(),
    ["audience", "contentDigest", "discloseLevel", "domain", "mode", "principal", "reversibleUntil"].sort(),
  );
});

// ── 1.5 裁决端点：自带 bearer，未配置即拒，异常失败关闭 ─────────────────────

test("1.5 verdict: 503 unconfigured, 401 wrong bearer, and a real verdict when configured", async () => {
  const app = express();
  app.use(express.json());
  registerActionsRoutes({ app, broadcast: () => {} });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, token) =>
    fetch(`${base}/api/actions/mandate-verdict`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  try {
    delete process.env.MANDATE_VERDICT_TOKEN;
    const unconfigured = await post({ domain: "external-comms", text: "hi" }, "x");
    assert.equal(unconfigured.status, 503, "未配置的部署必须拒绝，不是放行");

    process.env.MANDATE_VERDICT_TOKEN = "verdict-token-123";
    const wrong = await post({ domain: "external-comms", text: "hi" }, "nope");
    assert.equal(wrong.status, 401);

    const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
    const fleetDb = createFleetDatabase({});
    setFleetDatabase(fleetDb);
    fleetDb.setCellMandatePolicy({
      version: 2,
      domains: { "external-comms": { mode: "act-notify", discloseScope: ["public", "internal"] } },
    });

    const blocked = await post({ domain: "external-comms", text: "这单报 42 万" }, "verdict-token-123");
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.decision, "draft");
    assert.ok(blocked.body.violations.some((v) => v.level === "finance"), "越界项要回给 runner，主人才知道改什么");

    const allowed = await post({ domain: "external-comms", text: "合同已寄出", channelRevocable: true }, "verdict-token-123");
    assert.equal(allowed.body.ok, true);
    assert.match(allowed.body.contentDigest, /^[0-9a-f]{64}$/);
  } finally {
    await new Promise((r) => server.close(r));
    delete process.env.MANDATE_VERDICT_TOKEN;
  }
});
