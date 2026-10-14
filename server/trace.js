// server/trace.js — full-fidelity dsh notification capture for the /trace viewer.
//
// A tap at the top of handleDshEvent (server/dsh-events.js) feeds every runtime
// notification here; rows land in a DEDICATED SQLite database (`trace.db`,
// beside the session index — never inside it) keyed by turn (the durable
// message id prompt() resolves with). Writes are batched (500ms / 200-row
// flush, forced on turn end) so streaming deltas don't hit SQLite per chunk.
// Everything is failure-isolated: a trace error logs and never breaks the chat
// turn (graceful-degradation convention).
//
// Storage is BOUNDED (openspec: bound-trace-storage). Three properties keep it
// that way, and each one closed a real failure mode:
//   - streaming deltas are not persisted at all — they were 88% of payload
//     bytes when they rode `assistant/chunk`, and the terminal
//     `assistant/message` already carries the full text. The deltas now ride
//     bridge-forwarded `platform/stream` frames (restore-assistant-stream-020;
//     the 0.2.0 session format removed the chunk event) and stay dropped the
//     same way — non-delta frames like `finish` still land, for token usage
//     and stop reason;
//   - pruning runs HOURLY, not only at process start — a hosted cell is
//     long-resident, so a boot-only prune never fired (the 2026-10-10 8GB
//     incident);
//   - the store is created with `auto_vacuum=INCREMENTAL` and vacuumed after
//     each prune, so deleted volume returns to the filesystem instead of
//     sitting in the freelist while the file grows.
// Payloads are stored raw; per-type summaries are derived at read time
// (summarizeEvent) so upstream adding an event type needs no migration.

import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getDb, isDbReady } from "../db.js";
import { storeDir } from "../paths.js";

const FLUSH_MS = 500;
const FLUSH_ROWS = 200;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// Streaming delta chunks: pure incremental text the terminal assistant/message
// already carries in full. Kept out of the store entirely (see header).
const STREAMING_DELTA_CHUNKS = new Set(["text-delta", "reasoning-delta", "tool-call-delta"]);

