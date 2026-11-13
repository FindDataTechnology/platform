// Input-request core (add-input-request-cards, tasks 1.1-1.5):
//
//   §1 表与幂等建表；§2 卡片校验（未知类型/枚举无选项/语法糖不成立）；
//   §3 答案校验（必填/枚举/数字/未知字段）；§4 状态机与 first-wins；
//   §5 TTL 四策略矩阵。
//
// 无 LLM、无网络：只用临时库和内核函数。

import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "input-request-core-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
// fleets 走独立库：钉住 data 根，避免测试写进仓库的 data/。
process.env.PLATFORM_DATA_DIR = tmpRoot;

const dbMod = await import("../db.js");
const core = await import("../server/input-requests.js");

let db;

before(async () => {
  await dbMod.initDb();
  db = dbMod.getDb();
  core.ensureInputRequestSchema(db);
});

function cardForm(extra = {}) {
  return {
    type: "form",
    title: "补齐交付信息",
    fields: [
      { key: "customer", kind: "text", label: "客户", required: true },
      { key: "amount", kind: "number", label: "金额" },
      { key: "channel", kind: "enum", label: "渠道", options: ["线上", "线下"] },
    ],
    ...extra,
  };
}

function makeRequest(id, { policy = null, card = null, now = Date.now() } = {}) {
  return core.createInputRequest(db, {
    id,
    ownerEmail: "owner@example.com",
    sessionId: "s-1",
    card: card ?? cardForm(),
    policy,
    now,
  });
}

test("1.1 建表幂等且列齐全", () => {
  core.ensureInputRequestSchema(db); // 第二次不抛
  const cols = db.prepare("PRAGMA table_info(input_requests)").all().map((c) => c.name);
  for (const name of [
    "id",
    "owner_email",
    "session_id",
    "fleet_id",
    "member_id",
    "card",
    "policy",
    "state",
    "answer",
    "answered_by",
    "answered_at",
    "expires_at",
    "escalated_decision_id",
    "created_at",
  ]) {
    assert.ok(cols.includes(name), `missing column ${name}`);
  }
});

test("1.2 非法卡片被拒且不落行", () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM input_requests").get().n;

  assert.throws(
    () =>
      core.createInputRequest(db, {
        id: "bad-kind",
        ownerEmail: "owner@example.com",
        card: { type: "form", title: "t", fields: [{ key: "sig", kind: "signature" }] },
      }),
    (err) => err.code === "invalid_card" && JSON.stringify(err.details).includes("signature"),
  );

  assert.throws(
    () =>
      core.createInputRequest(db, {
        id: "bad-enum",
        ownerEmail: "owner@example.com",
        card: { type: "form", title: "t", fields: [{ key: "ch", kind: "enum" }] },
      }),
    (err) => err.code === "invalid_card",
  );

  // 语法糖不成立：confirm 必须有且只有一个 boolean
  assert.throws(
    () =>
      core.createInputRequest(db, {
        id: "bad-confirm",
        ownerEmail: "owner@example.com",
        card: { type: "confirm", title: "t", fields: [{ key: "a", kind: "text" }] },
      }),
    (err) => err.code === "invalid_card",
  );

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM input_requests").get().n, before);
});

test("1.2b 合法语法糖被接受", () => {
  const r1 = core.createInputRequest(db, {
    id: "ok-confirm",
    ownerEmail: "owner@example.com",
    card: { type: "confirm", title: "确认吗", fields: [{ key: "ok", kind: "boolean", required: true }] },
  });
  assert.equal(r1.card.type, "confirm");
  assert.equal(r1.state, "pending");

  const r2 = core.createInputRequest(db, {
    id: "ok-choice",
    ownerEmail: "owner@example.com",
    card: {
      type: "choice",
      title: "选一个",
      fields: [{ key: "pick", kind: "enum", required: true, options: ["A", "B"] }],
    },
  });
  assert.equal(r2.card.type, "choice");
});

test("1.3 答案校验逐项报错且行仍 pending", () => {
  makeRequest("ans-1");
  assert.throws(
    () => core.answerInputRequest(db, "ans-1", { values: {}, answeredBy: "owner@example.com" }),
    (err) =>
      err.code === "invalid_answers" &&
      err.details.errors.some((e) => e.field === "customer"),
  );
  assert.equal(core.getInputRequest(db, "ans-1").state, "pending");

  assert.throws(
    () =>
      core.answerInputRequest(db, "ans-1", {
        values: { customer: "甲公司", channel: "电话" },
        answeredBy: "owner@example.com",
      }),
    (err) => err.details.errors.some((e) => e.field === "channel"),
  );

  assert.throws(
    () =>
      core.answerInputRequest(db, "ans-1", {
        values: { customer: "甲公司", amount: "很多" },
        answeredBy: "owner@example.com",
      }),
    (err) => err.details.errors.some((e) => e.field === "amount"),
  );

  assert.throws(
    () =>
      core.answerInputRequest(db, "ans-1", {
        values: { customer: "甲公司", nope: 1 },
        answeredBy: "owner@example.com",
      }),
    (err) => err.details.errors.some((e) => e.field === "nope"),
  );

  const { request, changed } = core.answerInputRequest(db, "ans-1", {
    values: { customer: "甲公司", amount: 1200, channel: "线上" },
    answeredBy: "owner@example.com",
  });
  assert.equal(changed, true);
  assert.equal(request.state, "answered");
  assert.deepEqual(request.values, { customer: "甲公司", amount: 1200, channel: "线上" });
});

