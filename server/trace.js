// server/trace.js — full-fidelity dsh notification capture for the /trace viewer.
//
// A tap at the top of handleDshEvent (server/dsh-events.js) feeds every runtime
// notification here; rows land in the SQLite `trace_events` table keyed by turn
// (the durable message id prompt() resolves with). Writes are batched (500ms /
// 200-row flush, forced on turn end) so streaming deltas don't hit SQLite per
// chunk. Everything is failure-isolated: a trace error logs and never breaks
// the chat turn (graceful-degradation convention).
//
// Payloads are stored raw; per-type summaries are derived at read time
// (summarizeEvent) so upstream adding an event type needs no migration.

import { getDb, isDbReady } from "../db.js";

const FLUSH_MS = 500;
const FLUSH_ROWS = 200;

let queue = [];
let seqByTurn = new Map();
let flushTimer = null;
let retentionDays = Number(process.env.TRACE_RETENTION_DAYS) || 14;

const insertStmt = () =>
  getDb().prepare(
    `INSERT INTO trace_events (turn_id, session_id, seq, ts, method, event_type, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

function flush() {
  flushTimer = null;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try {
    const run = getDb().transaction((rows) => {
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
    if (!isDbReady() || !notif?.method) return;
    const t = turnId || "unknown";
    const seq = (seqByTurn.get(t) ?? 0) + 1;
    seqByTurn.set(t, seq);
    queue.push({
      turnId: t,
      sessionId: sessionId || "",
      seq,
      ts: Date.now(),
      method: notif.method,
      eventType: notif.params?.event?.type ?? null,
      payload: JSON.stringify(notif.params ?? {}),
    });
    // Turn end / status changes force a flush so a finished turn is
    // immediately queryable; deltas ride the timer.
    if (queue.length >= FLUSH_ROWS || notif.params?.event?.type === "turn/end" || notif.method === "session.status") flush();
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

export async function initTrace() {
  if (!isDbReady()) {
    console.warn("[trace] disabled: database not ready");
    return;
  }
  try {
    const db = getDb();
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const info = db.prepare(`DELETE FROM trace_events WHERE ts < ?`).run(cutoff);
    if (info.changes) console.log(`[trace] pruned ${info.changes} rows older than ${retentionDays}d`);
  } catch (e) {
    console.warn(`[trace] init failed: ${e.message}`);
  }
}

export async function shutdownTrace() {
  try { flush(); } catch { /* best-effort */ }
}

// ── Read API ─────────────────────────────────────────────────────────────────

export function listTurns({ limit = 50, offset = 0, sessionId } = {}) {
  if (!isDbReady()) return [];
  const db = getDb();
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
      return `Assistant message (${n} blocks)`;
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
  if (!isDbReady()) return null;
  const rows = getDb()
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
// Usage: DB_PATH=/tmp/t.db node server/trace.js
if (process.argv[1] && process.argv[1].endsWith("trace.js")) {
  const { initDb } = await import("../db.js");
  await initDb();
  await initTrace();
  bindTurn("selfcheck-1");
  const sid = "s-selfcheck";
  const rec = (type, data) => record({ method: "session.event", params: { event: { type, data } } }, { sessionId: sid, turnId: "selfcheck-1" });
  rec("turn/start", {});
  rec("request/header", { header: { config: { provider: "volces", model: "deepseek-v4-pro" } } });
  rec("tool/call", { callId: "c1", name: "demo" });
  rec("tool/result", { message: { source: { callId: "c1" }, content: [{ type: "text", text: "ok" }] } });
  record({ method: "session.status", params: { status: "idle" } }, { sessionId: sid, turnId: "selfcheck-1" });
  await shutdownTrace();
  const [turn] = listTurns({});
  console.assert(turn?.turnId === "selfcheck-1" && turn.model === "deepseek-v4-pro" && turn.provider === "volces", "listTurns FAILED", JSON.stringify(turn));
  const evs = getTurn("selfcheck-1");
  const hdr = evs.find((e) => e.eventType === "request/header");
  console.assert(hdr?.summary.includes("volces/deepseek-v4-pro"), "header summary FAILED: " + hdr?.summary);
  const events = getTurn("selfcheck-1");
  console.assert(events.length === 5, "event count FAILED: " + events.length);
  console.assert(events.some((e) => e.summary.includes("demo")), "summary FAILED");
  console.assert(getTurn("missing") === null, "404 FAILED");
  getDb().prepare(`INSERT INTO trace_events (turn_id, session_id, seq, ts, method, event_type, payload) VALUES ('old','s',1,?, 'session.event','x','{}')`).run(Date.now() - (retentionDays + 1) * 86400000);
  await initTrace();
  console.assert(getTurn("old") === null, "retention FAILED");
  console.log("OK trace self-check");
  process.exit(0);
}
