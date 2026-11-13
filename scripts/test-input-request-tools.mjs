// Input-request tools (add-input-request-cards, tasks 2.3 + 2.5):
//
//   §1 stdio shim 的工具面：只有 request_input，schema 里点名七种字段类型。
//   §2 端到端：shim 提卡 → 平台长轮询 → 测试作答 → 工具结果带着
//      {state, values} 回到调用方。中途故意让第一轮等待超时（WAIT_MS 压到
//      200ms），验证「连接没结果 ≠ 没人答」的续等路径。
//   §3 无 owner 时工具失败且不落行——宁可报错，也不留一行没人能答的记录。
//
// 无 LLM、无网络：真 express app（临时库）+ 真 MCP client over stdio。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "input-request-tools-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
// fleets 走独立库：钉住 data 根，避免测试写进仓库的 data/。
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.INPUT_REQUEST_WAIT_MS = "200";

const dbMod = await import("../db.js");
const { registerInputRequestRoutes } = await import("../server/routes/input-requests.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

let server;
let base;
let child = null;
let client = null;
let currentUser = { email: "owner@example.com", groups: [] };

const ctx = {
  app: null,
  clients: new Set(),
  broadcast: () => {},
  sendToViewers: () => {},
};

before(async () => {
  await dbMod.initDb();
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
  if (client) await client.close().catch(() => {});
  if (child) await child.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
});

async function connectShim(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "server/input-request-mcp.js")],
    env: {
      ...process.env,
      INPUT_REQUEST_URL: base,
      INPUT_REQUEST_OWNER_EMAIL: "owner@example.com",
      INPUT_REQUEST_SESSION_ID: "s-tool",
      ...env,
    },
    stderr: "ignore",
  });
  const c = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await c.connect(transport);
  return c;
}

test("2.3 工具面只有 request_input，且点名七种字段类型", async () => {
  client = await connectShim();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "request_input");
  const desc = tools[0].inputSchema.properties.card.properties.fields.items.properties.kind.enum;
  assert.deepEqual(desc, ["text", "multiline", "number", "date", "enum", "boolean", "file"]);
});

test("2.3b 端到端：提卡 → 长轮询续等 → 作答 → 工具返回答案", async () => {
  const pending = client.callTool({
    name: "request_input",
    arguments: {
      card: {
        type: "form",
        title: "补齐交付信息",
        fields: [{ key: "customer", kind: "text", required: true }],
      },
    },
  });

  // 给 shim 一点时间把行写下来，然后由「人」作答。
  let requestId = null;
  for (let i = 0; i < 40 && !requestId; i++) {
    await new Promise((r) => setTimeout(r, 50));
    currentUser = { email: "owner@example.com", groups: [] };
    const list = await (await fetch(`${base}/api/input-requests?sessionId=s-tool`)).json();
    requestId = list.requests?.[0]?.requestId ?? null;
  }
  assert.ok(requestId, "shim should have created a request");

  const ans = await fetch(`${base}/api/input-requests/${requestId}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values: { customer: "甲公司" } }),
  });
  assert.equal(ans.status, 200);

  const result = await pending;
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.state, "answered");
  assert.equal(payload.values.customer, "甲公司");
  assert.equal(payload.requestId, requestId);
});

test("2.3c 无 owner 时工具失败且不落行", async () => {
  const anon = await connectShim({ INPUT_REQUEST_OWNER_EMAIL: "" });
  const before = (await (await fetch(`${base}/api/input-requests?sessionId=s-none`)).json()).requests;
  const result = await anon.callTool({
    name: "request_input",
    arguments: { card: { type: "form", title: "t", fields: [{ key: "a", kind: "text" }] } },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no owner identity/);
  currentUser = { email: "owner@example.com", groups: [] };
  const afterList = (await (await fetch(`${base}/api/input-requests?sessionId=s-none`)).json()).requests;
  assert.equal(afterList.length, before.length);
  await anon.close();
});

// §4 等待预算（2026-11-11 线上回归）：harness 给一次 tools/call 的预算是硬的
// （MCP SDK 默认 60s），等人填表天然超它。线上形态是工具被 SDK 掐成
// `Error: Request timed out`，行还 pending、卡片却已渲染成终态。所以工具必须
// 在自己的预算到点时**正常返回「挂起中」**，把后续交给平台的回灌。
test("2.4 预算到点没等到答案：返回 state=pending 且明说在等，而不是超时错误", async () => {
  const c = await connectShim({ INPUT_REQUEST_MAX_WAIT_MS: "600", INPUT_REQUEST_WAIT_MS: "200" });
  try {
    const t0 = Date.now();
    const res = await c.callTool({
      name: "request_input",
      arguments: {
        card: { type: "form", title: "没人答", fields: [{ key: "a", kind: "text" }] },
      },
    });
    const elapsed = Date.now() - t0;
    assert.ok(!res.isError, "不是错误结果");
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.state, "pending");
    assert.equal(payload.awaitingAnswer, true);
    assert.match(payload.note, /answer/i, "要告诉模型答案会作为新消息回来");
    assert.ok(elapsed < 5_000, `预算内返回（实际 ${elapsed}ms）`);
  } finally {
    await c.close().catch(() => {});
  }
});
