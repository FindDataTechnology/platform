// Integration tests — room lifecycle & bridge watermark
// (fix-zhiyu-room-lifecycle-and-bridge-watermark).
// Run: node --test scripts/test-zhiyu-room-lifecycle.mjs
//
//   A. bridge watermark: one event flows in at most once — across repeated
//      ticks, an unchanged sample, and a process restart (a fresh bridge over
//      the same store). This is the shape production broke: 1018 copies of
//      four reports in one room.
//   B. ended-room gate: no rows while ended, the watermark KEEPS ADVANCING,
//      and reactivation does not backfill the dark period.
//   C. paging: tail window, backward window adjacency, private-row visibility
//      unchanged by paging.
//   D. retention: only ended rooms' system/event rows age out; dialogue rows
//      and active rooms are untouched; the sweep is idempotent.
//   E. route parameters: after/before/tail are mutually exclusive (400),
//      limit is validated and clamped, tail returns the newest window.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

import { createZhiyuStore } from "../gateway/zhiyu/store.js";
import { registerFleetRoomBridge } from "../gateway/fleet-room-bridge.js";
import { createRoomRouter } from "../gateway/zhiyu/room-router.js";
import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

const tmpRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `zhiyu-${tag}-`));
const overview = (fleets) => ({ v: 1, sampledAt: Date.now(), fleets });
const fleetShape = (id, over = {}) => ({
  id,
  name: `fleet ${id}`,
  counts: { onDuty: 1, paused: 0, missing: 0, vacant: 0, passive: 0, failing: 0, total: 1 },
  openDecisions: { count: 0, top: [] },
  stream: [],
  ...over,
});

