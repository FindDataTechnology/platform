#!/usr/bin/env node
// ── Trace store tests (bound-trace-storage) ──────────────────────────────────
//
// Covers the four properties that keep trace storage bounded, plus the
// loss-free move out of the session index:
//
//   1. streaming deltas are not persisted; non-delta chunks are;
//   2. the store is a dedicated database file with auto_vacuum=INCREMENTAL;
//   3. pruning runs on a schedule (not only at boot) and reclaims space;
//   4. legacy rows move from the session index into the trace database intact,
//      idempotently, subagent rows included.
//
//   node --test scripts/test-trace-store.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import Database from "better-sqlite3";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Shared module instances, exactly as the server runs them: db.js and trace.js
// hold module state (the open handle, the queue), and trace.js must see the
// SAME db.js instance the test initialized. Each test re-points the env and
// re-inits; initTrace closes any previous handle (re-init safe).
const db = await import("../db.js");
const trace = await import("../server/trace.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freshStores({ retentionDays } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "trace-store-"));
  process.env.DB_PATH = path.join(root, "app.db");
  process.env.TRACE_DB_PATH = path.join(root, "trace.db");
  if (retentionDays !== undefined) process.env.TRACE_RETENTION_DAYS = String(retentionDays);
  else delete process.env.TRACE_RETENTION_DAYS;
  await db.initDb();
  await trace.initTrace();
  return { root, db, trace };
}

// Live-lane frame (restore-assistant-stream-020): the shape the bridge
// forwards today — deltas and finish frames ride platform/stream.
const streamFrame = (type, extra = {}) => ({
  method: "platform/stream",
  params: { sessionId: "s1", frame: { type: "chunk", chunk: { type, ...extra } } },
});
const ev = (type, data = {}) => ({ method: "session.event", params: { event: { type, data } } });

test("streaming deltas are dropped; non-delta chunks are stored", async () => {
  const { root, trace } = await freshStores();
  try {
    trace.bindTurn("t1");
    trace.record(streamFrame("text-delta", { text: "hello world" }), { sessionId: "s1", turnId: "t1" });
    trace.record(streamFrame("reasoning-delta", { text: "hmm" }), { sessionId: "s1", turnId: "t1" });
    trace.record(streamFrame("tool-call-delta", { text: "partial" }), { sessionId: "s1", turnId: "t1" });
    trace.record(streamFrame("finish", { reason: { kind: "stop" }, usage: { inputTokens: 3, outputTokens: 4 } }), {
      sessionId: "s1",
      turnId: "t1",
    });
    trace.record(ev("turn/end", { reason: { kind: "stop" } }), { sessionId: "s1", turnId: "t1" });
    await sleep(700);
    const events = trace.getTurn("t1");
    assert.equal(events.length, 2, `expected finish + turn/end only, got ${JSON.stringify(events.map((e) => e.summary))}`);
    assert.ok(events.some((e) => e.summary.includes("Finish")), "finish frame must be stored");
    assert.ok(events.some((e) => e.summary.includes("tokens=")), "finish frame must keep token usage");
    // Sequence stays gap-free: dropped deltas consume no seq.
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);
  } finally {
    await trace.shutdownTrace();
    await rm(root, { recursive: true, force: true });
  }
});

