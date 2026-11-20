#!/usr/bin/env node
// ── 存档巡检面：差量边界 + 缺数不算恢复（任务 4.2b）─────────────────────────
//
// 这条通道的告警只有两个地方容易做错，组测试就守这两处：
//
// 1. **差量边界**：只在告警码「新出现」时投递。每轮都把「滞后 3 天」重发一遍，
//    第一天就没人看了。
// 2. **缺数不算恢复**：观测不完整时不承认任何告警消失。否则"拉取器挂了"会被
//    记成"恢复了"——可靠性告警里最常见的假恢复。
//
// 另有一条口径：**零数据不判覆盖**（没有会话时"席位多于生效"不是事故）。
//
//   node --test scripts/test-archive-patrol.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const store = await import("../server/archive/store.js");
const {
  buildPatrolVerdict,
  runPatrol,
  transition,
  readPatrolState,
  writePatrolState,
  DEFAULT_STALE_MS,
} = await import("../server/archive/patrol.js");

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  store.ensureArchiveSchema(db);
  return db;
}

/** 让游标看着"刚刚检查过"，即观测新鲜。 */
function markFresh(db, { agoMs = MIN, lastMessageAgoMs = MIN } = {}) {
  store.writeCursor(db, {
    id: "default",
    seq: 100,
    lastCheckedAt: NOW - agoMs,
    lastMessageAt: NOW - lastMessageAgoMs,
    lastSuccessAt: NOW - lastMessageAgoMs,
  });
}

test("空库：从未拉取过 → warn/never_checked，且不声称数据新鲜", () => {
  const db = freshDb();
  const v = buildPatrolVerdict({ db, now: NOW });
  assert.equal(v.level, "warn");
  assert.deepEqual(v.active, ["never_checked"]);
  assert.equal(v.fresh, false);
  assert.equal(v.degraded, true, "观测不完整就是 degraded，不能当正常");
});

test("刚检查过且无滞后 → ok，fresh=true", () => {
  const db = freshDb();
  markFresh(db);
  const v = buildPatrolVerdict({ db, now: NOW });
  assert.equal(v.level, "ok");
  assert.deepEqual(v.active, []);
  assert.equal(v.fresh, true);
});

test("差量：同一个问题连续两轮只投递一次", async () => {
  const db = freshDb();
  const sent = [];
  const deliver = (p) => sent.push(p);

  const first = await runPatrol({ db, now: NOW, deliver });
  assert.deepEqual(first.opened, ["never_checked"]);
  assert.equal(sent.length, 1, "首轮应投递");

  const second = await runPatrol({ db, now: NOW + MIN, prev: first.state, deliver });
  assert.deepEqual(second.opened, [], "同一个码不该再报一次");
  assert.equal(sent.length, 1, "第二轮不得重复投递");
});

test("新问题出现时投递，payload 里是新出现的码", async () => {
  const db = freshDb();
  markFresh(db);
  const sent = [];
  const first = await runPatrol({ db, now: NOW, deliver: (p) => sent.push(p) });
  assert.equal(first.verdict.level, "ok");
  assert.equal(sent.length, 0, "健康时不投递");

  // 模拟"拉取器停了 30 小时"：游标只能向前（writeCursor 用 MAX），所以不能把
  // 时间往回写——要让 now 往前走。这也正是真实情形：时间流逝、游标不动。
  const later = NOW + 30 * 60 * MIN;
  const second = await runPatrol({
    db,
    now: later,
    prev: first.state,
    deliver: (p) => sent.push(p),
  });
  assert.ok(second.opened.length > 0, `应新开告警：${JSON.stringify(second.opened)}`);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].opened, second.opened);
  assert.ok(Array.isArray(sent[0].openedText) && sent[0].openedText.length > 0, "要给人读的话");
});

// ⚠ 这条是整组的重点：观测不完整时不许宣布恢复。
test("缺数不算恢复：degraded 时上一轮的告警继续成立", async () => {
  const db = freshDb();
  markFresh(db);
  const prev = { active: ["puller_stalled"], at: NOW - MIN };
  const out = await runPatrol({ db, now: NOW, prev, degraded: true });

  assert.deepEqual(out.verdict.active, [], "本轮读数本身是健康的");
  assert.deepEqual(out.closed, [], "但不许宣布它恢复了");
  assert.deepEqual(out.carried, ["puller_stalled"], "旧告警要 carry 过来");
  assert.deepEqual(out.state.active, ["puller_stalled"], "状态里仍然是活的");
});

test("观测新鲜时才承认恢复，且恢复不触发投递", async () => {
  const db = freshDb();
  markFresh(db);
  const prev = { active: ["puller_stalled"], at: NOW - MIN };
  const sent = [];
  const out = await runPatrol({ db, now: NOW, prev, deliver: (p) => sent.push(p) });

  assert.deepEqual(out.closed, ["puller_stalled"]);
  assert.deepEqual(out.state.active, []);
  assert.equal(sent.length, 0, "恢复不是告警，不该投递");
});

test("游标过期（超过 staleMs）＝观测不新鲜，同样不许宣布恢复", async () => {
  const db = freshDb();
  // 游标很老，但 lag 会因为 stalled 而报警——用它验证 fresh 的判定本身
  store.writeCursor(db, {
    id: "default",
    seq: 1,
    lastCheckedAt: NOW - DEFAULT_STALE_MS - MIN,
    lastMessageAt: NOW - MIN,
    lastSuccessAt: NOW - MIN,
  });
  const v = buildPatrolVerdict({ db, now: NOW });
  assert.equal(v.fresh, false);
  assert.equal(v.degraded, true);
});

test("零数据不判覆盖：没有会话时席位差不算告警", () => {
  const db = freshDb();
  markFresh(db);
  const v = buildPatrolVerdict({
    db,
    now: NOW,
    config: { purchasedSeats: 10, effectiveSeats: 5 },
  });
  assert.ok(!v.active.includes("seat_gap"), `零会话不该报覆盖：${JSON.stringify(v.active)}`);
});

test("有会话时才判覆盖：席位差成立为告警", () => {
  const db = freshDb();
  markFresh(db);
  store.upsertConversation(db, {
    conversationId: "c1",
    kind: "room",
    name: "群1",
    agreeState: "agree",
    updatedAt: NOW,
  });
  store.refreshConversationStats(db, "c1");
  const v = buildPatrolVerdict({
    db,
    now: NOW,
    config: { purchasedSeats: 10, effectiveSeats: 5 },
  });
  assert.ok(v.active.includes("seat_gap"), JSON.stringify(v.active));
  assert.equal(v.level, "warn");
});

test("transition 只做集合差，不掺业务判断", () => {
  assert.deepEqual(transition(["a", "b"], ["b", "c"]), { opened: ["c"], closed: ["a"] });
  assert.deepEqual(transition([], []), { opened: [], closed: [] });
});

test("状态文件：坏文件不被当成「之前一切正常」", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "patrol-state-"));
  try {
    const file = path.join(dir, "state.json");
    writeFileSync(file, "{ not json");
    const st = readPatrolState(file);
    assert.deepEqual(st.active, []);
    assert.equal(st.corrupt, true, "要能被识别出来，否则所有告警会重新开火一次");

    writePatrolState(file, { active: ["puller_stalled"], at: NOW });
    const back = readPatrolState(file);
    assert.deepEqual(back.active, ["puller_stalled"]);
    assert.equal(back.at, NOW);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
