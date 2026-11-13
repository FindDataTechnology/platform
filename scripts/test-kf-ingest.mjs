#!/usr/bin/env node
// ── kf 摄取循环：游标纪律、幂等、失败不推进 ─────────────────────────────────
//
// 这批断言针对的是"报表全绿但数据在丢"的三类形态：
//
//   1. 游标空转（has_more=1 但 next_cursor 不变）→ 必须报错终止，而不是转满 maxBatches；
//   2. 写库失败却推进了游标 → 那一段永久丢失（3 天窗口下补不回来）；
//   3. 重放同一批 → 行数不能变（否则每次重启都在造重复）。
//
// 用桩 client（不是 HTTP），因为这一层要测的是循环控制，不是报文形状。
//
//   node --test scripts/test-kf-ingest.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const store = await import("../server/archive/kf/store.js");
const { runKfPullCycle, kfAgentInput, KF_WINDOW_DAYS } = await import(
  "../server/archive/kf/ingest.js"
);

const NOW = 1_700_000_000_000;
const SEC = (ms) => Math.floor(ms / 1000);
const DAY = 86_400_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureKfSchema(db);
  return db;
}

function msg({ id = "m1", kfid = "kf1", user = "u1", origin = 3, type = "text", content = "你好", at = NOW } = {}) {
  const base = { msgid: id, open_kfid: kfid, external_userid: user, send_time: SEC(at), origin, msgtype: type };
  if (type === "text") base.text = { content };
  if (type === "image") base.image = { media_id: `MID-${id}` };
  if (type === "event") base.event = { event_type: "enter_session" };
  return base;
}

/** 按脚本依次返回批次；用完则重复最后一步。 */
function scriptedClient(steps, { customersImpl } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async syncMsg(params) {
      calls.push(params);
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (typeof step === "function") return step(params);
      if (step instanceof Error) throw step;
      return step;
    },
    async resolveOpenKfId() {
      return { openKfId: "kf1", source: "auto", accounts: [{ open_kfid: "kf1" }] };
    },
    async getCustomers(ids) {
      if (customersImpl) return customersImpl(ids);
      return {
        customers: ids.map((id) => ({ external_userid: id, nickname: `客户-${id}` })),
        invalid: [],
      };
    },
  };
}

const empty = { nextCursor: "", hasMore: false, messages: [] };

test("正常一轮：两批、游标推进、消息入库、会话统计刷新", async () => {
  const db = freshDb();
  const client = scriptedClient([
    { nextCursor: "c1", hasMore: true, messages: [msg({ id: "m1", at: NOW - 3000 })] },
    { nextCursor: "c2", hasMore: false, messages: [msg({ id: "m2", at: NOW - 2000 })] },
  ]);
  const report = await runKfPullCycle({ db, client, now: NOW, maxBatches: 5 });

  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  assert.equal(report.batches, 2);
  assert.equal(report.pulled, 2);
  assert.equal(report.inserted, 2);
  assert.equal(report.cursorBefore, "");
  assert.equal(report.cursorAfter, "c2");
  assert.equal(store.kfMessageCount(db), 2);

  const conv = db.prepare("SELECT * FROM kf_conversation").get();
  assert.equal(conv.conversation_id, "kf1|u1");
  assert.equal(Number(conv.msg_count), 2);
  assert.equal(Number(conv.first_msg_at), NOW - 3000);
  assert.equal(Number(conv.last_msg_at), NOW - 2000);
});

test("重放同一批：pulled 有、inserted 为 0（幂等）", async () => {
  const db = freshDb();
  const batch = { nextCursor: "c1", hasMore: false, messages: [msg({ id: "m1" }), msg({ id: "m2" })] };
  await runKfPullCycle({ db, client: scriptedClient([batch]), now: NOW });
  const second = await runKfPullCycle({
    db,
    client: scriptedClient([{ ...batch, nextCursor: "c2" }]),
    now: NOW + 1000,
  });
  assert.equal(store.kfMessageCount(db), 2);
  assert.equal(second.pulled, 2, "服务端照样给了两条");
  assert.equal(second.inserted, 0, "但没有一条是新的");
});