test("1.4 并发应答只有第一次生效", () => {
  makeRequest("race-1", { card: { type: "confirm", title: "确认", fields: [{ key: "ok", kind: "boolean", required: true }] } });
  const first = core.answerInputRequest(db, "race-1", { values: { ok: true }, answeredBy: "a@example.com" });
  const second = core.answerInputRequest(db, "race-1", { values: { ok: false }, answeredBy: "b@example.com" });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.reason, "answered");
  const row = core.getInputRequest(db, "race-1");
  assert.equal(row.values.ok, true);
  assert.equal(row.answeredBy, "a@example.com");
});

test("1.4b 取消后不可再答", () => {
  makeRequest("cancel-1");
  assert.equal(core.cancelInputRequest(db, "cancel-1").changed, true);
  const after = core.answerInputRequest(db, "cancel-1", {
    values: { customer: "X" },
    answeredBy: "owner@example.com",
  });
  assert.equal(after.changed, false);
  assert.equal(after.request.state, "cancelled");
});

test("1.5 TTL 四策略矩阵", () => {
  const now = Date.now();
  const past = now - 1000;

  // abort → expired
  makeRequest("ttl-abort", { policy: { onUnattended: "abort", ttlSec: 1 }, now: past });
  // default → answered（带默认值）
  makeRequest("ttl-default", {
    policy: { onUnattended: "default", ttlSec: 1 },
    card: {
      type: "form",
      title: "缺省补齐",
      fields: [{ key: "channel", kind: "enum", options: ["线上", "线下"], default: "线上" }],
    },
    now: past,
  });
  // wait → 仍 pending
  makeRequest("ttl-wait", { policy: { onUnattended: "wait", ttlSec: 1 }, now: past });
  // escalate → 交给回调；回调缺失则 expired（fail-closed）
  makeRequest("ttl-escalate", { policy: { onUnattended: "escalate", ttlSec: 1 }, now: past });

  const settled = core.expireDueInputRequests(db, {
    now,
    escalate: (req) => (req.id === "ttl-escalate" ? "dec-1" : null),
  });
  const byId = Object.fromEntries(settled.map((r) => [r.id, r]));
  assert.equal(byId["ttl-abort"].state, "expired");
  assert.equal(byId["ttl-default"].state, "answered");
  assert.deepEqual(byId["ttl-default"].values, { channel: "线上" });
  assert.equal(byId["ttl-escalate"].state, "escalated");
  assert.equal(byId["ttl-escalate"].escalatedDecisionId, "dec-1");
  assert.equal(core.getInputRequest(db, "ttl-wait").state, "pending");
});

test("1.5b default 策略必须有默认值", () => {
  assert.throws(
    () =>
      core.createInputRequest(db, {
        id: "bad-default",
        ownerEmail: "owner@example.com",
        card: cardForm(),
        policy: { onUnattended: "default" },
      }),
    (err) => err.code === "invalid_policy",
  );
});

test("1.5c 无 owner 不落行", () => {
  assert.throws(
    () => core.createInputRequest(db, { id: "no-owner", card: cardForm() }),
    (err) => err.code === "owner_required",
  );
});

test("1.6 长轮询在同一进程内被作答唤醒", async () => {
  makeRequest("wait-1");
  const pending = core.waitForInputRequest(db, "wait-1", { timeoutMs: 3000 });
  setTimeout(() => {
    core.answerInputRequest(db, "wait-1", {
      values: { customer: "乙公司" },
      answeredBy: "owner@example.com",
    });
  }, 30);
  const row = await pending;
  assert.equal(row.state, "answered");
  assert.equal(row.values.customer, "乙公司");
});

test("1.7 长轮询超时返回 null 而不是错误", async () => {
  makeRequest("wait-2");
  const row = await core.waitForInputRequest(db, "wait-2", { timeoutMs: 80, pollMs: 20 });
  assert.equal(row, null);
  assert.equal(core.getInputRequest(db, "wait-2").state, "pending");
});
