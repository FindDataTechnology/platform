#!/usr/bin/env node
// ── Query surface & parser tests (add-wecom-archive-ingest 2.4b, 4.1b, 5.2c, 6.1, 6.2)
//
// 读侧的三条硬判据：
//   1. **同意不可越权读**：`disagree` 的会话在查询面必须完全不可见（不是返回空数组了事，
//      而是连会话本身都列不出来）。
//   2. **两字中文词不能静默返回 0**：trigram 要求 ≥3 字符——这个坑在 fd-wx-local 已实测踩过，
//      这里用同一套修法（短词走 LIKE）并用断言钉住。
//   3. **本方发言默认不进检索结果**：否则 agent 会把自己昨天说的话当成客户新需求。
//
//   node --test scripts/test-archive-query.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/store.js");
const query = await import("../server/archive/query.js");
const { parseMessage, typeHistogram } = await import("../server/archive/parse.js");

const NOW = 1_700_000_000_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  query.ensureArchiveFts(db);
  return db;
}

function seed(db) {
  store.upsertConversation(db, {
    conversationId: "room_ok",
    kind: "group",
    name: "西海岸粉丝群",
    agreeState: "agree",
    agreeAt: NOW,
  });
  store.upsertConversation(db, {
    conversationId: "room_no",
    kind: "group",
    name: "拒绝存档的群",
    agreeState: "disagree",
    agreeAt: NOW,
  });
  store.upsertConversation(db, {
    conversationId: "room_unknown",
    kind: "single",
    name: "状态未知",
    agreeState: "unknown",
  });

  const rows = [
    ["room_ok:p1", "room_ok", "p1", "peer", "text", "明早9点见客户，合同要改", NOW - 3000],
    ["room_ok:p2", "room_ok", "p2", "peer", "text", "发票抬头写寻数科技", NOW - 2000],
    ["room_ok:s1", "room_ok", "s1", "self", "text", "客户那边我明天再去一趟", NOW - 1000],
    ["room_no:p3", "room_no", "p3", "peer", "text", "这条不该被搜到", NOW - 500],
    ["room_unknown:p4", "room_unknown", "p4", "peer", "text", "状态未知也不该被搜到", NOW - 400],
  ];
  for (const [id, conv, msgId, origin, type, text, sentAt] of rows) {
    store.insertMessage(db, {
      id,
      conversationId: conv,
      msgId,
      seq: 1,
      sentAt,
      sender: origin === "self" ? "zhangsan" : "wmCUST",
      origin,
      msgType: type,
      text,
      ingestedAt: NOW,
      mergeKey: `${conv}|${sentAt}|${origin}|${msgId}`,
    });
    store.refreshConversationStats(db, conv);
  }
}

test("会话列表：只列 agree，且默认只列有消息的", () => {
  const db = freshDb();
  seed(db);
  const list = query.listConversations(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].conversationId, "room_ok");
});

test("会话列表：disagree 的会话连名字都列不出来", () => {
  const db = freshDb();
  seed(db);
  const names = query.listConversations(db, { withMessagesOnly: false }).map((c) => c.name);
  assert.ok(!names.includes("拒绝存档的群"), "不同意的会话必须完全不可见");
});

test("取消息：disagree 会话返回空（不是抛错）", () => {
  const db = freshDb();
  seed(db);
  assert.deepEqual(query.getMessages(db, { conversationId: "room_no" }), []);
});

test("取消息：agree 会话按时间正序", () => {
  const db = freshDb();
  seed(db);
  const msgs = query.getMessages(db, { conversationId: "room_ok" });
  assert.equal(msgs.length, 3);
  assert.ok(msgs[0].sentAt <= msgs[1].sentAt);
});

test("检索：两字中文词必须命中（trigram 会静默返回 0）", () => {
  const db = freshDb();
  seed(db);
  const hits = query.search(db, { query: "合同" });
  assert.equal(hits.length, 1, "「合同」两字必须命中，否则就是假绿");
  const hits2 = query.search(db, { query: "发票" });
  assert.equal(hits2.length, 1);
});

test("检索：三字以上走 FTS 也能命中", () => {
  const db = freshDb();
  seed(db);
  const hits = query.search(db, { query: "见客户" });
  assert.equal(hits.length, 1);
});

test("检索：默认不含本方发言", () => {
  const db = freshDb();
  seed(db);
  const hits = query.search(db, { query: "客户" });
  assert.ok(hits.every((h) => h.origin === "peer"), "本方发言不应进检索结果");
  const all = query.search(db, { query: "客户", scope: "all" });
  assert.ok(all.some((h) => h.origin === "self"));
  assert.ok(all.length > hits.length);
});

test("检索：disagree 会话的内容搜不到", () => {
  const db = freshDb();
  seed(db);
  const hits = query.search(db, { query: "不该被搜到" });
  assert.equal(hits.length, 0);
});

