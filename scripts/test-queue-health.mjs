#!/usr/bin/env node
// ── Queue liveness tests (fix-task-queue-deadlock tasks 1.1) ─────────────────
//
// Pins the projection that makes a stalled serial queue VISIBLE. Motivation
// (2026-11-08 live on the owner cell): 776 tasks, 1 `running` that had been
// going for 6.5 minutes without settling, 22 `queued` with the oldest parked
// since 00:34 — and `/api/ready` still answered `{"ready":true}`. That false
// green turned one stall into hours of misdiagnosis (queue contention →
// MCP count → zombie state → budget exhaustion, each disproved in turn).
//
// `queueHealth` reads the engine's own task map; the tests drive real records
// (insert + direct state stamping) rather than a parallel fake, so the
// projection is pinned against the shapes the engine actually produces.
//
//   node --test scripts/test-queue-health.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Isolate task storage: TASK_STORAGE_DIR is frozen at module load from
// CRON_STORAGE_PATH, so the env must be set AFTER the static imports above
// but BEFORE the dynamic engine import below — otherwise the suite reads
// (and rewrites!) the developer machine's real cron store.
process.env.CRON_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "queue-test-"));
const {
  initTaskEngine,
  insertTask,
  getRecord,
  enqueueExecution,
  queueHealth,
  QUEUE_MAX_OLDEST_QUEUED_MS,
  _stampSettlement,
  _setDrainPaused,
} = await import(path.join(here, "../task-engine.js"));

const neverTurn = () => new Promise(() => {});

// Hold the drain for every test in this file.
//
// The drain moves a round from `queued` to `running` on the next event-loop
// turn. That is correct engine behaviour, but it makes "how deep is the
// backlog" a function of "has the loop turned yet" — which the awaits inside
// freshEngine() (and in the test runner itself) make unpredictable. Measured
// 2026-11-25: identical code passed locally and failed in CI as
// `the backlog is real` with `oldestQueuedMs: null`; the slower machine simply
// gave the drain one more turn before the assertion ran.
//
// Nothing is weakened by freezing it: these tests are about the PROJECTION, and
// the projection reads `state`, which is exactly what must still say "queued".
// The one test that cares about dispatch resumes the drain itself.
_setDrainPaused(true);

// Every test needs a CLEAN store, and a plain re-init does not give one: the
// whole file shares one temp dir, `state` is part of the persisted record, and
// loadTasks keeps `queued` (re-queueing it for repair). So a record an earlier
// test left queued is RELOADED here — and since several tests assert a global
// count (`queued === 0`), that residue decides the result. This is exactly how
// the file failed in CI (1 !== 0 at the last test) while passing locally: the
// enqueue path saves with `void saveTasks()`, so which state is on disk when
// the next test starts depends on how fast the chained write lands.
//
// Order matters: init FIRST (any write still in flight then recomputes its
// snapshot from the fresh, empty map and settles before init returns — the
// await covers the write chain), then wipe the store, then init again so the
// load sees nothing.
async function freshEngine() {
  const init = () => initTaskEngine({ broadcast: () => {}, runTurn: neverTurn, isBusy: () => false });
  // Clear the STORE FILE, not the directory. Removing the directory raced the
  // chained save: its rename of a .tmp into place hit ENOENT ("[persistence]
  // flush lost (dir vanished mid-write)"), which surfaced in CI as a
  // file-level 'test failed' rather than an assertion (run 42469296542).
  // With the directory intact every rename lands; the second init then loads
  // an empty store. Retry once if a late save slipped in between.
  const store = path.join(process.env.CRON_STORAGE_PATH, "jobs.json");
  await init();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await new Promise((r) => setTimeout(r, 0)); // let the write chain settle
    fs.rmSync(store, { force: true });
    await init();
    const h = queueHealth();
    if (h.queued === 0 && h.running === 0) return;
  }
}

function addTask(id) {
  insertTask({ id, name: id, prompt: "p", trigger: "manual", targetType: "persona" });
  return id;
}

test("an empty engine reports healthy", async () => {
  await freshEngine();
  const h = queueHealth();
  assert.equal(h.queued, 0);
  assert.equal(h.running, 0);
  assert.equal(h.oldestQueuedMs, null);
  assert.equal(h.oldestRunningMs, null);
  assert.equal(h.overBudget, 0);
  assert.equal(h.degraded, false);
});

test("a backlog inside the threshold stays healthy", async () => {
  await freshEngine();
  enqueueExecution(addTask("fresh"));
  const h = queueHealth();
  assert.equal(h.queued, 1);
  assert.equal(h.degraded, false);
  assert.ok(h.oldestQueuedMs !== null && h.oldestQueuedMs < QUEUE_MAX_OLDEST_QUEUED_MS);
});