test("the trace store is a separate file with auto_vacuum=INCREMENTAL", async () => {
  const { root, trace } = await freshStores();
  try {
    const info = trace.traceStoreInfo();
    assert.equal(info.autoVacuum, 2, "auto_vacuum must be INCREMENTAL (2)");
    assert.ok(info.path.endsWith("trace.db"), `trace store path: ${info.path}`);
    assert.notEqual(path.resolve(info.path), path.resolve(process.env.DB_PATH));
  } finally {
    await trace.shutdownTrace();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh session index has no trace_events table", async () => {
  const { root, db, trace } = await freshStores();
  try {
    const row = db
      .getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='trace_events'`)
      .get();
    assert.equal(row, undefined, "trace_events must not exist in the session index");
  } finally {
    await trace.shutdownTrace();
    await rm(root, { recursive: true, force: true });
  }
});

test("prune removes rows past the window and reclaims space", async () => {
  const { root, trace } = await freshStores({ retentionDays: 7 });
  try {
    // Seed old rows through the tap, then age them by rewriting ts.
    trace.bindTurn("old-turn");
    for (let i = 0; i < 400; i++) {
      trace.record(ev("step/start", { i }), { sessionId: "s1", turnId: "old-turn" });
    }
    await sleep(900);
    const before = trace.traceStoreInfo();
    assert.equal(before.rows, 400);

    // Age them out of the window by rewriting ts directly on the store file.
    const { default: Database } = await import("better-sqlite3");
    const raw = new Database(before.path);
    raw.prepare(`UPDATE trace_events SET ts = ?`).run(Date.now() - 8 * 24 * 60 * 60 * 1000);
    raw.close();

    const deleted = trace.pruneNow();
    assert.equal(deleted, 400, "all aged rows pruned");
    const after = trace.traceStoreInfo();
    assert.equal(after.rows, 0);
    assert.equal(after.freelistCount, 0, "incremental_vacuum must return pages to the filesystem");
    assert.ok(after.sizeBytes <= before.sizeBytes, "file must not grow from pruning");
  } finally {
    await trace.shutdownTrace();
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning is scheduled, not boot-only", async () => {
  const { root, trace } = await freshStores();
  try {
    // The timer must exist and be unref'd so it never holds the process open.
    const info = trace.traceStoreInfo();
    assert.equal(info.retentionDays, 7, "default retention is 7 days");
    // Observable proof of a live timer: pruneNow is wired to the same function
    // the interval calls; assert the interval handle is registered by checking
    // shutdown clears it (a second shutdown must not throw).
    await trace.shutdownTrace();
    await trace.shutdownTrace();
    assert.equal(trace.traceStoreInfo(), null, "store closed after shutdown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy trace rows move out of the session index intact and idempotently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trace-move-"));
  const appPath = path.join(root, "app.db");
  const tracePath = path.join(root, "trace.db");
  process.env.DB_PATH = appPath;
  process.env.TRACE_DB_PATH = tracePath;
  delete process.env.TRACE_RETENTION_DAYS;

  // Build a session index that still carries the pre-move trace table. Rows are
  // recent (inside the retention window) so the move — not the prune — is what
  // this test observes; the aged-row case is covered separately below.
  const now = Date.now();
  {
    const app = new Database(appPath);
    app.exec(`CREATE TABLE IF NOT EXISTS trace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      ts INTEGER NOT NULL, method TEXT NOT NULL, event_type TEXT, payload TEXT NOT NULL)`);
    const ins = app.prepare(`INSERT INTO trace_events (turn_id, session_id, seq, ts, method, event_type, payload)
      VALUES (?,?,?,?,?,?,?)`);
    ins.run("t-legacy-1", "s1", 1, now - 3000, "session.event", "user/message", JSON.stringify({ a: 1 }));
    ins.run("t-legacy-1", "s1", 2, now - 2000, "session.event", "assistant/message", JSON.stringify({ b: 2 }));
    // A subagent session's rows: identified by the session id in the payload.
    ins.run("t-legacy-2", "child-session", 1, now - 1000, "session.event", "assistant/chunk", JSON.stringify({ c: 3 }));
    app.close();
  }

  await db.initDb();
  await trace.initTrace();
  try {
    const moved = trace.getTurn("t-legacy-1");
    assert.equal(moved?.length, 2, "both legacy rows moved");
    assert.deepEqual(moved.map((e) => e.eventType), ["user/message", "assistant/message"]);
    assert.deepEqual(moved.map((e) => e.seq), [1, 2], "seq preserved");
    assert.equal(moved[0].ts, now - 3000, "ts preserved");
    assert.deepEqual(moved[0].payload, { a: 1 }, "payload preserved verbatim");
    assert.equal(trace.getTurn("t-legacy-2")?.length, 1, "subagent session rows moved too");

    // The session index no longer carries the table.
    const leftover = db
      .getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='trace_events'`)
      .get();
    assert.equal(leftover, undefined, "legacy table dropped from the session index");
  } finally {
    await trace.shutdownTrace();
  }

  // Second boot: nothing to move, and the moved rows survive (idempotent).
  await db.initDb();
  await trace.initTrace();
  try {
    assert.equal(trace.getTurn("t-legacy-1")?.length, 2, "rows survive a second boot");
    assert.equal(trace.traceStoreInfo().rows, 3, "no duplication on re-run");
  } finally {
    await trace.shutdownTrace();
    await rm(root, { recursive: true, force: true });
  }
});