test("游标空转（has_more=1 且 next_cursor 不变）：立即报错，不转满批次", async () => {
  const db = freshDb();
  const client = scriptedClient([
    { nextCursor: "c1", hasMore: true, messages: [msg({ id: "m1" })] },
    { nextCursor: "c1", hasMore: true, messages: [msg({ id: "m2" })] }, // 卡住
  ]);
  const report = await runKfPullCycle({ db, client, now: NOW, maxBatches: 8 });

  assert.equal(client.calls.length, 2, "第二次就停，不能转到第 8 批");
  const err = report.errors.find((e) => e.stage === "cursor");
  assert.ok(err, `缺少 cursor 错误：${JSON.stringify(report.errors)}`);
  assert.ok(err.message.includes("next_cursor"), err.message);
  assert.equal(report.cursorAfter, "c1");
});

test("has_more=1 但没给 next_cursor：同样判为空转", async () => {
  const db = freshDb();
  const client = scriptedClient([{ nextCursor: "", hasMore: true, messages: [msg({ id: "m1" })] }]);
  const report = await runKfPullCycle({ db, client, now: NOW, maxBatches: 5 });
  assert.equal(client.calls.length, 1);
  assert.ok(report.errors.some((e) => e.stage === "cursor" && e.message.includes("未返回 next_cursor")));
});

test("没有新消息不算错误，检查水位照样推进", async () => {
  const db = freshDb();
  const report = await runKfPullCycle({ db, client: scriptedClient([empty]), now: NOW });
  assert.equal(report.errors.length, 0);
  assert.equal(report.pulled, 0);
  const cursor = store.readKfCursor(db);
  assert.equal(cursor.lastCheckedAt, NOW, "断流期也要推进采样水位");
  assert.equal(cursor.lastMessageAt, 0, "数据水位不能因为检查过就前进");
});

test("写库失败时不推进游标（否则那一段永久丢）", async () => {
  const real = freshDb();
  const db = {
    exec: (sql) => real.exec(sql),
    prepare(sql) {
      if (/INSERT OR IGNORE INTO kf_message/i.test(sql)) {
        return { run() { throw new Error("disk full (注入)"); } };
      }
      return real.prepare(sql);
    },
  };
  const client = scriptedClient([
    { nextCursor: "c1", hasMore: true, messages: [msg({ id: "m1" })] },
  ]);
  const report = await runKfPullCycle({ db, client, now: NOW, maxBatches: 5 });

  const err = report.errors.find((e) => e.stage === "store");
  assert.ok(err, JSON.stringify(report.errors));
  assert.equal(err.message.includes("disk full"), true);
  assert.equal(store.readKfCursor(real).cursor, "", "游标必须留在原位，靠幂等重拉");
  assert.equal(report.inserted, 0);
});

test("批次用尽仍未拉完：记截断，不当作错误", async () => {
  const db = freshDb();
  const client = scriptedClient([
    { nextCursor: "c1", hasMore: true, messages: [msg({ id: "m1" })] },
    { nextCursor: "c2", hasMore: true, messages: [msg({ id: "m2" })] },
    { nextCursor: "c3", hasMore: true, messages: [msg({ id: "m3" })] },
  ]);
  const report = await runKfPullCycle({ db, client, now: NOW, maxBatches: 2 });

  assert.equal(report.batches, 2);
  assert.equal(report.truncated, true);
  assert.equal(report.errors.length, 0, "截断不是错误，但要被看见");
  const cursor = store.readKfCursor(db);
  assert.equal(cursor.cursor, "c2");
  assert.equal(cursor.truncations, 1);
});

test("首轮同步记下历史起点 = now - 3 天", async () => {
  const db = freshDb();
  const report = await runKfPullCycle({ db, client: scriptedClient([empty]), now: NOW });
  assert.equal(report.historyFrom, NOW - KF_WINDOW_DAYS * DAY);
  assert.equal(store.readKfCursor(db).historyFrom, NOW - KF_WINDOW_DAYS * DAY);
});

