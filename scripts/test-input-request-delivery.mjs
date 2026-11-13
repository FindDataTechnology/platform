// Input-request delivery + escalation (add-input-request-cards, tasks 5.1-5.3):
//
//   §5.1 回合内等待：答案由长轮询交回工具调用（tools 套件已覆盖，这里只验
//        形状一致的 answerPayload）。
//   §5.2 回合已结束：以一条用户可见的系统消息开新回合，且带上请求标识。
//   §5.3 无人应答升级：写进拍板队列并把行标记 escalated；写不进去就如实
//        failed-closed 成 expired，绝不假装升级。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "input-request-delivery-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;

const dbMod = await import("../db.js");
const core = await import("../server/input-requests.js");
const { registerInputRequestRoutes } = await import("../server/routes/input-requests.js");
const { getFleetDatabase } = await import("../server/routes/fleets-db.js");
const chatHistory = await import("../chat-history.js");

let server;
let base;
let prompts = [];
let viewers = [];
let currentUser = { email: "owner@example.com", groups: [] };

const ctx = {
  app: null,
  clients: new Set(),
  broadcast: () => {},
  sendToViewers: (sid, data) => viewers.push({ sid, data }),
  turnStateFor: () => ({ sessionId: "s-deliver" }),
  session: { prompt: async (text, sid) => prompts.push({ text, sid }) },
  finishTurn: () => {},
  webTurnSessions: new Set(),
  turnStateBySession: new Map(),
};

