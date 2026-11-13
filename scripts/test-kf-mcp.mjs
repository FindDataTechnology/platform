#!/usr/bin/env node
// ── 微信客服：agent 工具面（add-kf-agent-tools）──────────────────────────────
//
// 这一层存在的理由不是"多一个入口"，而是"少一个坑"。五条都对应真实的错法：
//
//   1. **工具面混进写操作** → agent 某次"顺手回一句"就发给真实客户了。所以断言
//      工具名集合精确相等，且没有 send/reply/pull/download 这类名字。
//   2. **默认把本方回复也喂回去** → agent 对着自己昨天说的话再答一遍。
//   3. **系统事件混进结果** → agent 对着"客户已进入会话"写一段回答（这条通道最早的坑）。
//   4. **附件正文换了个整形口径** → kf_messages 与 HTTP 面/CLI 给出不同的形状。
//      这里断言正文与状态都随消息带出，未抽取时给 status+reason，不给空串。
//   5. **stdout 掺日志** → stdio 就是协议本身，一句 console.log 就打断 JSON-RPC，
//      而这种坏法在工具函数单测里完全看不出来。
//
//   node --test scripts/test-kf-mcp.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/kf/store.js");
const { TOOLS, MCP_LIMITS, createKfTools } = await import("../server/archive/kf/mcp.js");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const CONV = "kf1|u1";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureKfSchema(db);
  store.upsertKfConversation(db, { conversationId: CONV, openKfId: "kf1", externalUserId: "u1" });
  return db;
}

function seed(db, { msgId, origin, at = NOW, text = "", media = false }) {
  const id = `${CONV}:${msgId}`;
  store.insertKfMessage(db, {
    id,
    conversationId: CONV,
    msgId,
    openKfId: "kf1",
    externalUserId: "u1",
    sentAt: at,
    origin,
    msgType: media ? "file" : "text",
    text,
    mediaId: media ? `MID-${msgId}` : null,
    mediaType: media ? "file" : null,
    ingestedAt: at,
  });
  if (media) {
    store.queueKfMedia(db, { id, messageId: id, conversationId: CONV, mediaId: `MID-${msgId}`, mediaType: "file" });
  }
  store.refreshKfConversationStats(db, CONV);
  return id;
}

/** 去掉 MCP 的 content 包装，只拿载荷。 */
function payload(res) {
  return JSON.parse(res.content[0].text);
}

function tools(db) {
  return createKfTools({ db, now: () => NOW });
}

// ── ① 只读：工具名与集合 ───────────────────────────────────────────────────

test("只有四个读工具，且没有任何发送/拉取/下载工具", () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name),
    ["kf_conversations", "kf_messages", "kf_search", "kf_attachment"],
  );
  for (const t of TOOLS) {
    assert.ok(t.description && t.description.length > 10, `${t.name} 必须写清用途`);
    assert.equal(t.inputSchema?.type, "object", `${t.name} 必须有 inputSchema`);
    assert.ok(!/send|reply|pull|download|fetch|upload/i.test(t.name), `${t.name} 不该是写操作`);
  }
});

test("未知工具明确拒绝", () => {
  const db = freshDb();
  const res = tools(db).call("kf_send_reply", {});
  assert.equal(res.isError, true);
  assert.match(payload(res).error, /未知工具/);
});

// ── ② 默认只给客户发言 ────────────────────────────────────────────────────

test("默认只返回客户发言：本方回复与系统事件都不出现", () => {
  const db = freshDb();
  seed(db, { msgId: "p1", origin: "peer", text: "麻烦发份报价单" });
  seed(db, { msgId: "s1", origin: "self", text: "好的马上发" });
  seed(db, { msgId: "e1", origin: "system", text: "客户已进入会话" });

  const out = payload(tools(db).call("kf_messages", { conversationId: CONV }));
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].origin, "peer");
  assert.equal(out.messages[0].text, "麻烦发份报价单");
});

test("显式 includeSelf 才带本方回复，系统事件仍然不出现", () => {
  const db = freshDb();
  seed(db, { msgId: "p1", origin: "peer", text: "问题一" });
  seed(db, { msgId: "s1", origin: "self", text: "答复一" });
  seed(db, { msgId: "e1", origin: "system", text: "会话结束" });

  const out = payload(tools(db).call("kf_messages", { conversationId: CONV, includeSelf: true }));
  const origins = out.messages.map((m) => m.origin).sort();
  assert.deepEqual(origins, ["peer", "self"]);
  assert.ok(!out.messages.some((m) => /会话结束/.test(m.text || "")));
});