test("历史起点只写一次，不被后续轮次改写", async () => {
  const db = freshDb();
  await runKfPullCycle({ db, client: scriptedClient([empty]), now: NOW });
  const first = store.readKfCursor(db).historyFrom;
  await runKfPullCycle({ db, client: scriptedClient([empty]), now: NOW + 5 * DAY });
  assert.equal(store.readKfCursor(db).historyFrom, first, "不可得边界是事实，不能漂移");
});

test("sync_msg 抛错：原样上报，游标不动", async () => {
  const db = freshDb();
  const boom = new Error("errcode=45009 api freq out of limit");
  boom.name = "KfApiError";
  boom.errcode = 45009;
  const report = await runKfPullCycle({ db, client: scriptedClient([boom]), now: NOW });
  assert.equal(report.errors[0].stage, "sync_msg");
  assert.equal(report.errors[0].errcode, 45009);
  assert.equal(store.readKfCursor(db).cursor, "");
});

test("客户资料补全失败不影响消息入库", async () => {
  const db = freshDb();
  const client = scriptedClient(
    [{ nextCursor: "c1", hasMore: false, messages: [msg({ id: "m1" })] }],
    {
      customersImpl: async () => {
        throw new Error("no permission");
      },
    },
  );
  const report = await runKfPullCycle({ db, client, now: NOW });
  assert.equal(store.kfMessageCount(db), 1, "消息必须在");
  assert.equal(report.customers.failed, 1);
  assert.ok(report.errors.some((e) => e.stage === "customer"));
  const cust = db.prepare("SELECT * FROM kf_customer WHERE external_userid='u1'").get();
  assert.equal(cust.state, "failed");
  assert.ok(String(cust.last_error).includes("no permission"));
});

test("客户资料补全成功：昵称落库、状态 done", async () => {
  const db = freshDb();
  await runKfPullCycle({
    db,
    client: scriptedClient([{ nextCursor: "c1", hasMore: false, messages: [msg({ id: "m1" })] }]),
    now: NOW,
  });
  const cust = db.prepare("SELECT * FROM kf_customer WHERE external_userid='u1'").get();
  assert.equal(cust.nickname, "客户-u1");
  assert.equal(cust.state, "done");
});

test("origin 计数：客户/接待人员/系统三分", async () => {
  const db = freshDb();
  await runKfPullCycle({
    db,
    client: scriptedClient([
      {
        nextCursor: "c1",
        hasMore: false,
        messages: [
          msg({ id: "m1", origin: 3 }),
          msg({ id: "m2", origin: 5 }),
          msg({ id: "m3", origin: 4, type: "event" }),
          msg({ id: "m4", origin: 7 }),
        ],
      },
    ]),
    now: NOW,
  });
  const report = await runKfPullCycle({
    db,
    client: scriptedClient([empty]),
    now: NOW,
  });
  assert.equal(report.peerMessages, 0); // 这一轮没有消息
  const cov = store.kfCoverageReport(db);
  assert.equal(cov.messages.byOrigin.peer, 1);
  assert.equal(cov.messages.byOrigin.self, 1);
  assert.equal(cov.messages.byOrigin.system, 1);
  assert.equal(cov.messages.byOrigin.unknown, 1);
});

