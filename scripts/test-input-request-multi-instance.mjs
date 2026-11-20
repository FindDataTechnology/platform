// 多实例水合（add-input-request-cards, task 6.3）：
//
// 实例 A 提出并挂着长轮询，实例 B（另一个进程的等价物：另一个 app + 另一份
// 等待表）作答。A 的等待者必须靠**轮询数据库**发现答案——这正是 design D1
// 里「行是唯一真源」的可测形态。若把答案只写在进程内存，这个用例会挂起。
//
// 这里用两个独立的 express app 模拟两台实例；共享同一个库文件（生产里是
// 同一个 cell 库）。等待表是两个模块实例自己的，不会互通。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "input-request-multi-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;

const dbMod = await import("../db.js");
const { registerInputRequestRoutes } = await import("../server/routes/input-requests.js");

const owner = { email: "owner@example.com", groups: [] };

function makeInstance() {
  const ctx = {
    app: null,
    clients: new Set(),
    broadcast: () => {},
    sendToViewers: () => {},
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = owner;
    next();
  });
  ctx.app = app;
  registerInputRequestRoutes(ctx);
  return app;
}

let serverA;
let serverB;
let baseA;
let baseB;

before(async () => {
  await dbMod.initDb();
  const a = makeInstance();
  const b = makeInstance();
  await new Promise((resolve) => {
    serverA = a.listen(0, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => {
    serverB = b.listen(0, "127.0.0.1", resolve);
  });
  baseA = `http://127.0.0.1:${serverA.address().port}`;
  baseB = `http://127.0.0.1:${serverB.address().port}`;
});

after(async () => {
  await new Promise((r) => serverA.close(r));
  await new Promise((r) => serverB.close(r));
});

test("6.3 实例 A 提出、实例 B 作答：A 的等待者靠轮询拿到答案", async () => {
  // A 提卡
  const created = await (
    await fetch(`${baseA}/api/input-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "s-multi",
        card: {
          type: "form",
          title: "跨实例补信息",
          fields: [{ key: "note", kind: "text", required: true }],
        },
      }),
    })
  ).json();
  assert.equal(created.state, "pending");

  // A 开始长轮询（timeout 给足，跨实例靠 poll 发现）
  const waiting = fetch(`${baseA}/api/input-requests/${created.requestId}/wait?timeoutMs=5000`);

  // B 作答（另一个模块实例的等待表里没有这个 id）
  await new Promise((r) => setTimeout(r, 100));
  const answered = await fetch(`${baseB}/api/input-requests/${created.requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { note: "来自实例 B" } }),
  });
  assert.equal(answered.status, 200);

  const settled = await (await waiting).json();
  assert.equal(settled.state, "answered");
  assert.equal(settled.values.note, "来自实例 B");
});

test("6.3b 两实例同时作答：只有一个生效", async () => {
  const created = await (
    await fetch(`${baseA}/api/input-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "s-multi-2",
        card: { type: "form", title: "t", fields: [{ key: "v", kind: "text", required: true }] },
      }),
    })
  ).json();

  const [r1, r2] = await Promise.all([
    fetch(`${baseA}/api/input-requests/${created.requestId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { v: "A" } }),
    }),
    fetch(`${baseB}/api/input-requests/${created.requestId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { v: "B" } }),
    }),
  ]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [200, 409], "exactly one submission wins");

  const row = await (await fetch(`${baseA}/api/input-requests/${created.requestId}`)).json();
  assert.equal(row.state, "answered");
  assert.ok(["A", "B"].includes(row.values.v));
});
