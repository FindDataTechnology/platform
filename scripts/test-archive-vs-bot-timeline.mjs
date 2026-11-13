#!/usr/bin/env node
// ── 与 bot 车道并行：同一会话的时间线不重、不漏（任务 8.3）────────────────
//
// 两条车道看同一个群，但关注点完全不同：
//   • bot 车道只处理"该它答的"：群里没 @ 它、或只 @ 了一下没写字，它**不处理**。
//   • 存档车道要的是合规留痕：**bot 不理的那些也必须留下**。
//
// 于是这里要证的三件事，正好对着三种真实故障：
//
//   1. **不丢**：bot 判定"不关我事"的消息，存档里必须在。
//      （实现方式是把真适配器的丢弃规则跑一遍，再比对存档时间线。）
//   2. **不重复**：bot 自己发出去的那条回复，从存档拉回来时只能有一行，
//      而且是 `self`——同一批重拉也不许凭空多一行。
//   3. **不回喂**：`filterForAgentInput` 必须把 self 丢掉。否则 agent 会把自己
//      十分钟前的回复当成新的用户输入再答一遍（自问自答闭环），症状是"答非所问"，
//      而且完全不会指向根因。
//
// 这里刻意**不**连真 bot 服务、不发网络：适配器那一层用它的真实现（验签+解密+
// 解析整条走通），存档那一层用真的 `runPullCycle`。两边都是生产代码。
//
//   node --test scripts/test-archive-vs-bot-timeline.mjs

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const { encrypt, signature } = await import("../server/bots/wecom.js");
const { registry: wecomBot } = await import("../server/bots/wecom-bot.js");
const { runPullCycle } = await import("../server/archive/ingest.js");
const { createStubDriver } = await import("../server/archive/sdk.js");
const { filterForAgentInput } = await import("../server/archive/consent.js");
const store = await import("../server/archive/store.js");
const { getMessages } = await import("../server/archive/query.js");

const NOW = 1_700_000_000_000;
const ROOM = "wrGROUP01";
const MEMBER = "zhangsan"; // 本方员工（席位）
const CUSTOMER = "wmCUSTOMER";

const CRED = {
  corpId: "corpx",
  botId: "aibj4Kf4DjoTRASe20slbigehBK6DiSMeMl",
  token: "T0KEN",
  encodingAesKey: crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43),
};

/** 造一条签名+加密的群回调，喂给真适配器。 */
async function callAdapter(content) {
  const plain = JSON.stringify({
    chattype: "group",
    chatid: ROOM,
    from: { userId: CUSTOMER },
    text: { content },
  });
  const enc = encrypt(CRED.encodingAesKey, plain, CRED.corpId);
  const ts = String(Math.floor(NOW / 1000));
  const nonce = crypto.randomBytes(6).toString("hex");
  const sig = signature(CRED.token, ts, nonce, enc);
  return wecomBot.parseMessage(
    { method: "POST", raw: "", query: { msg_signature: sig, timestamp: ts, nonce }, json: { encrypt: enc } },
    CRED,
  );
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

/** 驱动：把每条 (msgid → 明文) 记住，模拟官方 SDK 的拉取与解密。 */
function makeDriver(messages) {
  const plainByCt = new Map();
  for (const m of messages) plainByCt.set(m.encrypt_chat_msg, m.__plain);
  // 游标语义要真实：第二批请求必须回空，否则 runPullCycle 会拿着同一批再跑一遍
  // （真实 SDK 不会这样），重复计数被抬高，看起来像产品 bug，其实是夹具的错。
  let served = false;
  return createStubDriver(async (payload) => {
    if (payload.op === "getChatData") {
      const lastSeq = messages.at(-1)?.seq ?? 0;
      if (served) return { ok: true, seq: lastSeq, messages: [] };
      served = true;
      return {
        ok: true,
        seq: lastSeq,
        messages: messages.map(({ __plain, ...rest }) => rest),
      };
    }
    if (payload.op === "decryptData") {
      const plain = plainByCt.get(payload.encryptChatMsg);
      if (!plain) return { ok: false, errCode: 10006, message: "no plain" };
      return { ok: true, plain };
    }
    return { ok: false, errCode: 9, message: `unexpected ${payload.op}` };
  });
}

/** 一条官方形状的存档消息：外层只有 msgid/seq/两个密文字段，身份在明文里。 */
function archiveMessage({ id, seq, from, text, msgtime }) {
  return {
    msgid: id,
    seq,
    publickey_ver: 3,
    encrypt_random_key: "rk",
    encrypt_chat_msg: `ct-${id}`,
    __plain: JSON.stringify({
      msgid: id,
      seq,
      from,
      roomid: ROOM,
      msgtime,
      msgtype: "text",
      text: { content: text },
    }),
  };
}

test("bot 判「不关我事」的消息，存档里必须在（不丢）", async () => {
  // 先问真适配器：这条它到底管不管。
  const handled = await callAdapter("@智语");
  assert.equal(handled, null, "只 @ 不写字的消息，bot 不该起回合");

  // 存档照收——这正是两车道并行的价值：bot 不理不等于不该留痕。
  const db = freshDb();
  const report = await runPullCycle({
    db,
    driver: makeDriver([archiveMessage({ id: "g1", seq: 1, from: CUSTOMER, text: "@智语", msgtime: NOW }) ]),
    queryConsent: async () => "Agree",
    selfUserIds: [MEMBER],
    now: NOW,
  });

  assert.equal(report.admitted, 1, "bot 丢掉的那条，存档必须留下");
  const timeline = getMessages(db, { conversationId: ROOM });
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].text, "@智语");
  assert.equal(timeline[0].origin, "peer");
});