test("agent 输入只留客户发言：self/system/unknown 全丢", async () => {
  const db = freshDb();
  await runKfPullCycle({
    db,
    client: scriptedClient([
      {
        nextCursor: "c1",
        hasMore: false,
        messages: [
          msg({ id: "m1", origin: 3, content: "你们能开专票吗" }),
          msg({ id: "m2", origin: 5, content: "可以的" }),
          msg({ id: "m3", origin: 4, type: "event" }),
          msg({ id: "m4", origin: 9, content: "来源不明" }),
        ],
      },
    ]),
    now: NOW,
  });
  const { messages, dropped } = kfAgentInput(db, { conversationId: "kf1|u1" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "你们能开专票吗");
  assert.equal(dropped.length, 3);
});

// 窗口阈值的判据是「距最后一次**成功**同步多久」，不是「最后一条消息多久」。
// 所以这两个用例改成"同步失败、水位停在 N 天前"——这正是需要告警的真实形态：
// 拉取器停了。原来的写法（成功同步一条 5 天前的消息）在新口径下是 ok：
// 我们刚刚成功拉过，平台侧最新消息就是 5 天前那条，没有丢东西。
test("滞后判定用 3 天窗口：距最后一次成功同步 5 天判 lost", async () => {
  const db = freshDb();
  store.writeKfCursor(db, {
    cursor: "c0",
    lastCheckedAt: NOW - 5 * DAY,
    lastMessageAt: NOW - 5 * DAY,
    lastSuccessAt: NOW - 5 * DAY,
  });
  const client = scriptedClient([new Error("network unreachable")]);
  const report = await runKfPullCycle({ db, client, now: NOW });
  assert.equal(report.lag.level, "lost");
  assert.ok(report.lag.reason.includes("3 天"), report.lag.reason);
});

test("距最后一次成功同步 2.5 天：warn 而不是 lost", async () => {
  const db = freshDb();
  store.writeKfCursor(db, {
    cursor: "c0",
    lastCheckedAt: NOW - 2.5 * DAY,
    lastMessageAt: NOW - 2.5 * DAY,
    lastSuccessAt: NOW - 2.5 * DAY,
  });
  const client = scriptedClient([new Error("network unreachable")]);
  const report = await runKfPullCycle({ db, client, now: NOW });
  assert.equal(report.lag.level, "warn");
});

test("客服号安静：成功同步但只有 5 天前的一条旧消息 → 不得判 lost", async () => {
  const db = freshDb();
  const client = scriptedClient([
    { nextCursor: "c1", hasMore: false, messages: [msg({ id: "m1", at: NOW - 5 * DAY })] },
  ]);
  const report = await runKfPullCycle({ db, client, now: NOW });
  assert.notEqual(report.lag.level, "lost", `刚成功同步过，不得判 lost（实际 ${report.lag.level}）`);
});

test("检索走 LIKE：两字中文词也能搜到（FTS trigram 会静默返 0）", async () => {
  const db = freshDb();
  await runKfPullCycle({
    db,
    client: scriptedClient([
      {
        nextCursor: "c1",
        hasMore: false,
        messages: [msg({ id: "m1", content: "需要一份报价单，走合同流程" })],
      },
    ]),
    now: NOW,
  });
  assert.equal(store.searchKfMessages(db, { query: "报价" }).length, 1);
  assert.equal(store.searchKfMessages(db, { query: "合同" }).length, 1);
  assert.equal(store.searchKfMessages(db, { query: "不存在的词" }).length, 0);
});

test("检索可只取客户发言（商机视角默认噪音更少）", async () => {
  const db = freshDb();
  await runKfPullCycle({
    db,
    client: scriptedClient([
      {
        nextCursor: "c1",
        hasMore: false,
        messages: [
          msg({ id: "m1", origin: 3, content: "报价单麻烦发一下" }),
          msg({ id: "m2", origin: 5, content: "报价单已发邮箱" }),
        ],
      },
    ]),
    now: NOW,
  });
  assert.equal(store.searchKfMessages(db, { query: "报价" }).length, 2, "默认两条都命中");
  const peerOnly = store.searchKfMessages(db, { query: "报价", origins: ["peer"] });
  assert.equal(peerOnly.length, 1);
  assert.equal(peerOnly[0].origin, "peer");
});

test("覆盖报告不宣称全量", async () => {
  const db = freshDb();
  await runKfPullCycle({ db, client: scriptedClient([empty]), now: NOW });
  const cov = store.kfCoverageReport(db);
  assert.equal(cov.claimsFullCoverage, false);
  assert.equal(cov.windowDays, 3);
  assert.ok(cov.coverageNote.includes("3 天"));
  assert.equal(cov.cursor.historyFrom, NOW - 3 * DAY);
});