test("a queued task stuck past the threshold degrades the probe", async () => {
  await freshEngine();
  const id = addTask("stuck");
  enqueueExecution(id);
  const h = queueHealth({ now: Date.now() + QUEUE_MAX_OLDEST_QUEUED_MS + 60_000 });
  assert.equal(h.queued, 1);
  assert.equal(h.degraded, true);
  assert.ok(h.oldestQueuedMs > QUEUE_MAX_OLDEST_QUEUED_MS);
});

test("a running turn past budget+grace degrades the probe with no backlog", async () => {
  await freshEngine();
  const id = addTask("long-run");
  const rec = getRecord(id);
  rec.state = "running";
  rec.lastRun = new Date(Date.now() - 20 * 60_000).toISOString();

  const h = queueHealth({ budgetOf: () => 5 * 60_000, graceMs: 5 * 60_000 });
  assert.equal(h.queued, 0);
  assert.equal(h.running, 1);
  assert.equal(h.overBudget, 1);
  assert.equal(h.degraded, true);
  assert.ok(h.oldestRunningMs >= 19 * 60_000);
});

test("a running turn inside budget+grace does not degrade", async () => {
  await freshEngine();
  const id = addTask("short-run");
  const rec = getRecord(id);
  rec.state = "running";
  rec.lastRun = new Date(Date.now() - 60_000).toISOString();

  const h = queueHealth({ budgetOf: () => 5 * 60_000, graceMs: 5 * 60_000 });
  assert.equal(h.running, 1);
  assert.equal(h.overBudget, 0);
  assert.equal(h.degraded, false);
});

test("a broken budget resolver never fails the snapshot", async () => {
  await freshEngine();
  const id = addTask("bad-budget");
  const rec = getRecord(id);
  rec.state = "running";
  rec.lastRun = new Date().toISOString();

  const h = queueHealth({
    budgetOf: () => {
      throw new Error("boom");
    },
  });
  assert.equal(h.running, 1);
  assert.equal(h.degraded, false);
});

test("paused and idle tasks are not counted as backlog", async () => {
  await freshEngine();
  addTask("idle");
  const h = queueHealth();
  assert.equal(h.queued, 0);
  assert.equal(h.running, 0);
  assert.equal(h.degraded, false);
});

test("a record left queued on disk does not leak into a fresh engine", async () => {
  // Pins the isolation contract freshEngine() now owns. Without the wipe, this
  // is the CI failure reproduced locally: loadTasks keeps the persisted
  // `queued` state and the projection counts it.
  fs.writeFileSync(
    path.join(process.env.CRON_STORAGE_PATH, "jobs.json"),
    JSON.stringify([
      {
        id: "stale",
        name: "stale",
        trigger: "manual",
        prompt: "p",
        targetType: "persona",
        state: "queued",
        queuedAt: Date.now() - 1000,
        history: [],
      },
    ]),
  );
  await freshEngine();
  const h = queueHealth();
  assert.equal(h.queued, 0, "a stale queued record must not survive a fresh engine");
  assert.equal(h.running, 0);
  assert.equal(h.degraded, false);
});

// ── 等待时长必须从 firstQueuedAt 起算（2026-11-08）───────────────────────
//
// `queuedAt` 每次重新入队、每次启动 drain 都会重打（task-engine 自己的设计：
// 它答的是"本次尝试等了多久"）。用它算 oldestQueuedMs，重启后整批积压会显示成
// 刚刚入队 —— 而 `oldestQueuedMs` 正是 `/api/ready` 判 degraded 的依据。
// 实测后果：积压 224 分钟时探针仍报 healthy，和 queue-liveness 那次假绿同型。
test("oldestQueuedMs measures from firstQueuedAt, not the re-stamped queuedAt", async () => {
  await freshEngine();
  const now = Date.now();
  insertTask({
    id: "anchor-q-1",
    name: "anchor-q-1",
    prompt: "x",
    trigger: "manual",
    state: null,
  });
  const rec = getRecord("anchor-q-1");
  rec.state = "queued";
  rec.queuedAt = now - 30_000;          // 本次尝试只等了 30 秒
  rec.firstQueuedAt = now - 900_000;    // 但第一次要槽位是 15 分钟前
  const h = queueHealth({ now });
  assert.equal(h.queued, 1);
  assert.ok(
    h.oldestQueuedMs >= 899_000,
    `oldest wait must use firstQueuedAt (got ${h.oldestQueuedMs})`,
  );
});

