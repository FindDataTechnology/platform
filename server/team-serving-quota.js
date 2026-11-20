// server/team-serving-quota.js — the hard quota ledger for team calls
// (openspec: add-team-as-a2a-agent, 4.1–4.4).
//
// Three properties, each structural rather than hoped for:
//   • TAKING A SLOT IS ONE CONDITIONAL UPDATE. Ten concurrent calls against a
//     limit of 3 must let exactly 3 through, and a read-then-write pair cannot
//     promise that at any isolation level better-sqlite3 gives us. The UPDATE
//     carries the bound in its WHERE clause, so the database decides the race.
//   • THE CALL RECORD LANDS IN THE SAME TRANSACTION. A call that consumed quota
//     but left no row is the exact state the spec forbids ("不产生已成功但未记账
//     的调用"). If the record insert fails, the whole transaction rolls back and
//     the call is refused.
//   • MONEY IS INTEGER MICRO-USD. `usdPerDay: 5` in floats accumulates 0.30000000004
//     and eventually refuses a call that should have fit.
//
// The counters live next to the publication (the cell's fleet DB), keyed by
// UTC day. UTC, not local time, because the reset instant is published on the
// card and must mean the same thing in Tokyo and in Berlin.

import { randomUUID } from "node:crypto";
import { quotaResetAt } from "./team-serving-policy.js";

// `undelivered` is a real terminal state (add-team-as-a2a-agent 5.3): the work
// finished but the caller never heard about it. Folding it into `incomplete`
// would hide a delivery failure behind a production failure.
export const CALL_STATUSES = Object.freeze(["running", "ok", "failed", "quota_aborted", "incomplete", "undelivered"]);

/** USD → integer micro-dollars (1e-6). Rounds; never truncates a budget away. */
export function usdToMicros(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1_000_000);
}

/** The ledger's day key: UTC calendar day, the same day the reset uses. */
export function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function ensureTeamQuotaTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS team_call_usage (
    cell_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    usd_micros INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (cell_id, handle, day)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS team_calls (
    id TEXT PRIMARY KEY,
    cell_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    caller TEXT NOT NULL,
    day TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error_code TEXT,
    tokens INTEGER NOT NULL DEFAULT 0,
    usd_micros INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_team_calls_day ON team_calls(cell_id, handle, day)`);
}

/** Today's counters (0 when nothing ran yet — absent row ≠ absent limit). */
export function readUsage(db, { cellId, handle, now = Date.now() }) {
  const row = db
    .prepare("SELECT calls, tokens, usd_micros FROM team_call_usage WHERE cell_id = ? AND handle = ? AND day = ?")
    .get(cellId, handle, dayKey(now));
  return { calls: row?.calls ?? 0, tokens: row?.tokens ?? 0, usdMicros: row?.usd_micros ?? 0 };
}

/**
 * Take one call slot + write the call record, atomically.
 *
 * @returns {{ok:true, callId:string} | {ok:false, code:string, detail?:object}}
 */
export function takeCallSlot(db, { cellId, handle, caller, quota, depth = 0, now = Date.now(), callId = randomUUID() }) {
  const day = dayKey(now);
  const callsMax = Number.isFinite(quota?.callsPerDay) ? quota.callsPerDay : Number.MAX_SAFE_INTEGER;
  const tokensMax = Number.isFinite(quota?.tokensPerDay) ? quota.tokensPerDay : Number.MAX_SAFE_INTEGER;
  const usdMax = Number.isFinite(quota?.usdPerDay) ? usdToMicros(quota.usdPerDay) : Number.MAX_SAFE_INTEGER;

  const run = db.transaction(() => {
    // The row must exist before the conditional update can consider it.
    db.prepare(
      `INSERT INTO team_call_usage (cell_id, handle, day, calls, tokens, usd_micros, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, ?)
       ON CONFLICT(cell_id, handle, day) DO NOTHING`,
    ).run(cellId, handle, day, now);

    // One statement, three bounds. `changes === 0` means the database refused —
    // no interleaving window in which two readers both see room.
    const took = db
      .prepare(
        `UPDATE team_call_usage
            SET calls = calls + 1, updated_at = ?
          WHERE cell_id = ? AND handle = ? AND day = ?
            AND calls + 1 <= ? AND tokens < ? AND usd_micros < ?`,
      )
      .run(now, cellId, handle, day, callsMax, tokensMax, usdMax);

    if (took.changes === 0) {
      const row = db
        .prepare("SELECT calls, tokens, usd_micros FROM team_call_usage WHERE cell_id = ? AND handle = ? AND day = ?")
        .get(cellId, handle, day);
      const field =
        (row?.calls ?? 0) + 1 > callsMax ? "calls" : (row?.tokens ?? 0) >= tokensMax ? "tokens" : "usd";
      return { ok: false, code: "quota_exceeded", detail: { field } };
    }

    db.prepare(
      `INSERT INTO team_calls (id, cell_id, handle, caller, day, depth, status, tokens, usd_micros, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', 0, 0, ?)`,
    ).run(callId, cellId, handle, caller, day, depth, now);

    return { ok: true, callId, day };
  });

  try {
    return run();
  } catch {
    // 4.3: a ledger that cannot write must not let the call through. Swallowing
    // this would produce exactly the "succeeded but unrecorded" state the spec
    // forbids.
    return { ok: false, code: "internal_error" };
  }
}

