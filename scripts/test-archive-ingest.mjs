#!/usr/bin/env node
// ── Ingest cycle tests (add-wecom-archive-ingest 1.3, 1.4, 2.1–2.3, 3.1b, 4.2b, 5.2b)
//
// 这是整条链的"装配验证"：拉取 → 解密 → 同意 → origin → 入库 → 游标。
// 每个用例都对着一个**静默少数据**的具体形态，而不是覆盖率：
//
//   • 拉取失败时游标前进 → 那一段永久丢，且日志显示"成功"
//   • 不同意仍入库 → 残留进索引/备份（规格要求"不存在"，不是"标记删除"）
//   • 解密失败被跳过且不计数 → 少消息但没人知道
//   • 同一会话两侧各到一条 → 重复
//
//   node --test scripts/test-archive-ingest.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const { runPullCycle, normalizeMessage, conversationIdOf } = await import(
  "../server/archive/ingest.js"
);
const { createStubDriver } = await import("../server/archive/sdk.js");
const store = await import("../server/archive/store.js");
const { createConsentCache } = await import("../server/archive/consent.js");

const NOW = 1_700_000_000_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

/** 一条官方形状的原始消息：外层带密文，解密后是 JSON 明文。 */
function rawMessage({ msgid, from, roomid, text, msgtype = "text", sdkfileid }) {
  // 真实归档报文形状：sdkfileid 嵌在 image/voice/file 里，顶层没有这个字段。
  // 早先的夹具把 sdkfileid 放在顶层，于是"媒体入队"在错误报文下也能通过——
  // 这类夹具比没有测试更危险。
  const plain = JSON.stringify({
    msgid,
    from,
    roomid,
    msgtime: NOW - 1000,
    msgtype,
    text: text ? { content: text } : undefined,
    image: msgtype === "image" && sdkfileid ? { sdkfileid, filesize: 6 } : undefined,
  });
  // 外层只有这几个字段：官方 GetChatData 返回的每条消息**不含** from/roomid，
  // 会话身份在密文里。夹具早先把 from/roomid 也放在外层，于是"解密前先算会话标识"
  // 这个错误顺序在测试里永远看不出来——真机上 conversationId 会是 `dm:`，
  // 同意闸门对每条消息都判"无法确定会话"，全量静默丢弃。
  return {
    msgid,
    encrypt_random_key: `rk-${msgid}`,
    encrypt_chat_msg: `ct-${msgid}`,
    __plain: plain,
  };
}

/** 驱动：按 encrypt_chat_msg 找回明文，模拟 SDK 的解密面。 */
function makeDriver(batches, { pullError = null, decryptErrorFor = new Set() } = {}) {
  let index = 0;
  return createStubDriver(async (payload) => {
    if (payload.op === "getChatData") {
      if (pullError) return { ok: false, errCode: 50001, message: pullError };
      const batch = batches[index] ?? { messages: [], seq: batches.at(-1)?.seq ?? 0 };
      index += 1;
      return { ok: true, seq: batch.seq, messages: batch.messages };
    }
    if (payload.op === "decryptData") {
      const msgid = String(payload.encryptChatMsg || "").replace(/^ct-/, "");
      if (decryptErrorFor.has(msgid)) return { ok: false, errCode: 40001, message: "decrypt failed" };
      const found = batches.flatMap((b) => b.messages).find((m) => m.msgid === msgid);
      return { ok: true, plain: found?.__plain ?? "{}" };
    }
    return { ok: false, errCode: 9, message: `unexpected op ${payload.op}` };
  });
}

test("正常批次：入库、游标前进、会话与参与者就位", async () => {
  const db = freshDb();
  const batches = [
    {
      seq: 3,
      messages: [
        rawMessage({ msgid: "m1", from: "wmCUST", roomid: "room1", text: "帮我报个价" }),
        rawMessage({ msgid: "m2", from: "zhangsan", roomid: "room1", text: "好的" }),
      ],
    },
  ];
  const report = await runPullCycle({
    db,
    driver: makeDriver(batches),
    queryConsent: async () => "Agree",
    selfUserIds: ["zhangsan"],
    now: NOW,
  });

  assert.equal(report.admitted, 2);
  assert.equal(report.cursorTo, 3);
  assert.equal(store.coverageReport(db).messages.total, 2);
  assert.equal(store.readCursor(db).seq, 3);

  const originRows = db
    .prepare("SELECT msg_id, origin FROM archive_message ORDER BY msg_id")
    .all();
  assert.equal(originRows[0].origin, "peer", "外部客户是对方");
  assert.equal(originRows[1].origin, "self", "本企业成员是自己");
  assert.equal(report.rejectedOrigin, 1);
});

