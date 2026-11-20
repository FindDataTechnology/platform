#!/usr/bin/env node
// ── 存档读面的 MCP 工具（任务 6.1b）─────────────────────────────────────────
//
// 两件事必须同时成立，缺一件这条工具面就不能交给 agent：
//   1. **工具面注册**：三个工具名、必填参数、上限夹取都对
//   2. **同意边界在工具层仍成立**：未同意存档的会话，既列不出来、也取不出消息、
//      检索里也搜不到；而且取不到时要**说出原因**，不是静默返回空数组
//
// 第 2 条的"说出原因"是有实际后果的：agent 看到空数组会换个角度重试，看到
// "该会话未同意存档"才会停手。这也是为什么边界做在工具层，而不只靠查询层。
//
//   node --test scripts/test-archive-mcp.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/store.js");
const { TOOLS, createArchiveTools } = await import("../server/archive/mcp.js");

const NOW = 1_700_000_000_000;
/** 只可能来自本夹具的串：用来断言"未同意会话的内容一个字都没漏"。 */
const BLOCKED_TEXT = "CANARY_BLOCKED_会话正文_9f3a1d";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

function seed(db) {
  // 已同意：有对方发言 + 本方回复
  store.upsertConversation(db, {
    conversationId: "room-agreed",
    kind: "room",
    name: "已同意群",
    agreeState: "agree",
    agreeAt: NOW - 1000,
    updatedAt: NOW,
  });
  store.insertMessage(db, {
    id: "room-agreed:m1",
    conversationId: "room-agreed",
    msgId: "m1",
    seq: 1,
    sentAt: NOW - 3000,
    sender: "客户A",
    origin: "peer",
    msgType: "text",
    text: "预算大概五十万，你们能做吗",
  });
  store.insertMessage(db, {
    id: "room-agreed:m2",
    conversationId: "room-agreed",
    msgId: "m2",
    seq: 2,
    sentAt: NOW - 2000,
    sender: "成员B",
    origin: "self",
    msgType: "text",
    text: "可以，我先发一版方案给你",
  });
  store.refreshConversationStats(db, "room-agreed");

  // 未同意：内容存在库里，但一切读面都不得返回
  store.upsertConversation(db, {
    conversationId: "room-blocked",
    kind: "room",
    name: "未同意群",
    agreeState: "disagree",
    updatedAt: NOW,
  });
  store.insertMessage(db, {
    id: "room-blocked:m1",
    conversationId: "room-blocked",
    msgId: "m9",
    seq: 9,
    sentAt: NOW - 1000,
    sender: "客户C",
    origin: "peer",
    msgType: "text",
    text: BLOCKED_TEXT,
  });
  store.refreshConversationStats(db, "room-blocked");
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test("工具面注册：三个工具名与必填参数", () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names, ["archive_conversations", "archive_messages", "archive_search"]);
  const messages = TOOLS.find((t) => t.name === "archive_messages");
  assert.deepEqual(messages.inputSchema.required, ["conversationId"]);
  const search = TOOLS.find((t) => t.name === "archive_search");
  assert.deepEqual(search.inputSchema.required, ["query"]);
  assert.deepEqual(search.inputSchema.properties.scope.enum, ["peer", "all"]);
});

test("archive_conversations：只列已同意存档的会话", () => {
  const db = freshDb();
  seed(db);
  const impl = createArchiveTools({ db });
  const out = parse(impl.call("archive_conversations", {}));
  assert.deepEqual(
    out.conversations.map((c) => c.conversationId),
    ["room-agreed"],
    "未同意的会话不得出现在列表里",
  );
});

test("archive_messages：未同意时明确拒绝，且正文一个字都不返回", () => {
  const db = freshDb();
  seed(db);
  const impl = createArchiveTools({ db });
  const res = impl.call("archive_messages", { conversationId: "room-blocked" });
  assert.equal(res.isError, true, "应作为工具错误返回");
  assert.ok(!res.content[0].text.includes(BLOCKED_TEXT), "拒绝时不得带出正文");
  const body = parse(res);
  assert.equal(body.agreeState, "disagree");
  assert.ok(/未同意存档/.test(body.error), body.error);
});

test("archive_messages：不存在的会话与未同意要能分开表述", () => {
  const db = freshDb();
  seed(db);
  const impl = createArchiveTools({ db });
  const missing = parse(impl.call("archive_messages", { conversationId: "room-never-seen" }));
  assert.equal(missing.agreeState, "unknown");
  assert.ok(/不存在|状态未知/.test(missing.error), missing.error);

  const blocked = parse(impl.call("archive_messages", { conversationId: "room-blocked" }));
  assert.equal(blocked.agreeState, "disagree");
  assert.ok(!/不存在/.test(blocked.error), "已存在的会话不该被说成不存在");
});

