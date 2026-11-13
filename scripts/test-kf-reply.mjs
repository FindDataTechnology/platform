#!/usr/bin/env node
// ── kf 回复：48 小时窗口、防重复、对外动作显式化 ─────────────────────────────
//
// 三个断言最贵：
//   1. 窗口只认**客户**最后一条消息。取最后一条消息（含我方）会让窗口永不关闭——
//      自己回一句就续命，是典型的自证式假绿。
//   2. 发送成功后用服务端 msgid 先落库，下一轮拉取同一条被幂等吃掉，不出现两条。
//   3. 空正文 / 超长正文在本地就拒，不发请求——给真实客户的消息不能靠"发出去看报错"验。
//
//   node --test scripts/test-kf-reply.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/kf/store.js");
const { replyWindow, sendReply, lastCustomerMessageAt, REPLY_WINDOW_HOURS } = await import(
  "../server/archive/kf/reply.js"
);
const { runKfPullCycle } = await import("../server/archive/kf/ingest.js");
const { createKfClient, MAX_TEXT_BYTES } = await import("../server/archive/kf/api.js");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureKfSchema(db);
  return db;
}

function seed(db, { origin, at, id, text = "消息" }) {
  store.upsertKfConversation(db, {
    conversationId: "kf1|u1",
    openKfId: "kf1",
    externalUserId: "u1",
  });
  store.insertKfMessage(db, {
    id: `kf1|u1:${id}`,
    conversationId: "kf1|u1",
    msgId: id,
    openKfId: "kf1",
    externalUserId: "u1",
    sentAt: at,
    origin,
    msgType: "text",
    text,
    ingestedAt: at,
  });
  store.refreshKfConversationStats(db, "kf1|u1");
}

const client = (sent = []) => ({
  async sendText(args) {
    sent.push(args);
    return { msgId: `OUT-${sent.length}` };
  },
});

test("窗口：客户从未发言时不可回复", () => {
  const w = replyWindow({ lastCustomerAt: 0, now: NOW });
  assert.equal(w.open, false);
  assert.ok(w.reason.includes("从未发言"));
});

test("窗口：47 小时前仍可回，剩约 1 小时", () => {
  const w = replyWindow({ lastCustomerAt: NOW - 47 * HOUR, now: NOW });
  assert.equal(w.open, true);
  assert.ok(w.hoursLeft > 0.9 && w.hoursLeft < 1.1, String(w.hoursLeft));
});

test("窗口：49 小时前关闭，理由里带小时数", () => {
  const w = replyWindow({ lastCustomerAt: NOW - 49 * HOUR, now: NOW });
  assert.equal(w.open, false);
  assert.ok(w.reason.includes("49.0"), w.reason);
  assert.equal(REPLY_WINDOW_HOURS, 48);
});

test("窗口只认客户消息：我方回复不能续命", () => {
  const db = freshDb();
  seed(db, { origin: "peer", at: NOW - 60 * HOUR, id: "m1" });
  seed(db, { origin: "self", at: NOW - 1 * HOUR, id: "m2" }); // 我刚回过
  const last = lastCustomerMessageAt(db, "kf1|u1");
  assert.equal(last, NOW - 60 * HOUR, "只能取 peer 的最后一条");
  assert.equal(replyWindow({ lastCustomerAt: last, now: NOW }).open, false, "窗口已关，不能自证有效");
});

test("窗口内发送成功：落库为 self，带服务端 msgid", async () => {
  const db = freshDb();
  seed(db, { origin: "peer", at: NOW - 2 * HOUR, id: "m1" });
  const sent = [];
  const res = await sendReply({
    db,
    client: client(sent),
    conversationId: "kf1|u1",
    content: "可以开专票，稍后发报价单",
    now: NOW,
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].externalUserId, "u1");
  assert.equal(sent[0].openKfId, "kf1");

  const row = db.prepare("SELECT * FROM kf_message WHERE id='kf1|u1:OUT-1'").get();
  assert.ok(row, "本地必须留下这一条");
  assert.equal(row.origin, "self");
  assert.equal(row.text, "可以开专票，稍后发报价单");
  assert.equal(store.kfMessageCount(db), 2);
});