test("没有这个会话：明确拒绝，不回空数组", () => {
  const db = freshDb();
  const res = tools(db).call("kf_messages", { conversationId: "kfX|uX" });
  assert.equal(res.isError, true);
  assert.match(payload(res).error, /没有这个会话/);
});

test("缺 conversationId / query：明确拒绝", () => {
  const db = freshDb();
  assert.equal(tools(db).call("kf_messages", {}).isError, true);
  assert.equal(tools(db).call("kf_search", {}).isError, true);
  assert.equal(tools(db).call("kf_attachment", {}).isError, true);
});

// ── ③ 上限不可绕过 ────────────────────────────────────────────────────────

test("条数上限被夹取", () => {
  const db = freshDb();
  for (let i = 0; i < 8; i += 1) {
    seed(db, { msgId: `m${i}`, origin: "peer", at: NOW + i, text: `第${i}条` });
  }
  const out = payload(tools(db).call("kf_messages", { conversationId: CONV, limit: 3 }));
  assert.equal(out.messages.length, 3);

  const huge = payload(tools(db).call("kf_messages", { conversationId: CONV, limit: 999999 }));
  assert.ok(huge.messages.length <= MCP_LIMITS.messages, `不得超过 ${MCP_LIMITS.messages}`);
  assert.ok(huge.messages.length <= 8);
});

// ── ④ 附件正文随消息带出 ──────────────────────────────────────────────────

test("客户发来的附件：正文随消息带出（类型/字符数/是否截断）", () => {
  const db = freshDb();
  const id = seed(db, { msgId: "f1", origin: "peer", media: true });
  store.putKfAttachmentText(db, { messageId: id, kind: "xlsx", text: "产品|含税单价\nA|12.5", chars: 18 });

  const out = payload(tools(db).call("kf_messages", { conversationId: CONV }));
  const att = out.messages[0].attachment;
  assert.equal(att.status, "extracted");
  assert.equal(att.kind, "xlsx");
  assert.equal(att.chars, 18);
  assert.equal(att.truncated, false);
  assert.match(att.text, /含税单价/);
});

test("附件没抽出来：给状态与原因，不给空正文", () => {
  const db = freshDb();
  const id = seed(db, { msgId: "f2", origin: "peer", media: true });
  store.markKfMedia(db, { id, state: "done", bytes: 10, path: "/tmp/f2" });
  store.markKfExtract(db, { id, state: "no_extractor", error: "没有可用的解析器" });

  const att = payload(tools(db).call("kf_messages", { conversationId: CONV })).messages[0].attachment;
  assert.equal(att.status, "no_extractor");
  assert.equal(att.text, undefined, "不能给空串让 agent 以为客户什么都没发");
  assert.match(att.reason, /解析器/);
});

// ── ⑤ 检索命中附件正文 ────────────────────────────────────────────────────

test("检索命中附件正文并标出命中在附件", () => {
  const db = freshDb();
  const id = seed(db, { msgId: "f3", origin: "peer", media: true });
  store.putKfAttachmentText(db, { messageId: id, kind: "xlsx", text: "含税单价 12.5", chars: 9 });

  const out = payload(tools(db).call("kf_search", { query: "含税单价" }));
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].matchedIn, "attachment");
});

test("检索默认不搜本方回复", () => {
  const db = freshDb();
  seed(db, { msgId: "s1", origin: "self", text: "我们含税单价是 12.5" });
  assert.equal(payload(tools(db).call("kf_search", { query: "含税单价" })).messages.length, 0);
  assert.equal(
    payload(tools(db).call("kf_search", { query: "含税单价", includeSelf: true })).messages.length,
    1,
  );
});

// ── ⑥ 单条取附件全文 ──────────────────────────────────────────────────────

test("kf_attachment：有正文时按 maxChars 截断，chars 仍报原文长度", () => {
  const db = freshDb();
  const id = seed(db, { msgId: "f4", origin: "peer", media: true });
  store.putKfAttachmentText(db, { messageId: id, kind: "xlsx", text: "一二三四五六七八九十", chars: 10 });

  const out = payload(tools(db).call("kf_attachment", { messageId: id, maxChars: 4 }));
  assert.equal(out.ok, true);
  assert.equal(out.text.length, 4);
  assert.equal(out.chars, 10, "chars 是截断前的真实长度");
  assert.equal(out.truncated, true);
});