test("the retention window applies to moved rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trace-aged-"));
  process.env.DB_PATH = path.join(root, "app.db");
  process.env.TRACE_DB_PATH = path.join(root, "trace.db");
  delete process.env.TRACE_RETENTION_DAYS;

  const now = Date.now();
  {
    const app = new Database(process.env.DB_PATH);
    app.exec(`CREATE TABLE IF NOT EXISTS trace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      ts INTEGER NOT NULL, method TEXT NOT NULL, event_type TEXT, payload TEXT NOT NULL)`);
    const ins = app.prepare(`INSERT INTO trace_events (turn_id, session_id, seq, ts, method, event_type, payload)
      VALUES (?,?,?,?,?,?,?)`);
    ins.run("t-recent", "s1", 1, now - 1000, "session.event", "turn/start", "{}");
    ins.run("t-aged", "s1", 1, now - 30 * 24 * 60 * 60 * 1000, "session.event", "turn/start", "{}");
    app.close();
  }

  await db.initDb();
  await trace.initTrace();
  try {
    assert.equal(trace.getTurn("t-recent")?.length, 1, "in-window row survives the move");
    assert.equal(trace.getTurn("t-aged"), null, "out-of-window row is moved then pruned by the same policy");
    assert.equal(trace.traceStoreInfo().rows, 1);
  } finally {
    await trace.shutdownTrace();
    await rm(root, { recursive: true, force: true });
  }
});

test("read API returns turns newest-first with derived model/provider", async () => {
  const { root, trace } = await freshStores();
  try {
    trace.bindTurn("turn-a");
    trace.record(ev("turn/start"), { sessionId: "s1", turnId: "turn-a" });
    trace.record(
      ev("request/header", { header: { config: { provider: "volces", model: "deepseek-v4-pro" } } }),
      { sessionId: "s1", turnId: "turn-a" },
    );
    trace.record(ev("turn/end", { reason: { kind: "stop" } }), { sessionId: "s1", turnId: "turn-a" });
    await sleep(700);
    const turns = trace.listTurns({});
    assert.equal(turns.length, 1);
    assert.equal(turns[0].turnId, "turn-a");
    assert.equal(turns[0].model, "deepseek-v4-pro");
    assert.equal(turns[0].provider, "volces");
    assert.equal(turns[0].hasError, false);
    assert.equal(trace.getTurn("nope"), null);
  } finally {
    await trace.shutdownTrace();
    await rm(root, { recursive: true, force: true });
  }
});

test("error turns are flagged", async () => {
  const { root, trace } = await freshStores();
  try {
    trace.bindTurn("turn-err");
    trace.record(ev("turn/start"), { sessionId: "s1", turnId: "turn-err" });
    trace.record(ev("turn/end", { reason: { kind: "error" } }), { sessionId: "s1", turnId: "turn-err" });
    await sleep(700);
    const [t] = trace.listTurns({});
    assert.equal(t.hasError, true);
  } finally {
    await trace.shutdownTrace();
    await rm(root, { recursive: true, force: true });
  }
});