test("检索：FTS 操作符字符不炸（- : * \"）", () => {
  const db = freshDb();
  seed(db);
  assert.doesNotThrow(() => query.search(db, { query: "a-b:c*" }));
});

test("检索：空查询返回空数组", () => {
  const db = freshDb();
  seed(db);
  assert.deepEqual(query.search(db, { query: "   " }), []);
});

test("FTS 由触发器维护：后插入的消息也能搜到", () => {
  const db = freshDb();
  seed(db);
  store.insertMessage(db, {
    id: "room_ok:late",
    conversationId: "room_ok",
    msgId: "late",
    seq: 2,
    sentAt: NOW,
    sender: "wmCUST",
    origin: "peer",
    msgType: "text",
    text: "新加的一条：报价单",
    ingestedAt: NOW,
    mergeKey: "k-late",
  });
  const hits = query.search(db, { query: "报价单" });
  assert.equal(hits.length, 1);
});

test("未覆盖原因分布：三类可分", () => {
  const db = freshDb();
  seed(db);
  db.prepare("UPDATE archive_conversation SET msg_count=0 WHERE conversation_id IN ('room_no','room_unknown')").run();
  const reasons = query.coverageReasons(db);
  assert.equal(reasons.total, 3);
  assert.equal(reasons.withMessages, 1);
  assert.equal(reasons.disagree, 1);
  assert.equal(reasons.unknownConsent, 1);
});

test("消息详情：解析出媒体描述与队列状态", () => {
  const db = freshDb();
  store.upsertConversation(db, {
    conversationId: "c1",
    kind: "single",
    name: "x",
    agreeState: "agree",
    agreeAt: NOW,
  });
  const raw = { msgid: "m1", from: "wm", msgtime: NOW, msgtype: "image", image: { sdkfileid: "FID", filesize: 1234 } };
  store.insertMessage(db, {
    id: "c1:m1",
    conversationId: "c1",
    msgId: "m1",
    seq: 1,
    sentAt: NOW,
    sender: "wm",
    origin: "peer",
    msgType: "image",
    text: "",
    rawJson: JSON.stringify(raw),
    ingestedAt: NOW,
    mergeKey: "k1",
  });
  store.upsertMedia(db, {
    id: "c1:m1:FID",
    conversationId: "c1",
    messageId: "c1:m1",
    sdkFileId: "FID",
    mediaType: "image",
    bytes: 1234,
    state: "pending",
  });
  const detail = query.getMessageDetail(db, "c1:m1");
  assert.equal(detail.parsed.media.sdkFileId, "FID");
  assert.equal(detail.media[0].state, "pending");
});

// ── parser ────────────────────────────────────────────────────────────────

test("parser：text 取正文", () => {
  const out = parseMessage({ msgtype: "text", text: { content: "你好" } });
  assert.equal(out.text, "你好");
  assert.equal(out.known, true);
});

test("parser：image 给出 sdkfileid 与大小", () => {
  const out = parseMessage({ msgtype: "image", image: { sdkfileid: "F", filesize: 99 } });
  assert.equal(out.media.sdkFileId, "F");
  assert.equal(out.media.bytes, 99);
});

test("parser：file 的文件名进正文（否则搜不到）", () => {
  const out = parseMessage({ msgtype: "file", file: { sdkfileid: "F", filename: "报价单2026.xlsx" } });
  assert.ok(out.text.includes("报价单2026.xlsx"));
});

test("parser：link 标题进正文", () => {
  const out = parseMessage({ msgtype: "link", link: { title: "合作框架协议", description: "草案" } });
  assert.ok(out.text.includes("合作框架协议"));
});

test("parser：chatrecord 展开子项文本", () => {
  const out = parseMessage({
    msgtype: "chatrecord",
    chatrecord: { item: [{ type: "text", text: { content: "第一句" } }, { type: "text", text: { content: "第二句" } }] },
  });
  assert.ok(out.text.includes("第一句") && out.text.includes("第二句"));
});

test("parser：未知类型不丢，保留 raw 且 known=false", () => {
  const payload = { msgtype: "brand_new_kind", payload: { a: 1 } };
  const out = parseMessage(payload);
  assert.equal(out.known, false);
  assert.equal(out.raw, payload);
});

test("parser：解析器内部异常也降级到 unknown，不抛出", () => {
  const out = parseMessage({ msgtype: "chatrecord", chatrecord: { item: null } });
  assert.equal(typeof out.text, "string");
});

test("类型直方图（巡检用）", () => {
  const hist = typeHistogram([{ msgtype: "text" }, { msgtype: "text" }, { msgtype: "image" }]);
  assert.deepEqual(hist, { text: 2, image: 1 });
});