test("kf_attachment：未抽取给 state + reason；无附件记录明确说没有", () => {
  const db = freshDb();
  const id = seed(db, { msgId: "f5", origin: "peer", media: true });
  store.markKfMedia(db, { id, state: "done", bytes: 5, path: "/tmp/f5" });
  store.markKfExtract(db, { id, state: "timeout", error: "解析办公文档 超过 15000ms" });

  const notExtracted = payload(tools(db).call("kf_attachment", { messageId: id }));
  assert.equal(notExtracted.ok, false);
  assert.equal(notExtracted.state, "timeout");
  assert.match(notExtracted.reason, /15000/);

  const noRecord = tools(db).call("kf_attachment", { messageId: "kf1|u1:none" });
  assert.equal(noRecord.isError, true);
  assert.match(payload(noRecord).error, /没有附件记录/);
});

// ── ⑦ 会话列表带窗口 ──────────────────────────────────────────────────────

test("会话列表：带最后发言时间与 48h 窗口剩余", () => {
  const db = freshDb();
  seed(db, { msgId: "p1", origin: "peer", at: NOW - 2 * HOUR, text: "在吗" });

  const out = payload(tools(db).call("kf_conversations", {}));
  assert.equal(out.conversations.length, 1);
  const c = out.conversations[0];
  assert.equal(c.conversationId, CONV);
  assert.equal(c.lastPeerAt, NOW - 2 * HOUR);
  assert.equal(c.window.open, true);
  assert.ok(c.window.hoursLeft > 45 && c.window.hoursLeft <= 46, `hoursLeft=${c.window.hoursLeft}`);
  assert.equal(out.replyWindowHours, 48);
});

test("会话列表：客户从未发言时窗口是关的，不编造", () => {
  const db = freshDb();
  seed(db, { msgId: "e1", origin: "system", text: "客户已进入会话" });
  const c = payload(tools(db).call("kf_conversations", {})).conversations[0];
  assert.equal(c.window.open, false);
  assert.match(c.window.reason, /从未发言/);
});

// ── ⑧ stdio 传输层 + stdout 纯净 ──────────────────────────────────────────

test("stdio 传输层：initialize + tools/list 都能通，且 stdout 只有 JSON-RPC", async () => {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(here, "..", "server", "archive", "kf", "mcp.js");
  const dir = mkdtempSync(path.join(tmpdir(), "kf-mcp-"));
  const dbFile = path.join(dir, "kf.db");

  const child = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, KF_DB: dbFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", () => {});

  const waitForResponse = async (id, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const line of stdout.split("\n").filter(Boolean)) {
        try {
          if (JSON.parse(line).id === id) return;
        } catch {
          /* 非 JSON 的行留给最后的纯净度断言 */
        }
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`等不到 id=${id} 的响应，stdout=${stdout.slice(0, 400)}`);
  };

  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

  try {
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
    await waitForResponse(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitForResponse(2);
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }

  const lines = stdout.trim().split("\n").filter(Boolean);
  const parsed = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { __notJson: l };
    }
  });
  const notJson = parsed.filter((p) => p.__notJson);
  assert.equal(notJson.length, 0, `stdout 出现非 JSON-RPC 输出：${JSON.stringify(notJson).slice(0, 200)}`);

  const list = parsed.find((r) => r.id === 2);
  assert.ok(list, `没收到 tools/list，stdout=${stdout.slice(0, 400)}`);
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ["kf_conversations", "kf_messages", "kf_search", "kf_attachment"],
  );
});

// ── ⑨ 入口本身 ────────────────────────────────────────────────────────────

test("空库启动不报错：列表与检索返回空，取消息明确说没有这个会话", () => {
  const db = new DatabaseSync(":memory:");
  store.ensureKfSchema(db);
  const t = tools(db);
  assert.deepEqual(payload(t.call("kf_conversations", {})).conversations, []);
  assert.deepEqual(payload(t.call("kf_search", { query: "任意" })).messages, []);
  // 空库时按 id 取消息：明确拒绝比空数组好——空数组会让 agent 换个 id 再试。
  const res = t.call("kf_messages", { conversationId: CONV });
  assert.equal(res.isError, true);
  assert.match(payload(res).error, /没有这个会话/);
});