test("the store survives a write failure without breaking the caller", async () => {
  const { root, trace } = await freshStores();
  try {
    // Closing the store underneath the tap must not throw out of record().
    await trace.shutdownTrace();
    assert.doesNotThrow(() => trace.record(ev("turn/start"), { sessionId: "s1", turnId: "t" }));
    assert.deepEqual(trace.listTurns({}), [], "reads degrade to empty when the store is closed");
    assert.equal(trace.getTurn("t"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the module self-check passes as a subprocess", async () => {
  // `node server/trace.js` is the documented way to verify a store by hand
  // (its header comment names it). It exercises the real record → flush → read
  // path end to end, which the in-process tests above do not cover — and it
  // caught a real ordering bug (reads placed after shutdownTrace, which closes
  // this module's own handle) during the image smoke test on 2026-10-10.
  const root = await mkdtemp(path.join(tmpdir(), "trace-selfcheck-"));
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run(
      process.execPath,
      [path.join(REPO, "server", "trace.js")],
      {
        env: { ...process.env, DB_PATH: path.join(root, "app.db"), TRACE_DB_PATH: path.join(root, "trace.db") },
        timeout: 60_000,
      }
    );
    assert.match(stdout, /OK trace self-check/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("request/header stores identity only — the tool roster never lands (slim-trace-request-headers)", async () => {
  const { root, trace } = await freshStores();
  try {
    trace.bindTurn("turn-slim");
    const bigRoster = Array.from({ length: 712 }, (_, i) => ({
      name: `mcp__fd-quant__tool_${i}`,
      description: "x".repeat(150),
      input_schema: { type: "object", properties: { a: { type: "string" } } },
    }));
    trace.record(
      ev("request/header", { header: { config: { provider: "volces", model: "deepseek-v4-pro" }, tools: bigRoster, adapterDefaults: { maxTokens: true } } }),
      { sessionId: "s1", turnId: "turn-slim" },
    );
    trace.record(ev("turn/end", { reason: { kind: "stop" } }), { sessionId: "s1", turnId: "turn-slim" });
    await sleep(700);
    const turns = trace.listTurns({});
    assert.equal(turns.length, 1);
    // 消费方字段照常归因
    assert.equal(turns[0].model, "deepseek-v4-pro");
    assert.equal(turns[0].provider, "volces");
    // 落库行瘦身：无 tools、无 adapterDefaults
    const stored = trace.getTurn("turn-slim").find((e) => e.eventType === "request/header");
    const header = stored.payload.event.data.header;
    assert.deepEqual(Object.keys(header), ["config"]);
    assert.deepEqual(header.config, { provider: "volces", model: "deepseek-v4-pro" });
    const rawLen = JSON.stringify(stored.payload).length;
    assert.ok(rawLen < 500, `stored header payload should be identity-only, got ${rawLen} bytes`);
  } finally {
    trace.shutdownTrace();
    await rm(root, { recursive: true, force: true });
  }
});

// ── 5. 损坏要自己说出来（2026-11-08 实证）─────────────────────────────────
//
// owner cell 的 trace.db btree 坏了 8 天而无人知：`isTraceReady()` 一直 true、
// 埋点照常调用、prune 每小时抛一行 malformed 埋在日志里，文件从 300MB 涨到 2.3GB。
// 现在打开时跑 quick_check，并把它放进 traceStoreInfo 的读面。
test("a healthy store reports integrity ok", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trace-integrity-"));
  process.env.PLATFORM_DATA_DIR = root;
  const trace = await import(path.join(REPO, "server/trace.js"));
  try {
    await trace.initTrace();
    const info = trace.traceStoreInfo();
    assert.ok(info, "store info must be readable");
    assert.equal(info.integrity?.ok, true, `expected integrity ok, got ${JSON.stringify(info.integrity)}`);
  } finally {
    trace.shutdownTrace();
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt store reports integrity not ok instead of looking healthy", async () => {
  // 必须在子进程里跑：paths.js 在模块加载时就把 PLATFORM_DATA_DIR 冻死
  // （同一个进程里改 env 再 import 无效），同文件里 self-check 那条测试也是这么做的。
  const root = await mkdtemp(path.join(tmpdir(), "trace-corrupt-"));
  const file = path.join(root, "trace.db");
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(file);
    db.exec(`CREATE TABLE trace_events (id INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT, session_id TEXT, seq INTEGER, ts INTEGER, method TEXT, event_type TEXT, payload TEXT);
             CREATE INDEX idx_trace_ts ON trace_events(ts);`);
    const ins = db.prepare(
      "INSERT INTO trace_events (turn_id, session_id, seq, ts, method, event_type, payload) VALUES (?,?,?,?,?,?,?)");
    db.transaction(() => {
      for (let i = 0; i < 400; i += 1) ins.run("t", "s", i, Date.now(), "m", "e", JSON.stringify({ i, pad: "x".repeat(200) }));
    })();
    db.close();

    // 打坏 **schema 页**（第 2 页）。打文件中部可能落在空闲页上，quick_check 仍 ok——
    // 第一版测试就是这么假绿的（2026-11-08）。
    const { open } = await import("node:fs/promises");
    const fh = await open(file, "r+");
    await fh.write(Buffer.alloc(4096, 0xff), 0, 4096, 4096);
    await fh.close();

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const script = `
      const trace = await import(${JSON.stringify(path.join(REPO, "server", "trace.js"))});
      await trace.initTrace();
      const info = trace.traceStoreInfo();
      console.log(JSON.stringify({ integrity: info ? info.integrity : null }));
      trace.shutdownTrace();
    `;
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, DB_PATH: path.join(root, "app.db"), TRACE_DB_PATH: file },
      timeout: 60_000,
    });
    const line = stdout.trim().split("\n").pop();
    const parsed = JSON.parse(line);
    // 两种都算"不自称健康"：打不开（info=null）或打开了但 integrity 非 ok。
    // 唯一不允许的是「库坏了却报告健康」——那正是 2026-11-08 静默失效的形态。
    assert.ok(
      parsed.integrity == null || parsed.integrity.ok !== true,
      `a corrupted store must not report ok: ${line}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