test("拉取失败：游标不前进，但检查时间前进，并如实记账", async () => {
  const db = freshDb();
  store.writeCursor(db, { id: "default", seq: 42, lastCheckedAt: NOW - 1000, lastMessageAt: NOW - 1000 });
  const report = await runPullCycle({
    db,
    driver: makeDriver([], { pullError: "boom" }),
    queryConsent: async () => "Agree",
    now: NOW,
  });

  assert.equal(report.cursorTo, 42, "失败不得推进游标");
  assert.equal(store.readCursor(db).seq, 42);
  assert.ok(store.readCursor(db).lastCheckedAt >= NOW, "检查时间要前进，否则看不出通道还活着");
  assert.equal(report.errors[0].stage, "pull");
});

test("不同意：不入库，计数可读（不是标记删除）", async () => {
  const db = freshDb();
  const batches = [
    { seq: 1, messages: [rawMessage({ msgid: "m1", from: "wmCUST", roomid: "room1", text: "hi" })] },
  ];
  const report = await runPullCycle({
    db,
    driver: makeDriver(batches),
    queryConsent: async () => "Disagree",
    now: NOW,
  });

  assert.equal(report.admitted, 0);
  assert.equal(report.rejectedConsent, 1);
  assert.equal(store.coverageReport(db).messages.total, 0, "拒绝的消息必须根本不存在");
});

test("同意查询失败（undefined）：按未同意处理，仍不入库", async () => {
  const db = freshDb();
  const report = await runPullCycle({
    db,
    driver: makeDriver([
      { seq: 1, messages: [rawMessage({ msgid: "m1", from: "wm", roomid: "r", text: "x" })] },
    ]),
    queryConsent: async () => undefined,
    now: NOW,
  });
  assert.equal(report.admitted, 0);
  assert.equal(report.rejectedConsent, 1);
});

test("解密失败：计数并保留错误，不静默丢", async () => {
  const db = freshDb();
  const report = await runPullCycle({
    db,
    driver: makeDriver(
      [
        {
          seq: 1,
          messages: [
            rawMessage({ msgid: "ok1", from: "wm", roomid: "r", text: "a" }),
            rawMessage({ msgid: "bad", from: "wm", roomid: "r", text: "b" }),
          ],
        },
      ],
      { decryptErrorFor: new Set(["bad"]) },
    ),
    queryConsent: async () => "Agree",
    now: NOW,
  });
  assert.equal(report.admitted, 1);
  assert.equal(report.errors.filter((e) => e.stage === "decrypt").length, 1);
  assert.equal(report.errors.find((e) => e.stage === "decrypt").message, "decrypt failed");
});

test("归并去重：同一会话同一条消息第二次到时不重复入库", async () => {
  const db = freshDb();
  const one = rawMessage({ msgid: "m1", from: "wm", roomid: "r", text: "同一个问题" });
  const driver = makeDriver([{ seq: 1, messages: [one] }, { seq: 2, messages: [one] }]);
  const report = await runPullCycle({
    db,
    driver,
    queryConsent: async () => "Agree",
    now: NOW,
    maxBatches: 2,
  });
  assert.equal(report.admitted, 1);
  assert.equal(report.duplicates, 1);
  assert.equal(store.coverageReport(db).messages.total, 1);
});

test("媒体进独立队列，正文照常入库", async () => {
  const db = freshDb();
  const report = await runPullCycle({
    db,
    driver: makeDriver([
      {
        seq: 1,
        messages: [
          rawMessage({ msgid: "m1", from: "wm", roomid: "r", text: "", msgtype: "image", sdkfileid: "FID" }),
        ],
      },
    ]),
    queryConsent: async () => "Agree",
    now: NOW,
  });
  assert.equal(report.mediaQueued, 1);
  assert.equal(store.pendingMedia(db).length, 1);
  assert.equal(store.coverageReport(db).messages.total, 1, "媒体未完成不影响正文");
});

test("同意状态缓存：命中时不重复查询（缓存策略在 resolver 里，不在 ingest 里）", async () => {
  const db = freshDb();
  let calls = 0;
  // 刻意**不**把 cache 直接塞给 runPullCycle：缓存命中前必须先比对回调水位，
  // 那是 resolver 的职责。ingest 只负责"问 queryConsent"，否则跨进程失效会被短路。
  const cache = createConsentCache();
  const { createConsentResolver } = await import("../server/archive/consent-api.js");
  const resolver = createConsentResolver({
    db,
    cache,
    seatScope: [],
    client: {
      async agreeOf() {
        calls += 1;
        return { status: "agree", raw: "Agree", statusChangeTime: NOW, op: "check_room_agree" };
      },
    },
  });
  await runPullCycle({
    db,
    driver: makeDriver([
      {
        seq: 1,
        messages: [
          rawMessage({ msgid: "a", from: "wm", roomid: "same", text: "1" }),
          rawMessage({ msgid: "b", from: "wm", roomid: "same", text: "2" }),
        ],
      },
    ]),
    queryConsent: resolver.query,
    now: NOW,
  });
  assert.equal(calls, 1, "同一会话第二次应命中缓存");
  assert.equal(resolver.stats().cached, 1, "第二次是缓存命中，不是重复查询");
  assert.equal(store.getAgreeState(db, "same"), "agree", "明确结论要落库");
});

