// ── cadence-draft unit tests (complete-team-authoring-loop 2.1) ─────────────
//
// 两个建岗面（活舰队对话框 / 工作区岗位抽屉）共用同一套节奏换算。这条测试
// 钉的是「换算本身」，不是任一面：四种模式 + 往返一致 + 不重写用户自定义 cron。
//
//   node --test scripts/test-cadence-draft.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { resolveCadence, cadenceToDraft, emptyCadenceDraft } = await import("../web/src/lib/cadence-draft.ts");

test("被动 → null（不是 enabled:false）", () => {
  assert.equal(resolveCadence(emptyCadenceDraft()), null);
});

test("每小时 → 0 * * * *", () => {
  const d = { ...emptyCadenceDraft(), mode: "hourly", promptTemplate: "巡检" };
  assert.deepEqual(resolveCadence(d), { cron: "0 * * * *", tz: null, promptTemplate: "巡检", enabled: true });
});

test("每天 09:00 → 0 9 * * *", () => {
  const d = { ...emptyCadenceDraft(), mode: "daily", time: "09:00", promptTemplate: "晨报" };
  assert.equal(resolveCadence(d)?.cron, "0 9 * * *");
});

test("每天 16:10 → 10 16 * * *", () => {
  const d = { ...emptyCadenceDraft(), mode: "daily", time: "16:10", promptTemplate: "收盘" };
  assert.equal(resolveCadence(d)?.cron, "10 16 * * *");
});

// 0 点与 0 分是真值，不是「没填」。
// 旧实现是 `Number(m) || 0, Number(h) || 9`，而 0 是 falsy —— 「每天 00:05」
// 被静默编译成 `5 9 * * *`（09:05），且反函数读回来就是 09:05，用户原来填的
// 那个时间永久消失、无从发现。上面几条用例全用非零时/分，正好落在这个缝里。
test("每天 00:05 → 5 0 * * *（0 点是真值，不回落）", () => {
  const d = { ...emptyCadenceDraft(), mode: "daily", time: "00:05", promptTemplate: "夜巡" };
  assert.equal(resolveCadence(d)?.cron, "5 0 * * *");
});

test("每天 00:00 → 0 0 * * *", () => {
  const d = { ...emptyCadenceDraft(), mode: "daily", time: "00:00", promptTemplate: "零点" };
  assert.equal(resolveCadence(d)?.cron, "0 0 * * *");
});

test("每天 00:30 / 23:00 → 分与小时都按真值编译", () => {
  const a = { ...emptyCadenceDraft(), mode: "daily", time: "00:30", promptTemplate: "x" };
  assert.equal(resolveCadence(a)?.cron, "30 0 * * *");
  const b = { ...emptyCadenceDraft(), mode: "daily", time: "23:00", promptTemplate: "x" };
  assert.equal(resolveCadence(b)?.cron, "0 23 * * *");
});

test("午夜往返不漂移（编译再读回，仍是 00:05）", () => {
  const d = { ...emptyCadenceDraft(), mode: "daily", time: "00:05", promptTemplate: "夜巡" };
  const back = cadenceToDraft(resolveCadence(d));
  assert.equal(back.time, "00:05");
  assert.equal(resolveCadence(back)?.cron, "5 0 * * *");
});

test("每天 坏时间回落 09:00，不产非法 cron", () => {
  const d = { ...emptyCadenceDraft(), mode: "daily", time: "not-a-time", promptTemplate: "x" };
  assert.equal(resolveCadence(d)?.cron, "0 9 * * *");
});

test("自定义保留原 cron", () => {
  const d = { ...emptyCadenceDraft(), mode: "custom", cron: "*/15 9-17 * * 1-5", promptTemplate: "盘中" };
  assert.equal(resolveCadence(d)?.cron, "*/15 9-17 * * 1-5");
});

test("空自定义 → null", () => {
  const d = { ...emptyCadenceDraft(), mode: "custom", cron: "   " };
  assert.equal(resolveCadence(d), null);
});

test("tz 空白 → null（交给服务端默认）", () => {
  const d = { ...emptyCadenceDraft(), mode: "hourly", tz: "  ", promptTemplate: "x" };
  assert.equal(resolveCadence(d)?.tz, null);
});

test("tz 有值原样保留", () => {
  const d = { ...emptyCadenceDraft(), mode: "hourly", tz: "Asia/Shanghai", promptTemplate: "x" };
  assert.equal(resolveCadence(d)?.tz, "Asia/Shanghai");
});

// ── 往返：现存 cadence → 草稿 → 再解析，cron 不变 ─────────────────────────

test("往返：每小时", () => {
  const live = { cron: "0 * * * *", tz: "Asia/Shanghai", promptTemplate: "p" };
  assert.equal(resolveCadence(cadenceToDraft(live))?.cron, live.cron);
});

test("往返：每天识别为 daily 而非 custom", () => {
  const live = { cron: "10 16 * * *", tz: null, promptTemplate: "p" };
  const draft = cadenceToDraft(live);
  assert.equal(draft.mode, "daily");
  assert.equal(draft.time, "16:10");
  assert.equal(resolveCadence(draft)?.cron, live.cron);
});

test("往返：自定义 cron 不退回 daily", () => {
  const live = { cron: "*/15 9-17 * * 1-5", tz: null, promptTemplate: "p" };
  const draft = cadenceToDraft(live);
  assert.equal(draft.mode, "custom");
  assert.equal(resolveCadence(draft)?.cron, live.cron);
});

test("往返：被动", () => {
  assert.equal(cadenceToDraft(null).mode, "none");
  assert.equal(cadenceToDraft(undefined).mode, "none");
  assert.equal(cadenceToDraft({ cron: "" }).mode, "none");
});

test("往返：形如每天的其它 cron 不被误认（多一列）", () => {
  const live = { cron: "0 9 1 * *", tz: null, promptTemplate: "p" }; // 每月 1 号
  const draft = cadenceToDraft(live);
  assert.equal(draft.mode, "custom", "只认尾部恰为 * * *");
  assert.equal(resolveCadence(draft)?.cron, live.cron);
});

test("往返：cron 带多余空格仍识别为每小时", () => {
  assert.equal(cadenceToDraft({ cron: "  0 * * * *  " }).mode, "hourly");
});
