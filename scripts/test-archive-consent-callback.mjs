#!/usr/bin/env node
// ── 撤回同意回调的平台入口（fix-archive-consent-callback-ingress）────────────
//
// 修的是一个**已经发生过的合规缺口**，所以断言必须打在"坏的那个本身"上：
//
//   旧行为：企微把 `MsgType=event, Event=msg_audit_approved` 推到
//           /api/bots/webhook/:botId/:secret，验签通过后 `parseMessage` 判非 text
//           回 null，路由打一行 `non-text payload ignored` 就回 200。
//           于是撤回同意的通知到了门口被当成噪音，拉取侧继续按旧结论写最多 5 分钟
//           （consent 缓存 TTL）。
//
// 所以本文件的主断言只有一条，且它在旧代码下**必红**：
//
//   真签名 + 真 AES 加密的撤回事件打到 webhook → 库里的 agree_state 变成 disagree，
//   并且 `archive_consent_event` 水位被写下（跨进程把拉取侧逼去重查）。
//
// 其余四条守的是"修完之后别的路没被弄坏"：文本消息不被误判成事件、事件不建回合、
// 未配置存档库时零痕迹、存档侧故障不外溢成 5xx（企微会重试，只会把窗口拉长）。
//
//   node --test scripts/test-archive-consent-callback.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { test, before, after } from "node:test";
import express from "express";
import { DatabaseSync } from "node:sqlite";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "archive-consent-callback-"));
const ARCHIVE_DB = path.join(tmpRoot, "archive.db");
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.ARCHIVE_DB = ARCHIVE_DB;
delete process.env.BOTS_ALLOW_TOOLS;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
await import("../server/bots/wecom.js");
const { encrypt, signature, registry: wecomAdapter } = await import("../server/bots/wecom.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");
const archiveStore = await import("../server/archive/store.js");
const { handleInboundEvent } = await import("../server/archive/consent-ingress.js");

const CRED = {
  corpId: "corpx",
  corpSecret: "corp-secret-not-used-here",
  agentId: "1000002",
  token: "T0KEN",
  encodingAesKey: crypto.randomBytes(32).toString("base64").replace(/=+$/, "").slice(0, 43),
};

let server, base, bot, secret, ctx;

/** 真实明文报文。外层信封由 `seal()` 负责——夹具里绝不能出现"明文套密文"。 */
const approvalXml = ({ chatId = "wrEVT", status = "0", event = "msg_audit_approved", from = "zhangsan" } = {}) =>
  `<xml><ToUserName><![CDATA[${CRED.corpId}]]></ToUserName>` +
  `<FromUserName><![CDATA[${from}]]></FromUserName>` +
  `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>` +
  `<MsgType><![CDATA[event]]></MsgType>` +
  `<Event><![CDATA[${event}]]></Event>` +
  `<ChatId><![CDATA[${chatId}]]></ChatId>` +
  `<Status>${status}</Status></xml>`;

const textXml = (content = "你好") =>
  `<xml><ToUserName><![CDATA[${CRED.corpId}]]></ToUserName>` +
  `<FromUserName><![CDATA[zhangsan]]></FromUserName>` +
  `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>` +
  `<MsgType><![CDATA[text]]></MsgType>` +
  `<Content><![CDATA[${content}]]></Content>` +
  `<MsgId>1234567890123456</MsgId></xml>`;

/** 把明文包成官方信封（`<Encrypt>` 里是密文），返回可直接当 req.raw 的字串。 */
const sealRaw = (plainXml) =>
  `<xml><Encrypt><![CDATA[${encrypt(CRED.encodingAesKey, plainXml, CRED.corpId)}]]></Encrypt></xml>`;

/** 按官方算法把明文包成 `{Encrypt}` 密文并算出 msg_signature。 */
function seal(plainXml) {
  const enc = encrypt(CRED.encodingAesKey, plainXml, CRED.corpId);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(6).toString("hex");
  return {
    body: `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`,
    query: `msg_signature=${signature(CRED.token, ts, nonce, enc)}&timestamp=${ts}&nonce=${nonce}`,
  };
}