test("archive_messages：已同意会话按时间正序返回", () => {
  const db = freshDb();
  seed(db);
  const impl = createArchiveTools({ db });
  const out = parse(impl.call("archive_messages", { conversationId: "room-agreed" }));
  assert.deepEqual(out.messages.map((m) => m.msgId), ["m1", "m2"]);
});

test("archive_search：默认只搜对方发言，scope=all 才带上本方", () => {
  const db = freshDb();
  seed(db);
  const impl = createArchiveTools({ db });

  const peerOnly = parse(impl.call("archive_search", { query: "方案" }));
  assert.equal(peerOnly.scope, "peer");
  assert.equal(peerOnly.results.length, 0, "本方说过的话不该被当成客户需求搜出来");

  const all = parse(impl.call("archive_search", { query: "方案", scope: "all" }));
  assert.equal(all.results.length, 1);
  assert.equal(all.results[0].origin, "self");
});

test("archive_search：未同意会话的内容搜不到", () => {
  const db = freshDb();
  seed(db);
  const impl = createArchiveTools({ db });
  const out = parse(impl.call("archive_search", { query: "CANARY_BLOCKED" }));
  assert.equal(out.results.length, 0, "同意边界在检索面同样成立");
});

test("limit 被夹住：超上限不会把整库吐出来", () => {
  const db = freshDb();
  seed(db);
  const impl = createArchiveTools({ db });
  const out = parse(impl.call("archive_messages", { conversationId: "room-agreed", limit: 1e9 }));
  assert.ok(out.messages.length <= 200);
});

test("缺参 / 未知工具：返回工具错误而不是抛异常", () => {
  const db = freshDb();
  seed(db);
  const impl = createArchiveTools({ db });
  assert.equal(impl.call("archive_messages", {}).isError, true);
  assert.equal(impl.call("archive_search", {}).isError, true);
  const unknown = impl.call("archive_delete_everything", {});
  assert.equal(unknown.isError, true);
  assert.ok(/未知工具/.test(parse(unknown).error));
});

// 只读是这条工具面的承诺：没有任何写入工具可被调用。
test("工具面只读：不存在任何写入类工具名", () => {
  assert.equal(
    TOOLS.some((t) => /delete|write|update|insert|remove|drop/i.test(t.name)),
    false,
    `工具面出现了写入类名字：${TOOLS.map((t) => t.name).join(", ")}`,
  );
});

// 传输层注册 + stdout 纯净度。
// stdio 通道上 stdout 只能出 JSON-RPC：任何一句 console.log 都会把协议打断，
// 而那种坏法在"工具函数单测"里完全看不出来（单测不经过传输层）。
test("stdio 传输层：initialize + tools/list 都能通，且 stdout 只有 JSON-RPC", async () => {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(here, "..", "server", "archive", "mcp.js");

  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ARCHIVE_DB: ":memory:" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", () => {});

  /** 等到 stdout 里出现某条 JSON-RPC 响应，或超时。 */
  const waitForResponse = async (id, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = stdout
        .split("\n")
        .filter(Boolean)
        .some((l) => {
          try {
            return JSON.parse(l).id === id;
          } catch {
            return false;
          }
        });
      if (hit) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  // 等的是响应，不是固定时长。早先写死 300ms + 900ms，机器一忙（冷启动 + 加载
  // MCP SDK 超过 1.2s）整条就空手而归，报成"stdio 坏了"，其实是测试自己的计时器
  // 太紧。间歇红比没有测试更坏——它教人忽略红灯。
  await waitForResponse(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await waitForResponse(2);
  child.kill("SIGKILL");

  const lines = stdout.trim().split("\n").filter(Boolean);
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { __notJson: l };
    }
  });
  const notJson = parsed.filter((r) => r.__notJson);
  assert.equal(notJson.length, 0, `stdout 出现了非 JSON-RPC 输出：${JSON.stringify(notJson).slice(0, 200)}`);

  const list = parsed.find((r) => r.id === 2);
  assert.ok(list, `没收到 tools/list 响应，stdout=${stdout.slice(0, 400)}`);
  assert.deepEqual(list.result.tools.map((t) => t.name), [
    "archive_conversations",
    "archive_messages",
    "archive_search",
  ]);
});