test("bot 自己的回复：存档里只有一行、标 self，重拉也不多一行（不重复）", async () => {
  const db = freshDb();
  const batch = [
    archiveMessage({ id: "g2", seq: 10, from: CUSTOMER, text: "帮我报个价", msgtime: NOW - 2000 }),
    // bot 的回复：发送者是企业成员 userid
    archiveMessage({ id: "g3", seq: 11, from: MEMBER, text: "已收到，稍后给你报价", msgtime: NOW - 1000 }),
  ];

  const first = await runPullCycle({
    db,
    driver: makeDriver(batch),
    queryConsent: async () => "Agree",
    selfUserIds: [MEMBER],
    now: NOW,
  });
  assert.equal(first.admitted, 2);
  assert.equal(first.rejectedOrigin, 1, "本方那条要计入 rejectedOrigin");

  const timeline = getMessages(db, { conversationId: ROOM });
  assert.equal(timeline.length, 2, "两条各一行");
  const selfRows = timeline.filter((m) => m.origin === "self");
  assert.equal(selfRows.length, 1, "本方回复只应有一行");
  assert.equal(selfRows[0].text, "已收到，稍后给你报价");

  // 同一批再拉一遍：靠归并键去重，行数不得增加
  const second = await runPullCycle({
    db,
    driver: makeDriver(batch),
    queryConsent: async () => "Agree",
    selfUserIds: [MEMBER],
    now: NOW + 60_000,
  });
  assert.equal(second.admitted, 0, "重拉不得新增行");
  assert.equal(second.duplicates, 2, "两条都应判为归并重复");
  assert.equal(getMessages(db, { conversationId: ROOM }).length, 2, "时间线仍是两行");
});

test("agent 输入只含对方消息：bot 自己的回复不得回喂（不回喂）", async () => {
  const db = freshDb();
  await runPullCycle({
    db,
    driver: makeDriver([
      archiveMessage({ id: "g4", seq: 20, from: CUSTOMER, text: "在吗", msgtime: NOW - 3000 }),
      archiveMessage({ id: "g5", seq: 21, from: MEMBER, text: "在的", msgtime: NOW - 2000 }),
      archiveMessage({ id: "g6", seq: 22, from: CUSTOMER, text: "明天能上门吗", msgtime: NOW - 1000 }),
    ]),
    queryConsent: async () => "Agree",
    selfUserIds: [MEMBER],
    now: NOW,
  });

  const timeline = getMessages(db, { conversationId: ROOM });
  assert.equal(timeline.length, 3);

  const { kept, dropped } = filterForAgentInput(timeline);
  assert.deepEqual(
    kept.map((m) => m.text),
    ["在吗", "明天能上门吗"],
    "agent 只该看到对方说的话",
  );
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].origin, "self");
  assert.equal(dropped[0].reason, "not_peer");
});

test("同一会话跨两批到达也不重不漏：总数 = 去重后的真实条数", async () => {
  const db = freshDb();
  const a = archiveMessage({ id: "g7", seq: 30, from: CUSTOMER, text: "第一句", msgtime: NOW - 5000 });
  const b = archiveMessage({ id: "g8", seq: 31, from: MEMBER, text: "应答", msgtime: NOW - 4000 });
  const c = archiveMessage({ id: "g9", seq: 32, from: CUSTOMER, text: "第二句", msgtime: NOW - 3000 });

  // 第一批：a、b（b 也出现在第二批里，模拟两条车道/两次拉取重叠）
  await runPullCycle({
    db,
    driver: makeDriver([a, b]),
    queryConsent: async () => "Agree",
    selfUserIds: [MEMBER],
    now: NOW - 2000,
  });
  // 第二批：b（重叠）、c（新）
  const r2 = await runPullCycle({
    db,
    driver: makeDriver([b, c]),
    queryConsent: async () => "Agree",
    selfUserIds: [MEMBER],
    now: NOW,
  });

  assert.equal(r2.admitted, 1, "第二批只该新增 c");
  assert.equal(r2.duplicates, 1, "重叠的 b 应判重复");

  const timeline = getMessages(db, { conversationId: ROOM });
  assert.deepEqual(
    timeline.map((m) => m.text),
    ["第一句", "应答", "第二句"],
    "时间线按时间正序，且不重不漏",
  );
});

test("两条车道对同一条消息给出不同 msgid：只留一行（归并键，不是主键）", async () => {
  const db = freshDb();
  // 真实情形：bot 回调那条带的是平台 msgid，存档拉回来那条带的是存档 msgid，
  // 两者**不可能相同**——主键去重在这里完全不起作用，只有归并键能拦住。
  const fromBotLane = archiveMessage({ id: "bot-9001", seq: 40, from: CUSTOMER, text: "明天见", msgtime: NOW - 1000 });
  const fromArchiveLane = archiveMessage({ id: "arc-7701", seq: 41, from: CUSTOMER, text: "明天见", msgtime: NOW - 1000 });

  const report = await runPullCycle({
    db,
    driver: makeDriver([fromBotLane, fromArchiveLane]),
    queryConsent: async () => "Agree",
    selfUserIds: [MEMBER],
    now: NOW,
  });

  assert.equal(report.admitted, 1, "同一条消息只该入库一次");
  assert.equal(report.duplicates, 1, "第二条必须被归并键判重");
  const timeline = getMessages(db, { conversationId: ROOM });
  assert.equal(timeline.length, 1, "不同 msgid 的同一条消息不得变成两行");
  assert.equal(timeline[0].text, "明天见");
});