before(async () => {
  await dbMod.initDb();
  // 真实会话在建会话时就落 chat_sessions 行（server/agent-session.js 的
  // createSession）：回灌的存在性判据认这一行，所以夹具必须照生产建一次，
  // 否则验到的是「不存在的会话」而不是「回合已结束的会话」。
  chatHistory.createSession("s-deliver", "owner@example.com");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = currentUser;
    next();
  });
  ctx.app = app;
  registerInputRequestRoutes(ctx);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function create(body = {}) {
  currentUser = { email: "owner@example.com", groups: [] };
  const res = await fetch(`${base}/api/input-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s-deliver",
      card: {
        type: "form",
        title: "补齐交付信息",
        fields: [
          { key: "customer", kind: "text", required: true },
          { key: "amount", kind: "number", unit: "元" },
        ],
      },
      ...body,
    }),
  });
  return { res, body: await res.json() };
}

test("5.1 回合内：答案形状与工具侧一致（state + values + requestId）", async () => {
  ctx.turnStateBySession.set("s-deliver", { sessionId: "s-deliver", isStreaming: true });
  const { body } = await create();
  currentUser = { email: "owner@example.com", groups: [] };
  const res = await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { customer: "甲公司", amount: 1200 } }),
  });
  const answered = await res.json();
  assert.deepEqual(Object.keys(answered).sort(), ["answeredBy", "requestId", "state", "values"]);
  assert.equal(answered.state, "answered");
  assert.equal(answered.values.customer, "甲公司");
});

test("5.2 回合已结束：以系统消息开新回合，带请求标识与字段值", async () => {
  prompts = [];
  viewers = [];
  ctx.turnStateBySession.delete("s-deliver");
  const { body } = await create();
  currentUser = { email: "owner@example.com", groups: [] };
  await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { customer: "乙公司", amount: 88 } }),
  });
  // 注入是异步的（void promise），给一拍
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sid, "s-deliver");
  assert.match(prompts[0].text, new RegExp(body.requestId));
  assert.match(prompts[0].text, /乙公司/);
  assert.match(prompts[0].text, /88 元/);
  // 用户可见的消息先落地（与 delegation-aggregator 同一姿态）
  assert.ok(viewers.some((v) => v.data?.type === "user"));
});

test("5.2b 回合仍在跑时不重复注入（工具调用自己会拿到结果）", async () => {
  prompts = [];
  ctx.turnStateBySession.set("s-deliver", { sessionId: "s-deliver", isStreaming: true });
  const { body } = await create();
  currentUser = { email: "owner@example.com", groups: [] };
  await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { customer: "丙公司" } }),
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(prompts.length, 0);
});

test("5.2c 会话不存在时不投递（凭空开回合 = 把垃圾写进别人的会话列表）", async () => {
  // 2026-11-11 实测形态：授权链路脚本用 `verify-6.2-authz` 这种不存在的 id 提卡，
  // 作答后平台凭空开了一个回合，会话列表里多出「【主人补齐了输入】」。
  prompts = [];
  viewers = [];
  ctx.turnStateBySession.delete("s-ghost");
  const { body } = await create({ sessionId: "s-ghost" });
  currentUser = { email: "owner@example.com", groups: [] };
  const res = await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { customer: "幽灵公司" } }),
  });
  assert.equal(res.status, 200, "作答本身仍然成功（行照样落地）");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(prompts.length, 0, "不存在的会话不接收回灌");
  assert.equal(viewers.filter((v) => v.data?.type === "user").length, 0, "也不推一条用户可见消息");
});

test("5.2d 会话属于别人时不投递", async () => {
  prompts = [];
  chatHistory.createSession("s-foreign", "someone-else@example.com");
  ctx.turnStateBySession.delete("s-foreign");
  const { body } = await create({ sessionId: "s-foreign" });
  currentUser = { email: "owner@example.com", groups: [] };
  await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { customer: "越界公司" } }),
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(prompts.length, 0, "别人的会话不接收这张卡的答案");
});

test("5.2e 回合结束后表里仍留着条目——回灌照样发生（条目存在≠回合在跑）", async () => {
  // 线上形态：ws.js 收尾只把 isStreaming 置 false，条目留在 turnStateBySession 里。
  // 旧判据（表里有条目就 return）于是让任何跑过回合的会话永远收不到回灌。
  prompts = [];
  viewers = [];
  ctx.turnStateBySession.set("s-deliver", { sessionId: "s-deliver", isStreaming: false });
  try {
    const { body } = await create();
    currentUser = { email: "owner@example.com", groups: [] };
    await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { customer: "己公司" } }),
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(prompts.length, 1, "回合已结束（条目仍在）时答案要开新回合");
    assert.match(prompts[0].text, /己公司/);
  } finally {
    ctx.turnStateBySession.delete("s-deliver");
  }
});

test("5.4 回环子进程没报会话时，归属到唯一在跑的回合（线上形态：session_id=null 导致卡不 pending）", async () => {
  // dsh 的 MCP 子进程一个 profile 一个，环境里没有会话 id；提卡发生在某回合的
  // 工具调用内，所以「此刻唯一在 streaming 的会话」就是它的归属。
  const before = await (await fetch(`${base}/api/input-requests`, {
    method: "GET",
  }).catch(() => null)) ?? null;
  void before;
  currentUser = { email: "owner@example.com", groups: [], internal: true };
  ctx.turnStateBySession.set("s-streaming", { sessionId: "s-streaming", isStreaming: true });
  try {
    const res = await fetch(`${base}/api/input-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerEmail: "owner@example.com",
        card: { type: "form", title: "无会话自报", fields: [{ key: "a", kind: "text" }] },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.sessionId, "s-streaming", "唯一在跑的回合就是归属");
  } finally {
    ctx.turnStateBySession.delete("s-streaming");
  }
});

test("5.4b 有多个回合在跑就不猜：留空而不是挂到别人头上", async () => {
  currentUser = { email: "owner@example.com", groups: [], internal: true };
  ctx.turnStateBySession.set("s-a", { sessionId: "s-a", isStreaming: true });
  ctx.turnStateBySession.set("s-b", { sessionId: "s-b", isStreaming: true });
  try {
    const res = await fetch(`${base}/api/input-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerEmail: "owner@example.com",
        card: { type: "form", title: "并发", fields: [{ key: "a", kind: "text" }] },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.sessionId, null, "并发时如实留空");
  } finally {
    ctx.turnStateBySession.delete("s-a");
    ctx.turnStateBySession.delete("s-b");
  }
});

test("5.4c 浏览器调用方不推断归属", async () => {
  currentUser = { email: "owner@example.com", groups: [] };
  ctx.turnStateBySession.set("s-live", { sessionId: "s-live", isStreaming: true });
  try {
    const res = await fetch(`${base}/api/input-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card: { type: "form", title: "人在场", fields: [{ key: "a", kind: "text" }] } }),
    });
    const body = await res.json();
    assert.equal(body.sessionId, null, "非回环调用方不推断");
  } finally {
    ctx.turnStateBySession.delete("s-live");
  }
});