async function post(rawXml) {
  const { body, query } = seal(rawXml);
  return fetch(`${base}${WEBHOOK_PREFIX}${bot.id}/${secret}?${query}`, {
    method: "POST",
    headers: { "content-type": "text/xml" },
    body,
  });
}

function archiveDb() {
  return new DatabaseSync(ARCHIVE_DB);
}

function agreeStateOf(chatId) {
  const d = archiveDb();
  try {
    return archiveStore.getAgreeState(d, chatId);
  } finally {
    d.close();
  }
}

before(async () => {
  await db.initDb();

  // 起点：该会话此前是"同意"。撤回事件若没被消费，它就会一直停在这里——
  // 这就是主断言能区分新旧行为的原因。
  const seed = archiveDb();
  archiveStore.ensureArchiveSchema(seed);
  archiveStore.upsertConversation(seed, {
    conversationId: "wrEVT",
    kind: "room",
    name: "撤回验证群",
    agreeState: "agree",
    agreeAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  seed.close();

  const app = express();
  const jsonBodyParser = express.json();
  app.use((req, res, next) => (req.path.startsWith(WEBHOOK_PREFIX) ? next() : jsonBodyParser(req, res, next)));
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  registerAuth(ctx);
  registerBotRoutes(ctx);

  // 事件路径不建回合，但万一有代码走歪了，这条桩保证它不会真去调 qyapi。
  ctx.dshBridge = { isReady: () => false, prompt: async () => "mid" };

  const created = await db.addBot({
    id: "wecom-archive-app",
    type: "wecom",
    name: "寻数·存档应用",
    credentials: CRED,
    secret: "wb-secret",
  });
  bot = created;
  secret = created.secret;
  bots.initBots(ctx);

  await new Promise((r) => {
    server = app.listen(0, "127.0.0.1", r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => (server ? server.close(r) : r()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── 主断言：修复前必红 ──────────────────────────────────────────────────────

test("撤回同意事件经真验签入口落库（旧代码在此必红：事件被判非文本丢弃）", async () => {
  assert.equal(agreeStateOf("wrEVT"), "agree", "前置：起点必须是同意，否则本测试证明不了任何事");

  const res = await post(approvalXml({ chatId: "wrEVT", status: "0" }));
  assert.equal(res.status, 200);
  assert.equal((await res.text()).trim(), "success", "企微只认 success 字面量");

  assert.equal(agreeStateOf("wrEVT"), "disagree", "撤回后库里必须立刻是不同意——等 5 分钟缓存过期就是合规缺口");

  const d = archiveDb();
  try {
    assert.ok(
      archiveStore.lastConsentEventAt(d, "wrEVT") > 0,
      "跨进程水位必须被写下：拉取在另一个进程里，只有水位能把它逼去重查",
    );
  } finally {
    d.close();
  }
});

test("事件不建回合、不进消息去重键", async () => {
  const before = db.listBots().length;
  const res = await post(approvalXml({ chatId: "wrEVT", status: "0" }));
  assert.equal(res.status, 200);
  assert.equal(db.listBots().length, before, "回调不得改动 bot 台账");
});

// ── 别的路没被弄坏 ──────────────────────────────────────────────────────────

test("文本消息不被误判成事件：parseEvent 回 null、parseMessage 照常", async () => {
  const req = { method: "POST", query: {}, headers: { "content-type": "text/xml" }, raw: sealRaw(textXml("报价单")) };
  const evt = await wecomAdapter.parseEvent(req, CRED);
  assert.equal(evt, null, "文本不是事件");

  const msg = await wecomAdapter.parseMessage(req, CRED);
  assert.ok(msg, "文本仍走原消息路径");
  assert.equal(msg.text, "报价单");
});

test("事件不被当成消息：parseMessage 对 event 回 null（这正是旧行为的现场）", async () => {
  const req = { method: "POST", query: {}, headers: { "content-type": "text/xml" }, raw: sealRaw(approvalXml()) };
  assert.equal(await wecomAdapter.parseMessage(req, CRED), null);
  const evt = await wecomAdapter.parseEvent(req, CRED);
  assert.equal(evt?.event, "msg_audit_approved", "适配器只负责认出来，语义留给上层");
  assert.ok(evt.xml.includes("<Status>0</Status>"), "交出去的是明文，上层不必再解密");
});

test("共用回调 URL 上的其它事件：200 且零副作用", async () => {
  // 自带前置：不依赖上一条测试把状态翻成 disagree——否则这条的红绿是别人的信号。
  const before = agreeStateOf("wrEVT");
  const res = await post(approvalXml({ chatId: "wrEVT", event: "enter_agent" }));
  assert.equal(res.status, 200);
  assert.equal(agreeStateOf("wrEVT"), before, "其它事件不得改变同意状态");
  const out = handleInboundEvent({
    event: { event: "enter_agent", xml: "<xml><Event>enter_agent</Event></xml>" },
    env: { ARCHIVE_DB },
  });
  assert.equal(out.handled, false);
  assert.equal(out.reason, "not_approval_event");
});

// ── 跨进程：新建的 resolver 必须放弃旧缓存 ──────────────────────────────────

test("水位写过之后，新建 resolver 不再信任事件之前的缓存", async () => {
  const { createConsentCache } = await import("../server/archive/consent.js");
  const { createConsentResolver } = await import("../server/archive/consent-api.js");

  // 自带前置，不借上一条测试的水位。
  const seeded = handleInboundEvent({
    event: { event: "msg_audit_approved", xml: approvalXml({ chatId: "wrRES", status: "1" }) },
    env: { ARCHIVE_DB },
  });
  assert.equal(seeded.persisted, true, "前置：水位与结论都要被写下");

  let clock = 1000;
  const cache = createConsentCache({ ttlMs: 5 * 60 * 1000, now: () => clock });
  let calls = 0;
  const client = {
    async agreeOf() {
      calls += 1;
      return { status: "agree", raw: "Agree", statusChangeTime: 900, op: "check_room_agree" };
    },
  };

  const first = createConsentResolver({ db: archiveDb(), cache, seatScope: [], client });
  assert.equal(await first.query("wrRES"), "agree");
  assert.equal(calls, 1);

  // 同一个缓存里已经有结论（at=1000）；水位是刚才那次回调写的真实时间，远晚于它。
  // 若 resolver 只认缓存，calls 会停在 1，撤回就白撤了。
  clock = 2000;
  const second = createConsentResolver({ db: archiveDb(), cache, seatScope: [], client });
  await second.query("wrRES");
  assert.equal(calls, 2, "水位晚于缓存写入 ⇒ 必须重查，不得沿用旧结论");
  assert.equal(first.stats().cached, 0, "第一次是查询不是命中");
});

// ── 未配置 / 故障：都不许外溢 ───────────────────────────────────────────────

test("未配置 ARCHIVE_DB：no-op 且不建库文件", async () => {
  const out = handleInboundEvent({
    event: { event: "msg_audit_approved", xml: approvalXml({ chatId: "wrEVT" }) },
    env: {},
  });
  assert.equal(out.handled, false);
  assert.equal(out.reason, "archive_db_unset");

  const dir = mkdtempSync(path.join(tmpdir(), "archive-consent-off-"));
  try {
    const res = await (async () => {
      const saved = process.env.ARCHIVE_DB;
      delete process.env.ARCHIVE_DB;
      try {
        return await post(approvalXml({ chatId: "wrEVT", status: "0" }));
      } finally {
        process.env.ARCHIVE_DB = saved;
      }
    })();
    assert.equal(res.status, 200, "没开存档也不能让企微收到非 200");
    assert.equal(existsSync(path.join(dir, "archive.db")), false, "不该在任何地方冒出库文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("存档库不可写：入口仍回 200，不得变成 5xx（企微会重试，只会拉长故障）", async () => {
  // 把 ARCHIVE_DB 指到一个目录上：DatabaseSync 必然打不开。
  const saved = process.env.ARCHIVE_DB;
  process.env.ARCHIVE_DB = tmpRoot;
  try {
    const res = await post(approvalXml({ chatId: "wrEVT", status: "0" }));
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), "success");
  } finally {
    process.env.ARCHIVE_DB = saved;
  }
});

// ── 机器人绑定（wecom-bot）：同一个回调 URL 的另一种绑定 ──────────────────────
//
// 这一组守的是一个**同类的静默丢弃**：`wecom-bot` 的 parseMessage 也把非文本回 null
// （源码注释里就写着 non-text (image/voice/file/event)），若存档应用或机器人共用一条
// 回调 URL、而机器人适配器不交事件，撤回同意又会回到"等 5 分钟缓存过期"。

/** 机器人适配器在 parseMessage/parseEvent 内部**自己再验一次签**（自建应用那条靠路由验），
 *  夹具必须带真的 timestamp/nonce/msg_signature，否则测的是"缺字段"而不是"认事件"。 */
function signedQuery(ciphertext) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(6).toString("hex");
  return { timestamp: ts, nonce, msg_signature: signature(CRED.token, ts, nonce, ciphertext) };
}

test("wecom-bot 也认事件：XML 世代交出明文，JSON 世代只交事件名", async () => {
  const wecomBot = (await import("../server/bots/wecom-bot.js")).registry;

  const xmlEnc = encrypt(CRED.encodingAesKey, approvalXml(), CRED.corpId);
  const xmlReq = {
    method: "POST",
    query: signedQuery(xmlEnc),
    headers: { "content-type": "text/xml" },
    raw: `<xml><Encrypt><![CDATA[${xmlEnc}]]></Encrypt></xml>`,
  };
  const xmlEvt = await wecomBot.parseEvent(xmlReq, CRED);
  assert.equal(xmlEvt?.event, "msg_audit_approved");
  assert.ok(xmlEvt.xml.includes("<Status>0</Status>"), "XML 世代要交出明文，恢复路可以精确落库");

  // JSON 世代的字段形状未经实证：只认"这是个事件"，不猜内部字段。
  const jsonPlain = JSON.stringify({ msgtype: "event", event: { event_type: "msg_audit_approved" }, from: { userId: "zhangsan" } });
  const jsonEnc = encrypt(CRED.encodingAesKey, jsonPlain, CRED.corpId);
  const jsonReq = {
    method: "POST",
    query: signedQuery(jsonEnc),
    headers: { "content-type": "application/json" },
    raw: "",
    json: { encrypt: jsonEnc },
  };
  const jsonEvt = await wecomBot.parseEvent(jsonReq, CRED);
  assert.equal(jsonEvt?.event, "msg_audit_approved");
  assert.equal(jsonEvt.xml, "", "认不出字段就不交明文，避免上层按猜的形状落库");
  assert.equal(jsonEvt.from, "zhangsan");

  // 文本消息在两种绑定下都不是事件
  const textEnc = encrypt(CRED.encodingAesKey, textXml("你好"), CRED.corpId);
  const textReq = {
    method: "POST",
    query: signedQuery(textEnc),
    headers: { "content-type": "text/xml" },
    raw: `<xml><Encrypt><![CDATA[${textEnc}]]></Encrypt></xml>`,
  };
  assert.equal(await wecomBot.parseEvent(textReq, CRED), null);
});

test("非 XML 事件：不猜字段，只落全局水位（下一轮全量重查），并让 resolver 放弃缓存", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "archive-opaque-"));
  const dbFile = path.join(dir, "archive.db");
  const seed = new DatabaseSync(dbFile);
  archiveStore.ensureArchiveSchema(seed);
  seed.close();

  const out = handleInboundEvent({
    event: { event: "msg_audit_approved", xml: "" },
    env: { ARCHIVE_DB: dbFile },
    now: () => 4_000_000_000_000,
  });
  assert.equal(out.handled, false);
  assert.equal(out.reason, "opaque_event_global_invalidate");
  assert.equal(out.invalidated, "all");

  const d = new DatabaseSync(dbFile);
  try {
    assert.equal(archiveStore.lastConsentEventAt(d, "任意会话"), 4_000_000_000_000, "全局水位要对任何会话都生效");
  } finally {
    d.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