const TRACE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trace_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    method TEXT NOT NULL,
    event_type TEXT,
    payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trace_turn ON trace_events(turn_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trace_ts ON trace_events(ts)`,
];

let queue = [];
let seqByTurn = new Map();
let flushTimer = null;
let retentionDays = Number(process.env.TRACE_RETENTION_DAYS) || 7;
let traceDb = null;
let traceDbPath = null;
let pruneTimer = null;

function resolveTraceDbPath() {
  if (process.env.TRACE_DB_PATH) return path.resolve(process.env.TRACE_DB_PATH);
  return storeDir("trace.db");
}

export function isTraceReady() {
  return Boolean(traceDb);
}

function insertStmt() {
  return traceDb.prepare(
    `INSERT INTO trace_events (turn_id, session_id, seq, ts, method, event_type, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
}

function flush() {
  flushTimer = null;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try {
    if (!traceDb) return;
    const run = traceDb.transaction((rows) => {
      const stmt = insertStmt();
      for (const r of rows) stmt.run(r.turnId, r.sessionId, r.seq, r.ts, r.method, r.eventType, r.payload);
    });
    run(batch);
  } catch (e) {
    console.warn(`[trace] write failed (dropped ${batch.length} rows): ${e.message}`);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
  flushTimer.unref?.();
}

// The tap. Called for every dsh notification before the WS translation switch.
export function record(notif, { sessionId, turnId }) {
  try {
    if (!isTraceReady() || !notif?.method) return;
    let eventType = notif.params?.event?.type ?? null;
    if (notif.method === "platform/stream") eventType = "platform/stream";
    // Drop streaming deltas before they reach the queue: no row, and no seq
    // consumed for them, so a stored turn's sequence stays gap-free.
    if (eventType === "assistant/chunk") {
      const chunkType = notif.params?.event?.data?.chunk?.type;
      if (STREAMING_DELTA_CHUNKS.has(chunkType)) return;
    }
    // Same drop for the live lane's delta frames (restore-assistant-stream-020):
    // platform/stream carries the frames the chunk event used to; pure
    // incremental text stays out, finish frames (usage/stop reason) land.
    if (notif.method === "platform/stream") {
      if (STREAMING_DELTA_CHUNKS.has(notif.params?.frame?.chunk?.type)) return;
    }
    const t = turnId || "unknown";
    const seq = (seqByTurn.get(t) ?? 0) + 1;
    seqByTurn.set(t, seq);
    queue.push({
      turnId: t,
      sessionId: sessionId || "",
      seq,
      ts: Date.now(),
      method: notif.method,
      eventType,
      payload: JSON.stringify(notif.params ?? {}),
    });
    // Turn end / status changes force a flush so a finished turn is
    // immediately queryable; other chunks ride the timer.
    if (queue.length >= FLUSH_ROWS || eventType === "turn/end" || notif.method === "session.status") flush();
    else scheduleFlush();
  } catch (e) {
    console.warn(`[trace] record failed: ${e.message}`);
  }
}

// Bind the next turn's rows to the id prompt() resolved with. Called by the
// WS prompt handler; cleared implicitly when a new prompt rebinds.
export function bindTurn(turnId) {
  try {
    flush();
    if (turnId) seqByTurn.set(turnId, 0);
  } catch { /* best-effort */ }
}

function openTraceDb() {
  traceDbPath = resolveTraceDbPath();
  mkdirSync(path.dirname(traceDbPath), { recursive: true });
  const db = new Database(traceDbPath);
  // auto_vacuum MUST be set before the first table exists on this file, or it
  // is silently ignored (the pragma only takes effect for a fresh database).
  db.pragma("auto_vacuum = INCREMENTAL");
  db.pragma("journal_mode = WAL");
  for (const sql of TRACE_SCHEMA) db.exec(sql);
  return db;
}

function prune() {
  if (!traceDb) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  try {
    const info = traceDb.prepare(`DELETE FROM trace_events WHERE ts < ?`).run(cutoff);
    if (info.changes) {
      // Hand the freed pages back to the filesystem: with auto_vacuum=OFF the
      // file only ever grew, which is how the 8GB store happened.
      traceDb.pragma("incremental_vacuum");
      console.log(`[trace] pruned ${info.changes} rows older than ${retentionDays}d`);
    }
    return info.changes;
  } catch (e) {
    console.warn(`[trace] prune failed: ${e.message}`);
    return 0;
  }
}

// Move pre-existing trace rows out of the session index database (openspec:
// bound-trace-storage — "Existing trace rows move to the trace database without
// loss"). A pure move, no age filter: bounding is then enforced by the same
// retention policy as new rows. Ids are preserved so a crash mid-move can be
// re-run (INSERT OR IGNORE skips what already landed).
function migrateLegacyTraceRows() {
  if (!traceDb || !isDbReady()) return 0;
  const app = getDb();
  let hasTable = false;
  try {
    hasTable = Boolean(
      app.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trace_events'`).get()
    );
  } catch {
    hasTable = false;
  }
  if (!hasTable) return 0;

  const insert = traceDb.prepare(
    `INSERT OR IGNORE INTO trace_events (id, turn_id, session_id, seq, ts, method, event_type, payload)
     VALUES (@id, @turn_id, @session_id, @seq, @ts, @method, @event_type, @payload)`
  );
  const selectPage = app.prepare(
    `SELECT id, turn_id, session_id, seq, ts, method, event_type, payload
     FROM trace_events WHERE id > ? ORDER BY id LIMIT 5000`
  );
  const readPage = app.transaction((afterId) => selectPage.all(afterId));
  const writePage = traceDb.transaction((rows) => {
    for (const r of rows) insert.run(r);
  });

  let moved = 0;
  let cursor = 0;
  for (;;) {
    const rows = readPage(cursor);
    if (!rows.length) break;
    writePage(rows);
    moved += rows.length;
    cursor = rows[rows.length - 1].id;
  }

  if (moved) {
    app.exec(`DROP TABLE trace_events`);
    // Reclaim the freed pages in the session index. One-time, at the moment the
    // table is retired — not a recurring cost.
    try {
      app.exec(`VACUUM`);
    } catch (e) {
      console.warn(`[trace] post-move VACUUM failed (harmless, space stays until next vacuum): ${e.message}`);
    }
    console.log(`[trace] moved ${moved} legacy trace row(s) out of the session index`);
  }
  return moved;
}

export async function initTrace() {
  // Re-init safe: a second call (tests, or a future hot reload) must not leak
  // the previous handle or leave a stale timer behind.
  if (traceDb) {
    try { traceDb.close(); } catch { /* best-effort */ }
    traceDb = null;
  }
  try {
    traceDb = openTraceDb();
  } catch (e) {
    traceDb = null;
    console.warn(`[trace] disabled: could not open ${traceDbPath || "trace.db"}: ${e.message}`);
    return;
  }
  try {
    migrateLegacyTraceRows();
  } catch (e) {
    // A failed move must not disable tracing: the store is usable regardless,
    // and the next boot retries the move (it is idempotent).
    console.warn(`[trace] legacy move failed (will retry on next boot): ${e.message}`);
  }
  prune();
  if (!pruneTimer) {
    // Hourly, unref'd: a long-resident cell must prune without a restart, and
    // the timer must never hold the process open.
    pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
    pruneTimer.unref?.();
  }
}

export async function shutdownTrace() {
  try { flush(); } catch { /* best-effort */ }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  try {
    traceDb?.close();
  } catch { /* best-effort */ }
  traceDb = null;
}

// Test/ops seam: prune on demand and report the freelist, so the retention and
// reclaim behaviour is assertable without waiting an hour.
export function pruneNow() {
  return prune();
}

export function traceStoreInfo() {
  if (!traceDb) return null;
  const freelist = traceDb.pragma("freelist_count", { simple: true });
  const pageSize = traceDb.pragma("page_size", { simple: true });
  const pageCount = traceDb.pragma("page_count", { simple: true });
  const autoVacuum = traceDb.pragma("auto_vacuum", { simple: true });
  return {
    path: traceDbPath,
    retentionDays,
    freelistCount: freelist,
    autoVacuum,
    sizeBytes: pageSize * pageCount,
    rows: traceDb.prepare(`SELECT COUNT(*) AS n FROM trace_events`).get().n,
  };
}

// ── Read API ─────────────────────────────────────────────────────────────────

export function listTurns({ limit = 50, offset = 0, sessionId } = {}) {
  if (!traceDb) return [];
  const db = traceDb;
  const filter = sessionId ? "WHERE session_id = ?" : "";
  const args = sessionId ? [sessionId] : [];
  const rows = db
    .prepare(
      `SELECT turn_id, session_id,
              MIN(ts) AS started, MAX(ts) AS ended, COUNT(*) AS event_count,
              MAX(CASE WHEN event_type IN ('turn/end') AND payload LIKE '%"kind":"error"%' THEN 1 ELSE 0 END) AS has_error,
              MAX(CASE WHEN event_type = 'request/header' THEN payload ELSE NULL END) AS header_payload
       FROM trace_events ${filter}
       GROUP BY turn_id
       ORDER BY started DESC
       LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset);
  return rows.map((r) => {
    let model = null;
    let provider = null;
    if (r.header_payload) {
      try {
        // payload shape: { event: { type: 'request/header', data: { header: { config: { provider, model } } } } }
        const h = JSON.parse(r.header_payload);
        const cfg = h?.event?.data?.header?.config ?? h?.event?.data ?? h?.data ?? h;
        model = cfg?.model ?? null;
        provider = cfg?.provider ?? null;
      } catch { /* raw fallback */ }
    }
    return {
      turnId: r.turn_id,
      sessionId: r.session_id,
      started: r.started,
      durationMs: r.ended - r.started,
      eventCount: r.event_count,
      hasError: !!r.has_error,
      model,
      provider,
    };
  });
}

// One-line human summary per known event type; raw tag for unknown ones.
export function summarizeEvent(eventType, payload) {
  const d = payload?.event ? payload.event.data ?? {} : payload?.data ?? {};
  switch (eventType) {
    case "turn/start": return "Turn started";
    case "turn/end": {
      const kind = d?.reason?.kind;
      return kind && kind !== "stop" ? `Turn ended (${kind})` : "Turn ended";
    }
    case "user/message": return `User: ${String(d?.content?.[0]?.text ?? d?.text ?? "").slice(0, 120)}`;
    case "platform/stream": {
      // Live-lane frame (restore-assistant-stream-020): deltas never reach
      // here (dropped in record), so this summarizes the kept frames —
      // the finish's stop reason and token usage.
      const c = payload?.frame?.chunk;
      if (c?.type === "finish") return `Finish (${c?.reason?.kind ?? "?"})${c?.usage ? ` tokens=${JSON.stringify(c.usage)}` : ""}`;
      return `Stream frame ${c?.type ?? payload?.frame?.type ?? "?"}`;
    }
    case "assistant/chunk": {
      const c = d?.chunk;
      if (c?.type === "text-delta") return `Text +${(c.text || "").length} chars`;
      if (c?.type === "reasoning-delta") return `Thinking +${(c.text || "").length} chars`;
      if (c?.type === "tool-call-delta") return `Tool-call delta`;
      if (c?.type === "finish") return `Finish (${c?.reason?.kind ?? "?"})${c?.usage ? ` tokens=${JSON.stringify(c.usage)}` : ""}`;
      return `Chunk ${c?.type ?? "?"}`;
    }
    case "assistant/message": {
      const blocks = d?.message?.content;
      const n = Array.isArray(blocks) ? blocks.length : 0;
      const chars = Array.isArray(blocks)
        ? blocks.filter((b) => b?.type === "text").reduce((n2, b) => n2 + (b.text || "").length, 0)
        : 0;
      return `Assistant message (${n} blocks${chars ? `, ${chars} text chars` : ""})`;
    }
    case "tool/call": return `Tool call: ${d?.name} (${(d?.callId ?? "").slice(0, 8)})`;
    case "tool/result": return `Tool result (${(d?.message?.source?.callId ?? "").slice(0, 8)})${d?.error ? " — error" : ""}`;
    case "request/header": {
      const cfg = d?.header?.config ?? d;
      return `Request: ${cfg?.provider ?? "?"}/${cfg?.model ?? "?"}${cfg?.reasoningEffort ? ` effort=${cfg.reasoningEffort}` : ""}`;
    }
    case "request/context": {
      const cfg = d?.config ?? d;
      return `Context: ${cfg?.provider ?? "?"}/${cfg?.model ?? "?"} window=${cfg?.contextWindow ?? "?"}`;
    }
    case "llm/retry": return `LLM retry: ${String(d?.reason ?? d?.error ?? "").slice(0, 80)}`;
    case "llm/retry-started": return "LLM retry started";
    case "step/start": return "Step started";
    case "step/end": return "Step ended";
    case "session/title": return `Title: ${String(d?.title ?? "").slice(0, 80)}`;
    case "session/title-llm-request": return "Title LLM request";
    default: return null; // caller falls back to the raw event type
  }
}

export function getTurn(turnId) {
  if (!traceDb) return null;
  const rows = traceDb
    .prepare(`SELECT seq, ts, method, event_type, payload FROM trace_events WHERE turn_id = ? ORDER BY seq`)
    .all(turnId);
  if (!rows.length) return null;
  return rows.map((r) => {
    let payload = null;
    try { payload = JSON.parse(r.payload); } catch { payload = { raw: r.payload }; }
    return {
      seq: r.seq,
      ts: r.ts,
      method: r.method,
      eventType: r.event_type,
      summary: summarizeEvent(r.event_type, payload) ?? r.event_type ?? r.method,
      payload,
    };
  });
}

// Self-check: synthetic turn through record → flush → read → prune.
// Usage: DB_PATH=/tmp/t.db TRACE_DB_PATH=/tmp/t-trace.db node server/trace.js
if (process.argv[1] && process.argv[1].endsWith("trace.js")) {
  const { initDb } = await import("../db.js");
  await initDb();
  await initTrace();
  bindTurn("selfcheck-1");
  const sid = "s-selfcheck";
  const rec = (type, data) => record({ method: "session.event", params: { event: { type, data } } }, { sessionId: sid, turnId: "selfcheck-1" });
  rec("turn/start", {});
  rec("request/header", { header: { config: { provider: "volces", model: "deepseek-v4-pro" } } });
  // Deltas must not be stored; the finish frame must be (live lane shape —
  // restore-assistant-stream-020: frames ride platform/stream now).
  const recStream = (chunk) => record({ method: "platform/stream", params: { sessionId: sid, frame: { type: "chunk", chunk } } }, { sessionId: sid, turnId: "selfcheck-1" });
  recStream({ type: "text-delta", text: "hello" });
  recStream({ type: "reasoning-delta", text: "thinking" });
  recStream({ type: "finish", reason: { kind: "stop" }, usage: { inputTokens: 1, outputTokens: 2 } } );
  rec("tool/call", { callId: "c1", name: "demo" });
  rec("tool/result", { message: { source: { callId: "c1" }, content: [{ type: "text", text: "ok" }] } });
  record({ method: "session.status", params: { status: "idle" } }, { sessionId: sid, turnId: "selfcheck-1" });
  // Read BEFORE shutting down: shutdownTrace() closes this store's own handle
  // (unlike the pre-bound-trace-storage shape, where the handle belonged to
  // db.js and stayed open), so reads after it would see an empty store.
  const [turn] = listTurns({});
  console.assert(turn?.turnId === "selfcheck-1" && turn.model === "deepseek-v4-pro" && turn.provider === "volces", "listTurns FAILED", JSON.stringify(turn));
  const evs = getTurn("selfcheck-1");
  const hdr = evs.find((e) => e.eventType === "request/header");
  console.assert(hdr?.summary.includes("volces/deepseek-v4-pro"), "header summary FAILED: " + hdr?.summary);
  const events = getTurn("selfcheck-1");
  console.assert(events.length === 6, "event count FAILED (expect 6 stored, 2 deltas dropped): " + events.length);
  console.assert(!events.some((e) => e.summary?.includes("Text +")), "delta leak FAILED");
  console.assert(events.some((e) => e.summary?.includes("Finish")), "finish chunk missing FAILED");
  console.assert(events.some((e) => e.summary.includes("demo")), "summary FAILED");
  console.assert(getTurn("missing") === null, "404 FAILED");
  await shutdownTrace();
  console.log("OK trace self-check");
  process.exit(0);
}
