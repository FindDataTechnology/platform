#!/usr/bin/env node
// ── Consent gate & origin tests (add-wecom-archive-ingest 3.1–3.3, 2.2, 5.2)
//
// 两组判据，都针对"看起来没问题但实际越权/闭环"的形态：
//
//   A. 同意：`Disagree` 必须**不入库**。如果实现成"先入库再标记删除"，残留会出现在
//      备份、全文索引、缩略图缓存、日志里——这比少存一条严重得多。查询失败时按未同意处理
//      （不得推断同意）。
//
//   B. origin：存档里有 bot 自己的回复。不标 origin，消费侧就会把 agent 的回复当成新的
//      用户输入再答一遍；症状是"答非所问/重复"，不会指向根因。
//
//   node --test scripts/test-archive-consent.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  normalizeAgreeStatus,
  admitByConsent,
  createConsentCache,
  classifyOrigin,
  filterForAgentInput,
  mergeKey,
  ORIGIN_SELF,
  ORIGIN_PEER,
} = await import("../server/archive/consent.js");

test("同意状态大小写归一", () => {
  assert.equal(normalizeAgreeStatus("Agree"), "agree");
  assert.equal(normalizeAgreeStatus("AGREE"), "agree");
  assert.equal(normalizeAgreeStatus("Disagree"), "disagree");
  assert.equal(normalizeAgreeStatus(undefined), "unknown");
});

test("同意才入库", () => {
  assert.deepEqual(admitByConsent("Agree"), { admit: true, reason: "agree" });
});

test("拒绝不入库，且原因可读", () => {
  const out = admitByConsent("Disagree");
  assert.equal(out.admit, false);
  assert.equal(out.reason, "disagree");
});

test("查询失败/未返回按未同意处理（不得推断同意）", () => {
  for (const v of [undefined, null, "", "weird"]) {
    const out = admitByConsent(v);
    assert.equal(out.admit, false, `${String(v)} 不应放行`);
    assert.equal(out.reason, "unknown_treated_as_disagree");
  }
});

test("同意状态缓存带 TTL，过期即失效", () => {
  let now = 1000;
  const cache = createConsentCache({ ttlMs: 100, now: () => now });
  cache.set("room1", "Agree");
  assert.equal(cache.get("room1"), "agree");
  now += 50;
  assert.equal(cache.get("room1"), "agree", "TTL 内应命中");
  now += 60;
  assert.equal(cache.get("room1"), null, "过期后必须重新查询");
});

test("回调到达时按会话失效", () => {
  const cache = createConsentCache();
  cache.set("room1", "Disagree");
  cache.set("room2", "Agree");
  cache.invalidate("room1");
  assert.equal(cache.get("room1"), null);
  assert.equal(cache.get("room2"), "agree", "只失效指定会话");
});

test("全清用于凭据轮换", () => {
  const cache = createConsentCache();
  cache.set("a", "Agree");
  cache.set("b", "Agree");
  cache.invalidate();
  assert.equal(cache.size(), 0);
});

test("企业成员发出的判为本方", () => {
  assert.equal(classifyOrigin({ from: "zhangsan", memberUserIds: ["zhangsan"] }), ORIGIN_SELF);
});

test("外部联系人发出的判为对方", () => {
  assert.equal(classifyOrigin({ from: "wmXXXX", memberUserIds: ["zhangsan"] }), ORIGIN_PEER);
});

test("bot 自身标记也能判为本方", () => {
  const origin = classifyOrigin({
    from: "bot-svc",
    memberUserIds: [],
    selfMarkers: { senderType: ["bot"] },
    msgMeta: { senderType: "bot" },
  });
  assert.equal(origin, ORIGIN_SELF);
});

test("来源缺失判 unknown，不猜测", () => {
  assert.equal(classifyOrigin({ from: "", memberUserIds: ["a"] }), "unknown");
});

test("消费侧：本方与 unknown 都不进 agent 输入", () => {
  const { kept, dropped } = filterForAgentInput([
    { id: "1", origin: ORIGIN_PEER },
    { id: "2", origin: ORIGIN_SELF },
    { id: "3", origin: "unknown" },
  ]);
  assert.deepEqual(kept.map((m) => m.id), ["1"]);
  assert.deepEqual(dropped.map((m) => m.id), ["2", "3"]);
});

test("自问自答闭环的最小复现：bot 回复不进输入", () => {
  const archive = [
    { id: "m1", origin: ORIGIN_PEER, text: "帮我报个价" },
    { id: "m2", origin: ORIGIN_SELF, text: "报价 3 万" }, // bot 自己发的
  ];
  const { kept } = filterForAgentInput(archive);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, "帮我报个价", "否则 agent 会把'报价 3 万'当成客户新输入再答一遍");
});

test("归并键对同一会话同一秒同一发送者稳定", () => {
  const a = mergeKey({ conversationId: "c1", tsSeconds: 1794411455, sender: "u1", textDigest: "d" });
  const b = mergeKey({ conversationId: "c1", tsSeconds: 1794411455, sender: "u1", textDigest: "d" });
  assert.equal(a, b);
});

test("归并键区分不同会话", () => {
  const a = mergeKey({ conversationId: "c1", tsSeconds: 1, sender: "u1", textDigest: "d" });
  const b = mergeKey({ conversationId: "c2", tsSeconds: 1, sender: "u1", textDigest: "d" });
  assert.notEqual(a, b);
});