function bridgeFor(store, sampleRef, over = {}) {
  return registerFleetRoomBridge(express(), {
    store,
    resolveUser: () => ({ email: "o@x", groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets: async () => sampleRef.current,
    ...over,
  });
}

const bridgeRows = (store, roomId, kind) =>
  store.messagesAfter(roomId, 0, { limit: 5000 }).filter((m) => m.meta?.bridge === kind);

test("bridge: one report flows in at most once — repeated ticks and a restart do not replay", async () => {
  const store = createZhiyuStore({ file: path.join(tmpRoot("wm"), "z.db") });
  const room = store.roomCreate({ title: "水位线房", ownerEmail: "o@x" });
  store.fleetSubAdd({ roomId: room.id, fleetId: "f1", fleetName: "客服班组", ownerEmail: "o@x" });

  const sample = { current: overview([fleetShape("f1", { stream: [{ title: "一线客服", at: 1000, summarySnip: "报数一" }] })]) };
  const b = bridgeFor(store, sample);
  await b.tick(); // first sight baselines silently
  await b.tick();
  await b.tick();
  assert.equal(bridgeRows(store, room.id, "report").length, 0, "baseline never dumps history");

  sample.current = overview([fleetShape("f1", { stream: [{ title: "一线客服", at: 2000, summarySnip: "报数二" }] })]);
  await b.tick();
  assert.equal(bridgeRows(store, room.id, "report").length, 1);

  // The production shape: the sampler keeps returning the SAME `at` forever.
  for (let i = 0; i < 5; i += 1) await b.tick();
  assert.equal(bridgeRows(store, room.id, "report").length, 1, "an unchanged report is never re-appended");

  // Restart = new bridge instance over the same store (in-memory state gone).
  const b2 = bridgeFor(store, sample);
  await b2.tick();
  assert.equal(bridgeRows(store, room.id, "report").length, 1, "restart does not replay what already landed");
});

test("bridge: ended room stops flowing but the watermark keeps advancing (no backfill)", async () => {
  const store = createZhiyuStore({ file: path.join(tmpRoot("gate"), "z.db") });
  const room = store.roomCreate({ title: "结束房", ownerEmail: "o@x" });
  store.fleetSubAdd({ roomId: room.id, fleetId: "f1", fleetName: "客服班组", ownerEmail: "o@x" });

  const sample = { current: overview([fleetShape("f1", { stream: [{ title: "岗", at: 1000, summarySnip: "第一条" }] })]) };
  const b = bridgeFor(store, sample);
  await b.tick(); // baseline while active

  store.roomSetStatus(room.id, "ended");
  sample.current = overview([fleetShape("f1", { stream: [{ title: "岗", at: 2000, summarySnip: "断流期" }] })]);
  await b.tick();
  await b.tick();
  assert.equal(bridgeRows(store, room.id, "report").length, 0, "an ended room receives nothing");

  store.roomSetStatus(room.id, "active");
  await b.tick();
  assert.equal(bridgeRows(store, room.id, "report").length, 0, "the dark period is not replayed");

  sample.current = overview([fleetShape("f1", { stream: [{ title: "岗", at: 3000, summarySnip: "恢复后第一条" }] })]);
  await b.tick();
  const rows = bridgeRows(store, room.id, "report");
  assert.equal(rows.length, 1, "post-recovery events resume");
  assert.match(rows[0].content, /恢复后第一条/);
});

test("bridge: overlapping ticks do not double-write (single-flight)", async () => {
  const store = createZhiyuStore({ file: path.join(tmpRoot("flight"), "z.db") });
  const room = store.roomCreate({ title: "叠跑房", ownerEmail: "o@x" });
  store.fleetSubAdd({ roomId: room.id, fleetId: "f1", fleetName: "客服班组", ownerEmail: "o@x" });

  let gate = null;
  let release = () => {};
  const sample = { current: overview([fleetShape("f1", { stream: [{ title: "岗", at: 1000, summarySnip: "基线" }] })]) };
  const b = registerFleetRoomBridge(express(), {
    store,
    resolveUser: () => ({ email: "o@x", groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets: async () => {
      if (gate) await gate; // only the overlapping round is slow
      return sample.current;
    },
  });
  await b.tick(); // baseline

  sample.current = overview([fleetShape("f1", { stream: [{ title: "岗", at: 2000, summarySnip: "新报数" }] })]);
  gate = new Promise((r) => {
    release = r;
  });
  const t1 = b.tick(); // starts sampling (parked on the gate)
  const t2 = b.tick(); // must return immediately — the first round is in flight
  await t2;
  release();
  await t1;
  gate = null;

  assert.equal(bridgeRows(store, room.id, "report").length, 1, "the skipped round adds nothing");
  await b.tick();
  assert.equal(bridgeRows(store, room.id, "report").length, 1, "and the next round does not replay it");
});

test("bridge: two owners' subscriptions never clobber each other's baseline", async () => {
  const store = createZhiyuStore({ file: path.join(tmpRoot("owners"), "z.db") });
  const roomA = store.roomCreate({ title: "甲房", ownerEmail: "a@x" });
  const roomB = store.roomCreate({ title: "乙房", ownerEmail: "b@x" });
  store.fleetSubAdd({ roomId: roomA.id, fleetId: "fa", fleetName: "甲队", ownerEmail: "a@x" });
  store.fleetSubAdd({ roomId: roomB.id, fleetId: "fb", fleetName: "乙队", ownerEmail: "b@x" });

  const byOwner = {
    "a@x": overview([fleetShape("fa", { stream: [{ title: "岗", at: 1000, summarySnip: "甲一" }] })]),
    "b@x": overview([fleetShape("fb", { stream: [{ title: "岗", at: 1000, summarySnip: "乙一" }] })]),
  };
  const b = registerFleetRoomBridge(express(), {
    store,
    resolveUser: () => ({ email: "a@x", groups: [] }),
    rejectUnauthenticated: (_q, r) => r.status(401).json({}),
    sampleFleets: async (owner) => byOwner[owner],
  });
  await b.tick(); // both baseline
  assert.equal(bridgeRows(store, roomA.id, "report").length + bridgeRows(store, roomB.id, "report").length, 0);

  byOwner["a@x"] = overview([fleetShape("fa", { stream: [{ title: "岗", at: 2000, summarySnip: "甲二" }] })]);
  byOwner["b@x"] = overview([fleetShape("fb", { stream: [{ title: "岗", at: 2000, summarySnip: "乙二" }] })]);
  await b.tick();
  const a = bridgeRows(store, roomA.id, "report");
  const bb = bridgeRows(store, roomB.id, "report");
  assert.equal(a.length, 1, "owner A's new report flows");
  assert.equal(bb.length, 1, "owner B's new report flows in the same tick");
  assert.match(a[0].content, /甲二/);
  assert.match(bb[0].content, /乙二/);
});

test("health: 抖动被合并（不逐条流入），稳定满窗口后一行带抖动计数", async () => {
  const store = createZhiyuStore({ file: path.join(tmpRoot("health-flap"), "z.db") });
  const room = store.roomCreate({ title: "抖动房", ownerEmail: "o@x" });
  store.fleetSubAdd({ roomId: room.id, fleetId: "f1", fleetName: "客服班组", ownerEmail: "o@x" });

  let clock = 1_000_000;
  const sample = { current: overview([fleetShape("f1")]) };
  const b = bridgeFor(store, sample, { healthSettleMs: 10 * 60 * 1000, nowMs: () => clock });
  await b.tick(); // baseline: abnormal 0

  // Flip abnormal → recovery → abnormal → recovery, each within minutes.
  const flip = async (abnormal, stepMs = 60_000) => {
    sample.current = overview([
      fleetShape("f1", { counts: { onDuty: 1, paused: 0, missing: abnormal, vacant: 0, passive: 0, failing: 0, total: 1 } }),
    ]);
    clock += stepMs;
    await b.tick();
  };
  await flip(1);
  await flip(0);
  await flip(1);
  await flip(0);
  assert.equal(bridgeRows(store, room.id, "health").length, 0, "窗口内的乒乓一条都不流入");

  // Now hold abnormal long enough to settle.
  await flip(1, 60_000);
  clock += 10 * 60 * 1000; // the same state has now held for the whole window
  await b.tick();
  const rows = bridgeRows(store, room.id, "health");
  assert.equal(rows.length, 1, "持续态满窗口才落一行");
  assert.match(rows[0].content, /异常/, "direction is abnormal");
  assert.match(rows[0].content, /抖动 \d+ 次已合并/, "the suppressed flaps are reported honestly");
  assert.equal(rows[0].meta.flaps >= 1, true, "flap count rides meta");

  await b.tick();
  assert.equal(bridgeRows(store, room.id, "health").length, 1, "no repeat once committed");
});

test("health: 稳定态不再重复落行；恢复同样要等窗口", async () => {
  const store = createZhiyuStore({ file: path.join(tmpRoot("health-stable"), "z.db") });
  const room = store.roomCreate({ title: "稳态房", ownerEmail: "o@x" });
  store.fleetSubAdd({ roomId: room.id, fleetId: "f1", fleetName: "客服班组", ownerEmail: "o@x" });

  let clock = 2_000_000;
  const sample = { current: overview([fleetShape("f1")]) };
  const b = bridgeFor(store, sample, { healthSettleMs: 10 * 60 * 1000, nowMs: () => clock });
  await b.tick();

  sample.current = overview([
    fleetShape("f1", { counts: { onDuty: 1, paused: 0, missing: 1, vacant: 0, passive: 0, failing: 0, total: 1 } }),
  ]);
  clock += 60_000;
  await b.tick(); // observed, not yet settled
  assert.equal(bridgeRows(store, room.id, "health").length, 0, "第一轮只观察");
  clock += 10 * 60 * 1000;
  await b.tick(); // settled
  assert.equal(bridgeRows(store, room.id, "health").length, 1);

  // Recovery also has to hold the window.
  sample.current = overview([fleetShape("f1")]);
  clock += 60_000;
  await b.tick();
  assert.equal(bridgeRows(store, room.id, "health").length, 1, "恢复也要等窗口");
  clock += 10 * 60 * 1000;
  await b.tick();
  const rows = bridgeRows(store, room.id, "health");
  assert.equal(rows.length, 2);
  assert.match(rows[1].content, /恢复/);
  assert.doesNotMatch(rows[1].content, /抖动/, "无抖动时不出现尾注");
});

test("health: 结束房重开清空观察中的迁移，不补发断流期状态", async () => {
  const store = createZhiyuStore({ file: path.join(tmpRoot("health-reopen"), "z.db") });
  const room = store.roomCreate({ title: "重开房", ownerEmail: "o@x" });
  store.fleetSubAdd({ roomId: room.id, fleetId: "f1", fleetName: "客服班组", ownerEmail: "o@x" });

  let clock = 3_000_000;
  const sample = { current: overview([fleetShape("f1")]) };
  const b = bridgeFor(store, sample, { healthSettleMs: 10 * 60 * 1000, nowMs: () => clock });
  await b.tick();

  // A deviation starts, then the room ends before it settles.
  sample.current = overview([
    fleetShape("f1", { counts: { onDuty: 1, paused: 0, missing: 1, vacant: 0, passive: 0, failing: 0, total: 1 } }),
  ]);
  clock += 60_000;
  await b.tick();
  store.roomSetStatus(room.id, "ended");
  clock += 60_000;
  await b.tick();
  store.roomSetStatus(room.id, "active");
  clock += 10 * 60 * 1000;
  await b.tick();
  assert.equal(bridgeRows(store, room.id, "health").length, 0, "断流期的迁移不补发，重开以当时状态为基线");

  // A genuinely new transition after reopen still flows (after its window).
  sample.current = overview([fleetShape("f1")]);
  clock += 60_000;
  await b.tick();
  clock += 10 * 60 * 1000;
  await b.tick();
  const rows = bridgeRows(store, room.id, "health");
  assert.equal(rows.length, 1, "重开后的新迁移照常流入");
  assert.match(rows[0].content, /恢复/);
});

test("paging: tail window, backward adjacency, private visibility unchanged", () => {
  const store = createZhiyuStore({ file: path.join(tmpRoot("page"), "z.db") });
  const room = store.roomCreate({ title: "长房", ownerEmail: "o@x" });
  for (let i = 1; i <= 12; i += 1) {
    store.messageAppend({ roomId: room.id, kind: "human", content: `m${i}` });
  }
  // A private row in the middle (viewer mem_x only).
  store.messageAppend({ roomId: room.id, kind: "human", visibility: "private:mem_x", content: "私窗" });

  const tail = store.messagesTail(room.id, 5);
  assert.equal(tail.length, 5);
  assert.deepEqual(tail.map((m) => m.seq), [8, 9, 10, 11, 12], "the last five VISIBLE rows, ascending");
  for (let i = 1; i < tail.length; i += 1) assert.ok(tail[i].seq > tail[i - 1].seq, "seq ascending");

  const before = store.messagesBefore(room.id, tail[0].seq, { limit: 5 });
  assert.equal(before.length, 5);
  assert.equal(before[before.length - 1].seq, tail[0].seq - 1, "windows are adjacent, never overlapping");

  // Walk to the head: the union equals the visible row count for this viewer
  // (12 shared rows; the private row at seq 13 is not visible to anon).
  let cursor = before[0].seq;
  let acc = 5 + before.length;
  for (;;) {
    const win = store.messagesBefore(room.id, cursor, { limit: 5 });
    if (win.length === 0) break;
    acc += win.length;
    cursor = win[0].seq;
  }
  assert.equal(acc, 12, "every visible row is reachable exactly once");

  const mine = store.messagesTail(room.id, 50, { viewerMemberId: "mem_x" });
  assert.ok(mine.some((m) => m.content === "私窗"), "the owner of a private row sees it while paging");
  const theirs = store.messagesTail(room.id, 50, { viewerMemberId: "mem_y" });
  assert.ok(!theirs.some((m) => m.content === "私窗"), "nobody else does");
});

test("retention: only ended rooms' system/event rows age out; dialogue and active rooms stay", () => {
  const store = createZhiyuStore({ file: path.join(tmpRoot("ret"), "z.db") });
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const active = store.roomCreate({ title: "进行中", ownerEmail: "o@x" });
  const ended = store.roomCreate({ title: "已结束", ownerEmail: "o@x" });
  store.roomSetStatus(ended.id, "ended");

  store.messageAppend({ roomId: active.id, kind: "system", content: "old sys", createdAt: old });
  store.messageAppend({ roomId: ended.id, kind: "system", content: "old sys", createdAt: old });
  store.messageAppend({ roomId: ended.id, kind: "event", content: "", meta: { event: "pass" }, createdAt: old });
  store.messageAppend({ roomId: ended.id, kind: "human", content: "keep me", createdAt: old });
  store.messageAppend({ roomId: ended.id, kind: "agent", content: "keep me too", createdAt: old });

  const dry = store.pruneRoomSystemRows({ olderThanMs: 30 * 24 * 60 * 60 * 1000, dryRun: true });
  assert.deepEqual({ matched: dry.matched, deleted: dry.deleted }, { matched: 2, deleted: 0 }, "dry-run counts without deleting");

  const applied = store.pruneRoomSystemRows({ olderThanMs: 30 * 24 * 60 * 60 * 1000 });
  assert.equal(applied.deleted, 2);

  const left = store.messagesAfter(ended.id, 0, { limit: 100 });
  assert.deepEqual(left.map((m) => m.kind).sort(), ["agent", "human"], "dialogue survives");
  assert.equal(store.messagesAfter(active.id, 0, { limit: 100 }).length, 1, "an active room is never pruned");

  const again = store.pruneRoomSystemRows({ olderThanMs: 30 * 24 * 60 * 60 * 1000 });
  assert.equal(again.deleted, 0, "the sweep is idempotent");
});

test("retention: 到期制而非启动延时——pod 活不满一小时也能落到 tick", () => {
  const file = path.join(tmpRoot("ret-tick"), "z.db"); // one path: the "restart" must hit the same DB
  const store = createZhiyuStore({ file });
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  const ended = store.roomCreate({ title: "已结束", ownerEmail: "o@x" });
  store.roomSetStatus(ended.id, "ended");
  store.messageAppend({ roomId: ended.id, kind: "system", content: "old sys", createdAt: old });
  const olderThanMs = 30 * 24 * 60 * 60 * 1000;

  // First tick ever: due (no marker) → runs and records the marker.
  const first = store.retentionTick({ olderThanMs });
  assert.equal(first.ran, true, "首次必然到期");
  assert.equal(first.deleted, 1);

  // Immediately again: not due — a pod restart inside the interval must not
  // sweep twice (the marker lives in the DB, not in the process).
  const second = store.retentionTick({ olderThanMs });
  assert.equal(second.ran, false, "间隔内不再跑");
  assert.ok(store.metaGet("retention_last_run"), "marker 已落库，可跨进程续用");

  // A fresh store over the same file still sees the marker (simulated restart).
  const reopened = createZhiyuStore({ file });
  assert.equal(reopened.retentionTick({ olderThanMs }).ran, false, "重启后仍按到期判，不因启动就扫");

  // Force it overdue again → runs.
  reopened.metaSet("retention_last_run", "1");
  assert.equal(reopened.retentionTick({ olderThanMs }).ran, true, "过期后再次执行");
});

test("route: after/before/tail are mutually exclusive; limit is validated and clamped; tail is the newest window", async () => {
  const expressApp = (await import("express")).default;
  const app = expressApp();
  const dataRoot = tmpRoot("route");
  registerZhiyuRoutes(app, {
    dataRoot,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    ssePollMs: 60,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { "x-user": "o@x", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const created = await call("POST", "/api/zhiyu/rooms", { title: "翻页房" });
    assert.equal(created.status, 200);
    const roomId = created.body.room.id;
    for (let i = 1; i <= 4; i += 1) await call("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: `m${i}` });

    assert.equal((await call("GET", `/api/zhiyu/rooms/${roomId}/messages?after=1&tail=2`)).status, 400);
    assert.equal((await call("GET", `/api/zhiyu/rooms/${roomId}/messages?after=1&before=2`)).status, 400);
    assert.equal((await call("GET", `/api/zhiyu/rooms/${roomId}/messages?limit=0`)).status, 400);

    const tail = await call("GET", `/api/zhiyu/rooms/${roomId}/messages?tail=2`);
    assert.equal(tail.status, 200);
    assert.equal(tail.body.messages.length, 2);
    assert.match(tail.body.messages[1].content, /m4/, "tail ends at the newest row");

    const before = await call("GET", `/api/zhiyu/rooms/${roomId}/messages?before=${tail.body.messages[0].seq}&limit=2`);
    assert.equal(before.status, 200);
    assert.equal(before.body.messages[before.body.messages.length - 1].seq, tail.body.messages[0].seq - 1);

    const clamped = await call("GET", `/api/zhiyu/rooms/${roomId}/messages?limit=5000`);
    assert.equal(clamped.status, 200, "an over-large limit is clamped, not rejected");
  } finally {
    srv.close();
  }
});

test("billing mode: 展示模式声明可读写，未声明默认 billed", () => {
  const file = path.join(tmpRoot("billing-mode"), "z.db");
  const store = createZhiyuStore({ file });
  const room = store.roomCreate({ title: "展示房", ownerEmail: "o@x" });
  assert.equal(store.roomGet(room.id).billingMode, "billed", "默认按计费键");
  assert.equal(store.roomPatch(room.id, { billingMode: "showcase" }).billingMode, "showcase");
  assert.equal(store.roomGet(room.id).billingMode, "showcase", "落库并读回");
  assert.equal(store.roomPatch(room.id, { billingMode: "billed" }).billingMode, "billed", "可切回");
  // 非法值一律落回 billed（不因拼错而意外变免费）
  assert.equal(store.roomPatch(room.id, { billingMode: "free" }).billingMode, "billed");
});

test("billing mode: 旧库无该列时自动补列且旧行为默认 billed", async () => {
  const dir = tmpRoot("billing-legacy");
  const file = path.join(dir, "z.db");
  const { default: Database } = await import("better-sqlite3");
  const raw = new Database(file);
  raw.exec(`CREATE TABLE zy_rooms (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', owner_email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', reply_cap INTEGER, idle_minutes INTEGER NOT NULL DEFAULT 15,
    source_session TEXT, daily_budget_turns INTEGER, day_stamp TEXT, day_turns INTEGER NOT NULL DEFAULT 0,
    proactive_greeting INTEGER NOT NULL DEFAULT 0, last_activity_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
    ended_at INTEGER)`);
  raw.prepare(`INSERT INTO zy_rooms (id, owner_email, last_activity_at, created_at) VALUES ('r1','o@x',1,1)`).run();
  raw.close();
  const store = createZhiyuStore({ file });
  assert.equal(store.roomGet("r1").billingMode, "billed", "旧行补列后默认 billed");
});

test("settle_unbilled: expected 标记随 billing_mode 变（展示=预期 / 计费=配置缺口）", async () => {
  const store = createZhiyuStore({ file: path.join(tmpRoot("unbilled-flag"), "z.db") });
  const room = store.roomCreate({ title: "缺口房", ownerEmail: "o@x" });
  store.memberAdd({ roomId: room.id, kind: "agent", ref: "pk:agent", display: "接待分身" });

  // settleTurn 抛 NO_BILLING_KEY，模拟 facet 的降级响应
  const failingSettle = async () => {
    const err = new Error("host-settle HTTP 409: {\"code\":\"NO_BILLING_KEY\"}");
    err.code = "NO_BILLING_KEY";
    throw err;
  };
  const router = createRoomRouter({
    store,
    effectiveCap: () => 3,
    callAgent: async () => ({ text: "答一句" }),
    settleTurn: failingSettle,
    memoryBlock: async () => "",
  });

  // 未声明 showcase → expected=false
  const msg = store.messageAppend({ roomId: room.id, kind: "human", content: "你好" });
  await router.onHumanMessage({ room: store.roomGet(room.id), member: { id: "m0", ref: "u@x", kind: "user" }, message: msg.row });
  const first = store.messagesAfter(room.id, 0, { limit: 200 }).filter((m) => m.meta?.event === "settle_unbilled");
  assert.equal(first.length, 1, "未计费留痕落行");
  assert.equal(first[0].meta.expected, false, "未声明展示模式 → 配置缺口");

  // 置 showcase → expected=true
  store.roomPatch(room.id, { billingMode: "showcase" });
  const msg2 = store.messageAppend({ roomId: room.id, kind: "human", content: "再问一次" });
  await router.onHumanMessage({ room: store.roomGet(room.id), member: { id: "m0", ref: "u@x", kind: "user" }, message: msg2.row });
  const rows = store.messagesAfter(room.id, 0, { limit: 200 }).filter((m) => m.meta?.event === "settle_unbilled");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].meta.expected, true, "展示模式 → 预期未计费");
});
