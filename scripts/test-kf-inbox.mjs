#!/usr/bin/env node
// ── kf 待回复队列 ───────────────────────────────────────────────────────────
//
// 「商机接住」= 客户最后一条消息之后我们回过没有。这个模块的四条断言都在守这句话：
//   1. 我方回复在客户之后 → 已处理（不进队列）
//   2. 系统事件不算回复（否则一条"客户已进入会话"就把会话判成已处理）
//   3. 窗口关闭的不混进待回复，而是单列"已错过"——它是事实，不能藏
//   4. 排序按截止时间而非到达时间（越早到达越早过期）
//
//   node --test scripts/test-kf-inbox.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/kf/store.js");
const { kfInbox } = await import("../server/archive/kf/inbox.js");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureKfSchema(db);
  return db;
}

function add(db, { conv = "kf1|u1", id, origin, at, text = "消息", name = "" }) {
  const [kfid, user] = conv.split("|");
  store.upsertKfConversation(db, {
    conversationId: conv,
    openKfId: kfid,
    externalUserId: user,
    name,
  });
  store.insertKfMessage(db, {
    id: `${conv}:${id}`,
    conversationId: conv,
    msgId: id,
    openKfId: kfid,
    externalUserId: user,
    sentAt: at,
    origin,
    msgType: origin === "system" ? "event" : "text",
    text,
    ingestedAt: at,
  });
  store.refreshKfConversationStats(db, conv);
}

test("客户问了没回：进待回复队列，带等待时长与剩余窗口", () => {
  const db = freshDb();
  add(db, { id: "m1", origin: "peer", at: NOW - 2 * HOUR, text: "能开专票吗" });
  const out = kfInbox(db, { now: NOW });
  assert.equal(out.needsReply.length, 1);
  const item = out.needsReply[0];
  assert.equal(item.lastPeerText, "能开专票吗");
  assert.ok(Math.abs(item.waitingHours - 2) < 0.01);
  assert.ok(Math.abs(item.hoursLeft - 46) < 0.01);
  assert.equal(item.externalUserId, "u1");
});

test("我方已回复：不进队列", () => {
  const db = freshDb();
  add(db, { id: "m1", origin: "peer", at: NOW - 5 * HOUR });
  add(db, { id: "m2", origin: "self", at: NOW - 4 * HOUR });
  const out = kfInbox(db, { now: NOW });
  assert.equal(out.needsReply.length, 0);
  assert.equal(out.missed.length, 0);
});

test("客户追问在我方回复之后：重新进队列", () => {
  const db = freshDb();
  add(db, { id: "m1", origin: "peer", at: NOW - 5 * HOUR });
  add(db, { id: "m2", origin: "self", at: NOW - 4 * HOUR });
  add(db, { id: "m3", origin: "peer", at: NOW - 1 * HOUR, text: "还在吗" });
  const out = kfInbox(db, { now: NOW });
  assert.equal(out.needsReply.length, 1);
  assert.equal(out.needsReply[0].lastPeerText, "还在吗");
});

test("系统事件不算回复：只有进入会话事件的会话不进队列", () => {
  const db = freshDb();
  add(db, { id: "m1", origin: "peer", at: NOW - 3 * HOUR });
  add(db, { id: "m2", origin: "system", at: NOW - 2 * HOUR });
  const out = kfInbox(db, { now: NOW });
  assert.equal(out.needsReply.length, 1, "事件不能把会话判成已处理");
  assert.equal(out.summary.needsReply, 1);
});

test("只有系统事件的会话：不算商机", () => {
  const db = freshDb();
  add(db, { conv: "kf1|u9", id: "e1", origin: "system", at: NOW - HOUR });
  const out = kfInbox(db, { now: NOW });
  assert.equal(out.needsReply.length, 0);
  assert.equal(out.missed.length, 0);
  assert.equal(out.summary.idle, 1);
});

test("窗口已关：进「已错过」，不进待回复", () => {
  const db = freshDb();
  add(db, { id: "m1", origin: "peer", at: NOW - 60 * HOUR });
  const out = kfInbox(db, { now: NOW });
  assert.equal(out.needsReply.length, 0);
  assert.equal(out.missed.length, 1);
  assert.equal(out.missed[0].hoursLeft, 0);
  assert.equal(out.summary.missed, 1);
});

test("按截止时间排序：越早到达越靠前", () => {
  const db = freshDb();
  add(db, { conv: "kf1|late", id: "a", origin: "peer", at: NOW - 1 * HOUR });
  add(db, { conv: "kf1|early", id: "b", origin: "peer", at: NOW - 40 * HOUR });
  add(db, { conv: "kf1|mid", id: "c", origin: "peer", at: NOW - 10 * HOUR });
  const out = kfInbox(db, { now: NOW });
  assert.deepEqual(
    out.needsReply.map((i) => i.externalUserId),
    ["early", "mid", "late"],
  );
  assert.ok(out.needsReply[0].hoursLeft < out.needsReply[1].hoursLeft);
});

test("多个会话混合：计数与分桶正确", () => {
  const db = freshDb();
  add(db, { conv: "kf1|a", id: "a1", origin: "peer", at: NOW - HOUR }); // 待回
  add(db, { conv: "kf1|b", id: "b1", origin: "peer", at: NOW - 2 * HOUR });
  add(db, { conv: "kf1|b", id: "b2", origin: "self", at: NOW - HOUR }); // 已回
  add(db, { conv: "kf1|c", id: "c1", origin: "peer", at: NOW - 80 * HOUR }); // 错过
  add(db, { conv: "kf1|d", id: "d1", origin: "system", at: NOW - HOUR }); // 空会话
  const out = kfInbox(db, { now: NOW });
  assert.equal(out.summary.needsReply, 1);
  assert.equal(out.summary.missed, 1);
  assert.equal(out.summary.idle, 2, "已回复的会话与纯事件会话都算 idle");
  assert.equal(out.summary.windowHours, 48);
});

test("limit 只截断返回，不改变计数", () => {
  const db = freshDb();
  for (let i = 0; i < 5; i++) {
    add(db, { conv: `kf1|u${i}`, id: `m${i}`, origin: "peer", at: NOW - (i + 1) * HOUR });
  }
  const out = kfInbox(db, { now: NOW, limit: 2 });
  assert.equal(out.needsReply.length, 2);
  assert.equal(out.summary.needsReply, 5, "截断的是列表，不是真相");
});
