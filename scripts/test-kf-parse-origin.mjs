#!/usr/bin/env node
// ── kf 归一化与来源映射 ─────────────────────────────────────────────────────
//
// 这一层是纯函数，所以断言可以写得很细。重点不在"能解析"，而在三条边界：
//   1. 未知 msgtype 不留空正文（空正文在检索面上表现为"召回偏低"，不指向根因）；
//   2. 未知 origin 不猜测（猜错会让 agent 对着系统事件作答）；
//   3. 时间从秒到毫秒只转换一次（转两次就是 5 万年后的消息）。
//
//   node --test scripts/test-kf-parse-origin.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  mapOrigin,
  kfConversationId,
  kfConversationName,
  KF_PEER,
  KF_SELF,
  KF_SYSTEM,
  KF_UNKNOWN,
} = await import("../server/archive/kf/origin.js");
const { parseKfMessage, mediaIdOf, mediaTypeOf, toKfRow } = await import(
  "../server/archive/kf/parse.js"
);

const NOW = 1_700_000_000_000;
const SEND_SECONDS = Math.floor(NOW / 1000);

test("origin 3/4/5 映射为 客户/系统/接待人员", () => {
  assert.equal(mapOrigin(3), KF_PEER);
  assert.equal(mapOrigin(4), KF_SYSTEM);
  assert.equal(mapOrigin(5), KF_SELF);
});

test("origin 支持字符串数字（真实响应是数字，夹具常写字符串）", () => {
  assert.equal(mapOrigin("3"), KF_PEER);
  assert.equal(mapOrigin("5"), KF_SELF);
});

test("origin 未识别取值一律 unknown，不猜", () => {
  assert.equal(mapOrigin(0), KF_UNKNOWN);
  assert.equal(mapOrigin(9), KF_UNKNOWN);
  assert.equal(mapOrigin(undefined), KF_UNKNOWN);
  assert.equal(mapOrigin("customer"), KF_UNKNOWN);
});

test("会话身份是「客服账号 × 客户」二元组", () => {
  assert.equal(kfConversationId({ openKfId: "kf1", externalUserId: "u1" }), "kf1|u1");
  assert.notEqual(
    kfConversationId({ openKfId: "kf1", externalUserId: "u1" }),
    kfConversationId({ openKfId: "kf2", externalUserId: "u1" }),
    "同一客户找两个客服号是两段会话",
  );
});

test("会话展示名：无昵称时用 id 前缀，不用「未知客户」", () => {
  assert.equal(kfConversationName({ nickname: "王工", externalUserId: "wmABC" }), "王工");
  assert.equal(kfConversationName({ externalUserId: "wmABCDEFGH" }), "客户 wmABCDEF");
  assert.ok(!kfConversationName({ externalUserId: "wmABCDEFGH" }).includes("未知"));
});

test("text 取正文", () => {
  const out = parseKfMessage({ msgtype: "text", text: { content: "你好，想咨询报价" } });
  assert.equal(out.msgType, "text");
  assert.equal(out.text, "你好，想咨询报价");
  assert.equal(out.mediaId, null);
  assert.equal(out.known, true);
});

test("图片/语音/视频带 media_id，且正文非空", () => {
  for (const [type, expectText] of [
    ["image", "[图片]"],
    ["voice", "[语音]"],
    ["video", "[视频]"],
  ]) {
    const out = parseKfMessage({ msgtype: type, [type]: { media_id: `MID-${type}` } });
    assert.equal(out.text, expectText);
    assert.equal(out.mediaId, `MID-${type}`);
    assert.equal(out.mediaType, type);
  }
});

test("文件没有 name 字段时不假装有（kf 与存档结构不同）", () => {
  const out = parseKfMessage({ msgtype: "file", file: { media_id: "FID" } });
  assert.equal(out.text, "[文件]");
  assert.equal(out.mediaId, "FID");
});

test("链接标题进正文（否则站内搜不到那条链接）", () => {
  const out = parseKfMessage({
    msgtype: "link",
    link: { title: "2026 报价单", desc: "含税价", url: "https://x.example/q" },
  });
  assert.ok(out.text.includes("2026 报价单"));
  assert.ok(out.text.includes("https://x.example/q"));
});

test("位置与小程序也产生可读正文", () => {
  const loc = parseKfMessage({
    msgtype: "location",
    location: { name: "望京SOHO", address: "北京市朝阳区", latitude: 39.99, longitude: 116.47 },
  });
  assert.ok(loc.text.includes("望京SOHO"));
  assert.ok(loc.text.includes("39.99"));

  const mini = parseKfMessage({
    msgtype: "miniprogram",
    miniprogram: { title: "产品手册", appid: "wx123", page: "pages/index" },
  });
  assert.ok(mini.text.includes("产品手册"));
});

test("系统事件记下 event_type，正文非空", () => {
  const out = parseKfMessage({ msgtype: "event", event: { event_type: "enter_session" } });
  assert.equal(out.eventType, "enter_session");
  assert.ok(out.text.includes("enter_session"));
});

test("未知 msgtype 保留类型名，正文不空", () => {
  const out = parseKfMessage({ msgtype: "channels_shop_order", channels_shop_order: {} });
  assert.ok(out.text.length > 0);
  const weird = parseKfMessage({ msgtype: "brand_new_type" });
  assert.equal(weird.text, "[brand_new_type]");
  assert.equal(weird.known, false);
});

test("mediaIdOf 能从各类型里取到 id，非媒体返回 null", () => {
  assert.equal(mediaIdOf({ image: { media_id: "A" } }), "A");
  assert.equal(mediaIdOf({ file: { media_id: "B" } }), "B");
  assert.equal(mediaIdOf({ text: { content: "x" } }), null);
  assert.equal(mediaTypeOf("image"), "image");
  assert.equal(mediaTypeOf("text"), null);
});

test("toKfRow：id 带会话前缀，秒级时间只转一次毫秒", () => {
  const row = toKfRow(
    {
      msgid: "m1",
      open_kfid: "kf1",
      external_userid: "u1",
      send_time: SEND_SECONDS,
      msgtype: "text",
      text: { content: "在吗" },
      origin: 3,
    },
    { openKfId: "kf1", externalUserId: "u1", origin: KF_PEER, now: NOW },
  );
  assert.equal(row.id, "kf1|u1:m1");
  assert.equal(row.conversationId, "kf1|u1");
  assert.equal(row.sentAt, SEND_SECONDS * 1000);
  assert.ok(Math.abs(row.sentAt - NOW) < 1000, "秒→毫秒只转一次，不能变成未来时间");
  assert.equal(row.origin, KF_PEER);
  assert.equal(row.text, "在吗");
});

test("toKfRow：缺少 send_time 时回落 now，不留 0", () => {
  const row = toKfRow(
    { msgid: "m2", msgtype: "text", text: { content: "x" } },
    { openKfId: "kf1", externalUserId: "u1", origin: KF_PEER, now: NOW },
  );
  assert.equal(row.sentAt, NOW);
});