test("5.5 提卡帧带上正在跑的工具调用 id（卡片在工具返回前就能认领）", async () => {
  // 线上形态：工具要等满等待窗口才返回，这段窗口内卡片只有拿到 toolCallId 才能
  // 认领成可填写的那张；否则人看着一张只读的「等待填写」。
  currentUser = { email: "owner@example.com", groups: [], internal: true };
  ctx.turnStateBySession.set("s-live-call", {
    sessionId: "s-live-call",
    isStreaming: true,
    blocks: [
      { kind: "tool", id: "call_other", name: "mcp__fleet__report_status" },
      { kind: "tool", id: "call_ir_1", name: "mcp__input-request__request_input", args: {} },
    ],
  });
  const frames = [];
  const origSend = ctx.sendToViewers;
  ctx.sendToViewers = (sid, data) => { frames.push({ sid, data }); };
  try {
    const res = await fetch(`${base}/api/input-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerEmail: "owner@example.com",
        card: { type: "form", title: "带调用 id", fields: [{ key: "a", kind: "text" }] },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.toolCallId, "call_ir_1", "响应里带正在跑的调用 id");
    const frame = frames.find((f) => f.data?.type === "input_request");
    assert.equal(frame?.data?.request?.toolCallId, "call_ir_1", "广播帧同样带");
    assert.equal(frame?.sid, "s-live-call");
  } finally {
    ctx.sendToViewers = origSend;
    ctx.turnStateBySession.delete("s-live-call");
  }
});

test("5.5b 浏览器提卡不带 toolCallId（不猜）", async () => {
  currentUser = { email: "owner@example.com", groups: [] };
  ctx.turnStateBySession.set("s-live-call2", {
    sessionId: "s-live-call2",
    isStreaming: true,
    blocks: [{ kind: "tool", id: "call_x", name: "mcp__input-request__request_input" }],
  });
  try {
    const res = await fetch(`${base}/api/input-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card: { type: "form", title: "人提的", fields: [{ key: "a", kind: "text" }] } }),
    });
    const body = await res.json();
    assert.equal(body.toolCallId, undefined);
  } finally {
    ctx.turnStateBySession.delete("s-live-call2");
  }
});

test("5.3 escalate：写进拍板队列并标记 escalated", async () => {
  const fdb = getFleetDatabase();
  fdb.createFleet({ id: "f-esc", name: "f-esc", ownerEmail: "owner@example.com" });
  fdb.createMember({
    id: "m-esc",
    fleetId: "f-esc",
    title: "运营",
    targetKind: "persona",
    targetId: "p-esc",
    kpiSlots: [],
    cadence: null,
  });

  const now = Date.now();
  const request = core.createInputRequest(dbMod.getDb(), {
    id: "esc-1",
    ownerEmail: "owner@example.com",
    sessionId: "s-deliver",
    fleetId: "f-esc",
    memberId: "m-esc",
    card: {
      type: "choice",
      title: "选一个渠道",
      fields: [{ key: "ch", kind: "enum", required: true, options: ["线上", "线下"] }],
    },
    policy: { onUnattended: "escalate", ttlSec: 1 },
    now: now - 5000,
  });
  assert.equal(request.state, "pending");

  const { escalateInputRequestToFleet } = await import("../server/routes/input-requests.js");
  const settled = core.expireDueInputRequests(dbMod.getDb(), { now, escalate: escalateInputRequestToFleet });
  const row = settled.find((r) => r.id === "esc-1");
  assert.equal(row.state, "escalated");
  assert.ok(row.escalatedDecisionId);

  const decision = fdb.getDecision(row.escalatedDecisionId);
  assert.equal(decision.state, "open");
  assert.match(decision.question, /选一个渠道/);
});

test("5.3b 没有舰队可升级时 fail-closed 成 expired，不假装升级", async () => {
  const now = Date.now();
  core.createInputRequest(dbMod.getDb(), {
    id: "esc-2",
    ownerEmail: "owner@example.com",
    sessionId: "s-deliver",
    card: { type: "form", title: "t", fields: [{ key: "a", kind: "text" }] },
    policy: { onUnattended: "escalate", ttlSec: 1 },
    now: now - 5000,
  });
  const { escalateInputRequestToFleet } = await import("../server/routes/input-requests.js");
  const settled = core.expireDueInputRequests(dbMod.getDb(), { now, escalate: escalateInputRequestToFleet });
  const row = settled.find((r) => r.id === "esc-2");
  assert.equal(row.state, "expired");
  assert.equal(row.escalatedDecisionId, null);
});
