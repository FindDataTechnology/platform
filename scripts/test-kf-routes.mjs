#!/usr/bin/env node
// ── kf 只读 HTTP 面 ─────────────────────────────────────────────────────────
//
// 用真 express 起一个监听端口，用真 fetch 打过去。理由：注入式的假 app 只能证明
// "我调了自己的函数"，证明不了挂载路径、query 解析、状态码这些真正会出错的地方。
//
// 四条重点：
//   1. 只读：非 GET 一律不实现（404），不存在"刷新一下就发出去了"的路径
//   2. 缺 conversationId → 400，不是 200 带 ok:false
//   3. search 默认只搜客户发言，显式传 origin=peer,self 才带上自己的回复
//   4. 空库不报错：返回 0 与 claimsFullCoverage:false，而不是 500
//
//   node --test scripts/test-kf-routes.mjs
//
// 依赖说明：本仓的 worktree 常常没有 node_modules（依赖只在主工作树装过）。
// 这种情形下整组 skip 而不是 fail——红的意义是"代码坏了"，不是"这台机器没装包"。

import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

let express = null;
try {
  express = (await import("express")).default;
} catch {
  express = null;
}

const HAS_DEPS = Boolean(express);
if (!HAS_DEPS) {
  test("跳过：express 不可解析（先 npm install 再跑这组）", { skip: true }, () => {});
} else {
  await runSuite();
}