test("ingest 不得用 consentCache 短路 queryConsent（否则回调失效被绕过）", async () => {
  const db = freshDb();
  const cache = createConsentCache();
  // 缓存里躺着一个过期的"同意"，而 resolver/回调已经把它改成不同意。
  // 如果 ingest 先查缓存，这条消息就会入库——客户撤回了同意，我们还在写。
  cache.set("r", "agree");
  const report = await runPullCycle({
    db,
    driver: makeDriver([
      { seq: 1, messages: [rawMessage({ msgid: "x", from: "wm", roomid: "r", text: "hi" })] },
    ]),
    queryConsent: async () => "Disagree",
    consentCache: cache,
    now: NOW,
  });
  assert.equal(report.pulled, 1);
  assert.equal(report.admitted, 0, "queryConsent 说了不同意，缓存不得把它盖回去");
  assert.equal(store.coverageReport(db).messages.total, 0);
});

test("会话标识：群用 roomid；单聊两侧视角得到同一个键", () => {
  assert.equal(conversationIdOf({ roomid: "room9", from: "a" }), "room9");
  const ab = conversationIdOf({ from: "a", tolist: ["b"] });
  const ba = conversationIdOf({ from: "b", tolist: ["a"] });
  assert.equal(ab, ba, "两侧必须归一到同一会话，否则同一对话会被拆成两个");
});

test("归一化保留原始类型，未识别类型不丢消息", () => {
  const msg = normalizeMessage(
    { msgid: "m", from: "u", msgtime: NOW, msgtype: "some_new_type", text: "x" },
    { conversationId: "c", seq: 1, origin: "peer", ingestedAt: NOW },
  );
  assert.equal(msg.msgType, "some_new_type");
  assert.ok(msg.rawJson.includes("some_new_type"));
  assert.equal(msg.id, "c:m");
});

test("滞后超 5 天时记入丢失账本，且账本没有删除路径", async () => {
  const db = freshDb();
  const sixDaysAgo = NOW - 6 * 86_400_000;
  // 水位三列都停在 6 天前：拉取器这 6 天没成功过。
  store.writeCursor(db, {
    id: "default", seq: 5, lastCheckedAt: sixDaysAgo, lastMessageAt: sixDaysAgo, lastSuccessAt: sixDaysAgo,
  });
  const report = await runPullCycle({
    db,
    driver: makeDriver([{ seq: 5, messages: [] }]),
    queryConsent: async () => "Agree",
    now: NOW,
  });
  // 这一轮本身是成功的（上游回了空批），所以**拉取后**的滞后回到 ok —— 这是新口径的本意：
  // 成功就是成功。防洗白不靠"让滞后一直显示 lost"，靠下面两件事：
  //   ① `lagBeforePull` 记下了这一轮之前已经断了 6 天；
  //   ② 账本只 append，没有删除/更新路径。
  assert.equal(report.lagBeforePull.level, "lost", "拉取前就断了 6 天，必须被记下来");
  assert.equal(report.lag.level, "ok", "这一轮成功拉取后，滞后应回到 ok");
  const losses = store.listLosses(db);
  assert.equal(losses.length, 1);
  assert.ok(losses[0].toTs > losses[0].fromTs);
});

test("整机停摆超窗口后「重启即拉成功」：缺口仍必须进账（不得被成功洗白）", async () => {
  const db = freshDb();
  // 11 天前拉到过消息，此后一次都没跑过；现在重启，第一轮就拉回一条新消息。
  const elevenDaysAgo = NOW - 11 * 86_400_000;
  store.writeCursor(db, {
    id: "default",
    seq: 1,
    lastCheckedAt: elevenDaysAgo,
    lastMessageAt: elevenDaysAgo,
    lastSuccessAt: elevenDaysAgo,
  });
  const report = await runPullCycle({
    db,
    driver: makeDriver([
      { seq: 2, messages: [rawMessage({ msgid: "wake", from: "wm", roomid: "r", text: "回来了" })] },
    ]),
    queryConsent: async () => "Agree",
    now: NOW,
  });

  // 这一轮本身是成功的：滞后按拉取后水位看是 ok
  assert.equal(report.admitted, 1);
  assert.equal(report.lag.level, "ok", "拉取后水位应当是新鲜");
  // 但缺口必须已经记下来，依据是「拉取前」的水位
  assert.equal(report.lagBeforePull.level, "lost", "拉取前的滞后应当被判为 lost");
  const losses = store.listLosses(db);
  assert.equal(losses.length, 1, "整机停摆的缺口必须进账");
  assert.ok(Number(losses[0].fromTs) <= elevenDaysAgo, "区间起点应是最后一条消息的时间");
  assert.ok(Number(losses[0].toTs) >= NOW - 1000, "区间终点应覆盖到恢复时刻");
});