test("窗口外拒绝发送：一次请求都不发", async () => {
  const db = freshDb();
  seed(db, { origin: "peer", at: NOW - 50 * HOUR, id: "m1" });
  const sent = [];
  const res = await sendReply({
    db,
    client: client(sent),
    conversationId: "kf1|u1",
    content: "晚了",
    now: NOW,
  });
  assert.equal(res.ok, false);
  assert.equal(sent.length, 0, "窗口外不该产生任何对外请求");
  assert.ok(res.reason.includes("48"));
  assert.equal(store.kfMessageCount(db), 1, "也不该留下本地行");
});

test("发送后拉取同一条：幂等吃掉，不出现两行", async () => {
  const db = freshDb();
  seed(db, { origin: "peer", at: NOW - 2 * HOUR, id: "m1" });
  const res = await sendReply({
    db,
    client: client(),
    conversationId: "kf1|u1",
    content: "已收到",
    now: NOW,
  });
  assert.equal(res.ok, true);
  const serverMsgId = res.msgId;

  const pull = {
    async resolveOpenKfId() {
      return { openKfId: "kf1", source: "auto", accounts: [{ open_kfid: "kf1" }] };
    },
    async syncMsg() {
      return {
        nextCursor: "c1",
        hasMore: false,
        messages: [
          {
            msgid: serverMsgId, // 服务端把同一条还给我们
            open_kfid: "kf1",
            external_userid: "u1",
            send_time: Math.floor(NOW / 1000),
            origin: 5,
            servicer_userid: "zhangsan",
            msgtype: "text",
            text: { content: "已收到" },
          },
        ],
      };
    },
    async getCustomers() {
      return { customers: [], invalid: [] };
    },
  };
  const report = await runKfPullCycle({ db, client: pull, now: NOW + 1000 });
  assert.equal(report.pulled, 1);
  assert.equal(report.inserted, 0, "同 msgid 不得重复入库");
  assert.equal(store.kfMessageCount(db), 2, "客户一条 + 我方一条");
});

test("空正文在本地拒绝，不发请求", async () => {
  const db = freshDb();
  seed(db, { origin: "peer", at: NOW - HOUR, id: "m1" });
  const f = async () => {
    throw new Error("不该发请求");
  };
  const c = createKfClient({
    fetchImpl: f,
    corpId: "ww-corp",
    secret: "S".repeat(40),
    now: () => NOW,
    timeoutMs: 0,
  });
  const res = await sendReply({ db, client: c, conversationId: "kf1|u1", content: "   ", now: NOW });
  assert.equal(res.ok, false);
  assert.ok(res.reason.includes("正文为空"), res.reason);
});

test("超长正文（>2048 字节）在本地拒绝", async () => {
  const db = freshDb();
  seed(db, { origin: "peer", at: NOW - HOUR, id: "m1" });
  const c = createKfClient({
    fetchImpl: async () => {
      throw new Error("不该发请求");
    },
    corpId: "ww-corp",
    secret: "S".repeat(40),
    now: () => NOW,
    timeoutMs: 0,
  });
  const long = "汉".repeat(Math.ceil(MAX_TEXT_BYTES / 3) + 10); // 每字 3 字节
  const res = await sendReply({ db, client: c, conversationId: "kf1|u1", content: long, now: NOW });
  assert.equal(res.ok, false);
  assert.ok(res.reason.includes("超过上限"), res.reason);
});

test("缺少目标会话时拒绝，不发请求", async () => {
  const db = freshDb();
  const c = createKfClient({
    fetchImpl: async () => {
      throw new Error("不该发请求");
    },
    corpId: "ww-corp",
    secret: "S".repeat(40),
    now: () => NOW,
    timeoutMs: 0,
  });
  const res = await sendReply({ db, client: c, openKfId: "kf1", externalUserId: "", content: "x", now: NOW });
  assert.equal(res.ok, false);
});

test("接口报错时不落库，原样带上 errcode", async () => {
  const db = freshDb();
  seed(db, { origin: "peer", at: NOW - HOUR, id: "m1" });
  const bad = {
    async sendText() {
      const err = new Error("send_msg 失败：errcode=95001");
      err.errcode = 95001;
      throw err;
    },
  };
  const res = await sendReply({ db, client: bad, conversationId: "kf1|u1", content: "hi", now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.errcode, 95001);
  assert.equal(store.kfMessageCount(db), 1, "发送失败不能留下「已发送」的本地行");
});
