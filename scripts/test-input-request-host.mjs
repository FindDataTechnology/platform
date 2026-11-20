// Input-request host wiring (add-input-request-cards, tasks 2.1-2.2):
//
//   §1 五条路径的状态码与错误码（提卡 / 取一张 / 长轮询 / 作答 / 取消 / 列表），
//      含无身份、他人请求、分享会话式的无 cookie 请求三条拒绝路径。
//   §2 长轮询：未到期时返回 {pending:true}，续等后拿到答案；断线重读从行上取回。
//
// 无 LLM、无网络：真 express app + 临时库，鉴权关（dev 形态），身份用
// test-only 中间件注入——与 e2e 的 machine-owner 形态同构。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "input-request-host-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
// fleets 走独立库：钉住 data 根，避免测试写进仓库的 data/。
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.AUTH_MODE = "";

const dbMod = await import("../db.js");
const { registerInputRequestRoutes } = await import("../server/routes/input-requests.js");

let server;
let base;
let currentUser = { email: "owner@example.com", groups: [] };
let sendToViewersCalls = [];

const ctx = {
  app: null,
  clients: new Set(),
  broadcast: () => {},
  sendToViewers: (sessionId, data) => sendToViewersCalls.push({ sessionId, data }),
};

before(async () => {
  await dbMod.initDb();
  const app = express();
  app.use(express.json());
  // 身份注入：与 forward-auth 的产物同形（req.user）。
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

const CARD = {
  type: "form",
  title: "补齐交付信息",
  fields: [{ key: "customer", kind: "text", required: true }],
};

async function create(body = {}, user = { email: "owner@example.com", groups: [] }) {
  currentUser = user;
  const res = await fetch(`${base}/api/input-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ card: CARD, sessionId: "s-1", ...body }),
  });
  return { res, body: await res.json().catch(() => ({})) };
}

test("2.1 提卡 → 201，卡片回显，会话视图收到广播", async () => {
  sendToViewersCalls = [];
  const { res, body } = await create();
  assert.equal(res.status, 201);
  assert.equal(body.state, "pending");
  assert.equal(body.card.title, "补齐交付信息");
  assert.ok(body.expiresAt > Date.now());
  assert.equal(sendToViewersCalls.length, 1);
  assert.equal(sendToViewersCalls[0].data.type, "input_request");
});

test("2.1b 非法卡 → 400 invalid_card，且逐项报错", async () => {
  currentUser = { email: "owner@example.com", groups: [] };
  const res = await fetch(`${base}/api/input-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ card: { type: "form", title: "t", fields: [{ key: "x", kind: "nope" }] } }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, "invalid_card");
  assert.ok(JSON.stringify(body.details).includes("nope"));
});

test("2.1c 他人请求不可读、不可答", async () => {
  const { body } = await create();
  currentUser = { email: "stranger@example.com", groups: [] };
  const read = await fetch(`${base}/api/input-requests/${body.requestId}`);
  assert.equal(read.status, 403);
  const answer = await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { customer: "X" } }),
  });
  assert.equal(answer.status, 403);
});

test("2.1d 匿名（无身份）一律 403", async () => {
  const { body } = await create();
  currentUser = undefined;
  const answer = await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { customer: "X" } }),
  });
  assert.equal(answer.status, 403);
  const list = await fetch(`${base}/api/input-requests`);
  assert.equal(list.status, 403);
});

test("2.1e 作答成功 → answered，二次作答 → 409 already_settled", async () => {
  const { body } = await create();
  currentUser = { email: "owner@example.com", groups: [] };
  const first = await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { customer: "甲公司" } }),
  });
  assert.equal(first.status, 200);
  const answered = await first.json();
  assert.equal(answered.state, "answered");
  assert.deepEqual(answered.values, { customer: "甲公司" });

  const second = await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { customer: "乙公司" } }),
  });
  assert.equal(second.status, 409);
  const conflict = await second.json();
  assert.equal(conflict.error, "answered");
  assert.equal(conflict.request.values.customer, "甲公司");
});

test("2.1f 校验失败 → 400 且行仍 pending", async () => {
  const { body } = await create();
  currentUser = { email: "owner@example.com", groups: [] };
  const res = await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: {} }),
  });
  assert.equal(res.status, 400);
  const check = await fetch(`${base}/api/input-requests/${body.requestId}`);
  const row = await check.json();
  assert.equal(row.state, "pending");
});

test("2.1g 取消 → cancelled；不存在的 id → 404", async () => {
  const { body } = await create();
  currentUser = { email: "owner@example.com", groups: [] };
  const res = await fetch(`${base}/api/input-requests/${body.requestId}/cancel`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).state, "cancelled");
  const missing = await fetch(`${base}/api/input-requests/ir_nope/wait`);
  assert.equal(missing.status, 404);
});

test("2.1h 列表只给我自己的待答", async () => {
  await create();
  currentUser = { email: "owner@example.com", groups: [] };
  const mine = await (await fetch(`${base}/api/input-requests?sessionId=s-1`)).json();
  assert.ok(mine.requests.length >= 1);
  for (const r of mine.requests) assert.equal(r.state, "pending");

  currentUser = { email: "nobody@example.com", groups: [] };
  const theirs = await (await fetch(`${base}/api/input-requests`)).json();
  assert.equal(theirs.requests.length, 0);
});

test("2.2 长轮询未到期返回 pending，续等后拿到答案", async () => {
  const { body } = await create();
  currentUser = { email: "owner@example.com", groups: [] };
  const firstPoll = fetch(`${base}/api/input-requests/${body.requestId}/wait?timeoutMs=1000`);
  setTimeout(async () => {
    await fetch(`${base}/api/input-requests/${body.requestId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { customer: "丙公司" } }),
    });
  }, 60);
  const settled = await (await firstPoll).json();
  assert.equal(settled.state, "answered");
  assert.equal(settled.values.customer, "丙公司");
});

test("2.2b 无人答时返回 pending:true（客户端据此续等，不是错误）", async () => {
  const { body } = await create();
  currentUser = { email: "owner@example.com", groups: [] };
  const res = await fetch(`${base}/api/input-requests/${body.requestId}/wait?timeoutMs=100`);
  assert.equal(res.status, 200);
  const body2 = await res.json();
  assert.equal(body2.pending, true);
  assert.equal(body2.requestId, body.requestId);
});

test("2.2c 断线重读从行上取回同一张卡", async () => {
  const { body } = await create();
  currentUser = { email: "owner@example.com", groups: [] };
  const reread = await (await fetch(`${base}/api/input-requests/${body.requestId}`)).json();
  assert.equal(reread.requestId, body.requestId);
  assert.equal(reread.card.title, "补齐交付信息");
  assert.equal(reread.state, "pending");
});