test("legacy queued record without firstQueuedAt still reports a wait", async () => {
  await freshEngine();
  const now = Date.now();
  insertTask({
    id: "anchor-q-2",
    name: "anchor-q-2",
    prompt: "x",
    trigger: "manual",
    state: null,
  });
  const rec = getRecord("anchor-q-2");
  rec.state = "queued";
  rec.queuedAt = now - 120_000;
  delete rec.firstQueuedAt;
  const h = queueHealth({ now });
  assert.ok(h.oldestQueuedMs >= 119_000, `legacy fallback (got ${h.oldestQueuedMs})`);
});

// ── busy vs stalled (fix-queue-degraded-vs-busy) ─────────────────────────────
//
// Live 2026-11-09: a fleet cell held 60-67 minutes of backlog while a turn
// settled every 4-5 minutes (four of five ok), and /api/ready still answered
// 503 — the oldest waiting item was simply older than the threshold. That is a
// busy cell, not the stall this probe exists to catch, and 503 on the serving
// path is a false alarm that reads like an outage.

test("backlog WITH settlements flowing is busy, not degraded", async () => {
  await freshEngine();
  const id = addTask("settling");
  enqueueExecution(id);
  const now = Date.now();
  // One clock for both facts (the probe reads them at the same instant): a
  // settlement 30 seconds before the read, a backlog 60 minutes deep — the live
  // 2026-11-09 shape.
  const probeNow = now + QUEUE_MAX_OLDEST_QUEUED_MS + 50 * 60_000;
  // `_stampSettlement` comes from the top-of-file import on purpose: a second
  // `await import(...)` here yields the event loop, the drain runs, and the
  // just-enqueued round flips to `running` before the read — so `oldestQueuedMs`
  // is null and "the backlog is real" fails. Measured 2026-11-25: this test was
  // red standalone (not a flake); the stray await was the cause.
  _stampSettlement(probeNow - 30_000);
  const h = queueHealth({ now: probeNow });
  // The message carries the whole projection: if this ever fails again, the
  // failure itself says whether the backlog vanished (queued=0) or the anchor
  // was missing (oldest=null), instead of just "expected true".
  assert.ok(
    h.oldestQueuedMs > QUEUE_MAX_OLDEST_QUEUED_MS,
    `the backlog is real (got oldestQueuedMs=${h.oldestQueuedMs}, queued=${h.queued}, running=${h.running})`,
  );
  assert.equal(h.degraded, false, "progress means busy, not stalled");
  assert.ok(h.lastSettledAt != null, "and the fact is on the projection");

  // And the round really is dispatchable — freezing the drain above must not be
  // hiding a queue that would never run.
  _setDrainPaused(false);
  await new Promise((r) => setImmediate(r));
  const after = queueHealth({ now: probeNow });
  assert.ok(
    after.running >= 1 || after.queued === 0,
    `after resuming, the round must be picked up (queued=${after.queued}, running=${after.running})`,
  );
  _setDrainPaused(true); // restore for the rest of the file
});

test("backlog WITHOUT settlements for the same window still degrades", async () => {
  await freshEngine();
  const id = addTask("stuck-again");
  enqueueExecution(id);
  const later = Date.now() + QUEUE_MAX_OLDEST_QUEUED_MS * 3;
  const h = queueHealth({ now: later });
  assert.equal(h.degraded, true, "nothing settled for three windows — that IS a stall");
});

// The pause seam this file relies on must actually hold.
//
// Why an explicit test: the fix above is invisible locally — with a fast event
// loop the assertion passes either way, so nothing would notice if the pause
// were removed. This test forces the turn the drain needs, which is what CI's
// slower machine does for free.
test("pausing the drain keeps a round queued across event-loop turns", async () => {
  await freshEngine();
  _setDrainPaused(true);
  try {
    const id = addTask("paused-probe");
    enqueueExecution(id);
    // Give the drain every chance to run: several macrotask turns.
    for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
    const h = queueHealth({ now: Date.now() + QUEUE_MAX_OLDEST_QUEUED_MS + 60_000 });
    assert.equal(h.queued, 1, "paused drain must leave the round queued");
    assert.equal(h.running, 0, "and must not have started it");
    assert.ok(h.oldestQueuedMs > QUEUE_MAX_OLDEST_QUEUED_MS, "so the backlog stays observable");
  } finally {
    _setDrainPaused(false);
  }
  // Resuming must release it — a pause that never lets go would be a leak.
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
  const after = queueHealth();
  assert.ok(after.running >= 1 || after.queued === 0, `resume must dispatch (queued=${after.queued})`);
});
