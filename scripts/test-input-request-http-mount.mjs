// Input-request over streamable HTTP (add-input-request-cards, task 2.5):
//
//   §1 无令牌 / 错令牌 → 401；未配令牌 → 404（端点等于不存在）。
//   §2 缺 owner 头 → 400。
//   §3 正路：MCP client over streamable-http 完成一次 request_input，答案由
//      平台骑在同一个行上返回——证明「无 userQuestions seam 的运行时也能问」
//      这条要求是可测的，不依赖任何 harness 私有扩展。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "input-request-http-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
// fleets 走独立库：钉住 data 根，避免测试写进仓库的 data/。
process.env.PLATFORM_DATA_DIR = tmpRoot;

const TOKEN = "test-input-request-token";
process.env.INPUT_REQUEST_MCP_TOKEN = TOKEN;

const dbMod = await import("../db.js");
const { registerInputRequestRoutes } = await import("../server/routes/input-requests.js");
const { mountInputRequestMcp, INPUT_REQUEST_MCP_PATH } = await import("../server/input-request-http.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);

let server;
let base;
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
  mountInputRequestMcp(app, { token: TOKEN });
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function post(headers = {}, body = { jsonrpc: "2.0", id: 1, method: "tools/list" }) {
  return fetch(`${base}${INPUT_REQUEST_MCP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

test("2.5 无令牌 → 401", async () => {
  const res = await post();
  assert.equal(res.status, 401);
});

test("2.5b 错令牌 → 401", async () => {
  const res = await post({ authorization: "Bearer wrong" });
  assert.equal(res.status, 401);
});

test("2.5c 缺 owner 头 → 400", async () => {
  const res = await post({ authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "owner_required");
});

test("2.5d 未配令牌时端点不存在（404）", async () => {
  const noToken = express();
  noToken.use(express.json());
  mountInputRequestMcp(noToken, { token: "" });
  const srv = await new Promise((resolve) => {
    const s = noToken.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = srv.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${INPUT_REQUEST_MCP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 404);
  await new Promise((r) => srv.close(r));
});

test("2.5e 正路：HTTP 挂载完成一次 request_input", async () => {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${INPUT_REQUEST_MCP_PATH}`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-input-request-owner": "owner@example.com",
        "x-input-request-session": "s-http",
      },
    },
  });
  const client = new Client({ name: "http-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "request_input");

    const pending = client.callTool({
      name: "request_input",
      arguments: {
        card: {
          type: "confirm",
          title: "确认发货吗",
          fields: [{ key: "ok", kind: "boolean", required: true }],
        },
      },
    });

    let requestId = null;
    for (let i = 0; i < 60 && !requestId; i++) {
      await new Promise((r) => setTimeout(r, 50));
      currentUser = { email: "owner@example.com", groups: [] };
      const list = await (await fetch(`${base}/api/input-requests?sessionId=s-http`)).json();
      requestId = list.requests?.[0]?.requestId ?? null;
    }
    assert.ok(requestId, "HTTP-mounted tool should have created a request");

    const ans = await fetch(`${base}/api/input-requests/${requestId}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { ok: true } }),
    });
    assert.equal(ans.status, 200);

    const result = await pending;
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.state, "answered");
    assert.deepEqual(payload.values, { ok: true });
  } finally {
    await client.close().catch(() => {});
  }
});