/**
 * Charge tokens/money mid-flight (4.2). Conditional, so a delta cannot push the
 * counter past the bound: the caller learns which field ran out and aborts the
 * stream with an error event, marking the call incomplete.
 */
export function chargeUsage(db, { cellId, handle, callId, tokens = 0, usdMicros = 0, quota, now = Date.now() }) {
  const day = dayKey(now);
  const tokensMax = Number.isFinite(quota?.tokensPerDay) ? quota.tokensPerDay : Number.MAX_SAFE_INTEGER;
  const usdMax = Number.isFinite(quota?.usdPerDay) ? usdToMicros(quota.usdPerDay) : Number.MAX_SAFE_INTEGER;
  try {
    const run = db.transaction(() => {
      const charged = db
        .prepare(
          `UPDATE team_call_usage
              SET tokens = tokens + ?, usd_micros = usd_micros + ?, updated_at = ?
            WHERE cell_id = ? AND handle = ? AND day = ?
              AND tokens + ? <= ? AND usd_micros + ? <= ?`,
        )
        .run(tokens, usdMicros, now, cellId, handle, day, tokens, tokensMax, usdMicros, usdMax);
      if (charged.changes === 0) {
        const row = db
          .prepare("SELECT tokens, usd_micros FROM team_call_usage WHERE cell_id = ? AND handle = ? AND day = ?")
          .get(cellId, handle, day);
        return { ok: false, field: (row?.tokens ?? 0) + tokens > tokensMax ? "tokens" : "usd" };
      }
      db.prepare(
        "UPDATE team_calls SET tokens = tokens + ?, usd_micros = usd_micros + ? WHERE id = ?",
      ).run(tokens, usdMicros, callId);
      return { ok: true };
    });
    return run();
  } catch {
    return { ok: false, field: "ledger_unwritable" };
  }
}

/** Close a call with its terminal status. Unknown ids are a no-op, never a throw. */
export function finishCall(db, { callId, status, errorCode = null, now = Date.now() }) {
  if (!CALL_STATUSES.includes(status)) status = "incomplete";
  try {
    db.prepare("UPDATE team_calls SET status = ?, error_code = ?, finished_at = ? WHERE id = ?").run(
      status,
      errorCode,
      now,
      callId,
    );
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function getCall(db, callId) {
  return db.prepare("SELECT * FROM team_calls WHERE id = ?").get(callId) ?? null;
}

/** The published reset instant — the card and the call response both carry it. */
export function quotaResetAtFor(now = Date.now()) {
  return quotaResetAt(now);
}