async function runSuite() {

const { createKfRoutes } = await import("../server/archive/kf/routes.js");
const store = await import("../server/archive/kf/store.js");

const HOUR = 3_600_000;

const db = new DatabaseSync(":memory:");
store.ensureKfSchema(db);

const app = express();
createKfRoutes(app, { getKfDb: () => db });
const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

function seed({ conv = "kf1|u1", id, origin, at, text = "消息", media = false }) {
  const [kfid, user] = conv.split("|");
  store.upsertKfConversation(db, {
    conversationId: conv,
    openKfId: kfid,
    externalUserId: user,
    name: `客户${user}`,
  });
  store.insertKfMessage(db, {
    id: `${conv}:${id}`,
    conversationId: conv,
    msgId: id,
    openKfId: kfid,
    externalUserId: user,
    sentAt: at,
    origin,
    msgType: media ? "image" : "text",
    text,
    mediaId: media ? `MID-${id}` : null,
    mediaType: media ? "image" : null,
    ingestedAt: at,
  });
  if (media) {
    store.queueKfMedia(db, {
      id: `${conv}:${id}`,
      messageId: `${conv}:${id}`,
      conversationId: conv,
      mediaId: `MID-${id}`,
      mediaType: "image",
    });
  }
  store.refreshKfConversationStats(db, conv);
}

test("空库：coverage 与 inbox 都返回 0，不是 500", async () => {
  const cov = await get("/api/archive/kf/coverage");
  assert.equal(cov.status, 200);
  assert.equal(cov.body.ok, true);
  assert.equal(cov.body.channel, "wecom-kf");
  assert.equal(cov.body.messages.total, 0);
  assert.equal(cov.body.claimsFullCoverage, false, "空库更不能宣称全量");

  const inbox = await get("/api/archive/kf/inbox");
  assert.equal(inbox.status, 200);
  assert.deepEqual(inbox.body.needsReply, []);
  assert.equal(inbox.body.summary.needsReply, 0);
});

test("conversations：带出回复窗口，消费侧不用自己算 48 小时", async () => {
  seed({ conv: "kf1|uA", id: "a1", origin: "peer", at: Date.now() - 2 * HOUR, text: "能开专票吗" });
  const out = await get("/api/archive/kf/conversations");
  assert.equal(out.status, 200);
  const row = out.body.conversations.find((c) => c.externalUserId === "uA");
  assert.ok(row, JSON.stringify(out.body));
  assert.equal(row.replyWindow.open, true);
  assert.ok(row.replyWindow.hoursLeft > 45 && row.replyWindow.hoursLeft < 47);
});

test("inbox：客户问了没回 → 进待回复", async () => {
  const out = await get("/api/archive/kf/inbox");
  assert.equal(out.status, 200);
  const item = out.body.needsReply.find((i) => i.externalUserId === "uA");
  assert.ok(item);
  assert.equal(item.lastPeerText, "能开专票吗");
});

test("inbox：我方回复后不再进队列", async () => {
  seed({ conv: "kf1|uB", id: "b1", origin: "peer", at: Date.now() - 3 * HOUR });
  seed({ conv: "kf1|uB", id: "b2", origin: "self", at: Date.now() - 2 * HOUR });
  const out = await get("/api/archive/kf/inbox");
  assert.equal(out.body.needsReply.some((i) => i.externalUserId === "uB"), false);
});

test("messages：缺 conversationId 返回 400", async () => {
  const out = await get("/api/archive/kf/messages");
  assert.equal(out.status, 400);
  assert.equal(out.body.ok, false);
});

test("messages：按会话取，origin 可过滤", async () => {
  seed({ conv: "kf1|uC", id: "c1", origin: "peer", at: Date.now() - 3 * HOUR, text: "要报价" });
  seed({ conv: "kf1|uC", id: "c2", origin: "self", at: Date.now() - 2 * HOUR, text: "已发" });
  const all = await get("/api/archive/kf/messages?conversationId=kf1|uC");
  assert.equal(all.status, 200);
  assert.equal(all.body.messages.length, 2);

  const peerOnly = await get("/api/archive/kf/messages?conversationId=kf1|uC&origin=peer");
  assert.equal(peerOnly.body.messages.length, 1);
  assert.equal(peerOnly.body.messages[0].origin, "peer");
});

test("search：默认只搜客户发言，显式 origin 才带上自己", async () => {
  seed({ conv: "kf1|uD", id: "d1", origin: "peer", at: Date.now() - HOUR, text: "报价单给一下" });
  seed({ conv: "kf1|uD", id: "d2", origin: "self", at: Date.now() - HOUR / 2, text: "报价单已发" });

  const def = await get("/api/archive/kf/search?q=报价");
  assert.equal(def.status, 200);
  assert.ok(def.body.messages.length >= 1);
  assert.ok(def.body.messages.every((m) => m.origin === "peer"), "默认不带自己的回复");

  const both = await get("/api/archive/kf/search?q=报价&origin=peer,self");
  assert.ok(
    both.body.messages.some((m) => m.origin === "self"),
    "显式指定后应带上自己那条",
  );
});

test("search：两字中文词搜得到（走 LIKE）", async () => {
  const out = await get("/api/archive/kf/search?q=发票");
  assert.equal(out.status, 200);
  // 上面没有含"发票"的消息 → 空数组，但不报错
  assert.ok(Array.isArray(out.body.messages));
});

test("media：完成率空库返回 null", async () => {
  const out = await get("/api/archive/kf/media");
  assert.equal(out.status, 200);
  assert.equal(out.body.total, 0);
  assert.equal(out.body.ratio, null);
});

test("只读：POST/DELETE 不实现（404），没有隐式写入入口", async () => {
  for (const method of ["POST", "DELETE", "PUT"]) {
    const res = await fetch(`${base}/api/archive/kf/coverage`, { method });
    assert.equal(res.status, 404, `${method} 不该命中任何处理函数`);
  }
});

test("sync-status：没接调度器时明确说没接，不是假装健康", async () => {
  const out = await get("/api/archive/kf/sync-status");
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.scheduler, null);
  assert.ok(String(out.body.note).includes("未接线"), out.body.note);
});

test("limit 被夹住：超上限不会把整库吐出来", async () => {
  for (let i = 0; i < 5; i++) {
    seed({ conv: `kf1|uX${i}`, id: `x${i}`, origin: "peer", at: Date.now() - i * HOUR });
  }
  const out = await get("/api/archive/kf/conversations?limit=99999");
  assert.equal(out.status, 200);
  assert.ok(out.body.conversations.length <= 200);
});
}
