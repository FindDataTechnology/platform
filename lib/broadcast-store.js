// ── Broadcast ledger + notification store (add-broadcast-and-notification-inbox 1.4) ─
//
// Two stores, in two processes, because they answer questions about two
// different things and live where those things live:
//
//   createBroadcastLedger    the CENTER (gateway, <DATA_ROOT>/broadcasts.db)
//                            an ACTION: who sent what to whom, and — once each
//                            cell reports back — how delivery actually went
//   createNotificationStore  each NODE (cell, its own app.db)
//                            a TODO: what this recipient has not dealt with
//
// Keeping them in one handle would require a single process to hold both, and
// under the pull model (design D3) no such process exists: the center is
// stateless about nodes and every node keeps its own table.
//
// Delivery counts are MEASURED, not assumed. With pull, only the cell knows
// whether a given recipient's row was written, so `ok_count`/`fail_count` start
// at 0 and grow from per-cell receipts. Reporting `ok = hit` at send time would
// be the kind of green that hides a broken node for weeks.
//
// The center never stores the message body for audit — `body` rides the
// broadcast row so nodes can render it, and that row is the delivery source of
// truth, not an audit log.

/**
 * @param {object} deps
 * @param {object} deps.db            better-sqlite3 handle on the center's db
 * @param {() => string} [deps.now]   injectable clock (tests)
 * @param {() => string} [deps.newId] injectable id factory (tests)
 */
export function createBroadcastLedger({ db, now = () => new Date().toISOString(), newId = randomId }) {
  // The cursor every cell holds must be MONOTONIC FOREVER — it is not "the
  // highest seq currently in the table". Deriving seq from MAX(seq) makes a
  // deletion (retention cleanup, a manual prune, a rollback) restart numbering
  // at 1, and every cell whose cursor is already past 1 then skips the new
  // broadcast permanently and silently. Found live 2026-11-24 during
  // acceptance: the ledger was cleared, seq restarted at 1, and the next
  // broadcast never reached a cell whose cursor was already 1.
  //
  // So the allocator is a dedicated counter that only ever moves forward. It is
  // seeded once from the highest existing seq, so a pre-existing ledger keeps
  // counting up rather than jumping back.
  const seedSeq = () => db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM broadcasts").get()?.s ?? 0;
  db.exec("CREATE TABLE IF NOT EXISTS broadcast_seq (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL DEFAULT 0)");
  db.prepare("INSERT OR IGNORE INTO broadcast_seq (id, last) VALUES (1, ?)").run(seedSeq());
  // A ledger written before this counter existed may already hold rows above
  // the counter (a migration, a restore); lift it forward once instead of
  // trusting the stored number.
  db.prepare("UPDATE broadcast_seq SET last = (SELECT COALESCE(MAX(seq), 0) FROM broadcasts) WHERE last < (SELECT COALESCE(MAX(seq), 0) FROM broadcasts)").run();
  const nextSeq = () => db.prepare("UPDATE broadcast_seq SET last = last + 1 WHERE id = 1 RETURNING last").get().last;

  /**
   * Phase 1: record the broadcast. The hit count is decided by the CALLER (it
   * already resolved the audience); this records, it does not decide.
   */
  function recordBroadcast({ actor, audience, title = "", body = "", hitCount, recipients = [], wake = "none" }) {
    const id = newId();
    const seq = nextSeq();
    db.prepare(
      `INSERT INTO broadcasts
         (id, seq, actor, audience_json, recipients_json, title, body, hit_count, ok_count, fail_count, wake, wake_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?)`,
    ).run(
      id,
      seq,
      actor,
      JSON.stringify(audience ?? {}),
      JSON.stringify(recipients ?? []),
      title,
      body,
      hitCount,
      wake,
      now(),
    );
    return { id, seq, actor, audience, title, body, hitCount, recipients, wake };
  }

  /**
   * Phase 2 (per node): one delivery report. Idempotent per (broadcast, cell) —
   * a node that retries after a network blip replaces its own report instead of
   * double-counting, so the totals stay meaningful.
   *
   * Totals are recomputed from receipts rather than incremented, for the same
   * reason: an increment cannot survive a retry.
   */
  function recordReceipt({ broadcastId, cellId, ok, fail }) {
    if (!broadcastId || !cellId) throw new Error("recordReceipt requires broadcastId and cellId");
    const exists = db.prepare("SELECT 1 AS x FROM broadcasts WHERE id = ?").get(broadcastId);
    if (!exists) return { applied: false, reason: "unknown-broadcast" };
    db.prepare(
      `INSERT INTO broadcast_receipts (broadcast_id, cell_id, ok_count, fail_count, reported_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(broadcast_id, cell_id)
       DO UPDATE SET ok_count = excluded.ok_count, fail_count = excluded.fail_count, reported_at = excluded.reported_at`,
    ).run(broadcastId, cellId, Number(ok) || 0, Number(fail) || 0, now());
    const sums = db
      .prepare(
        "SELECT COALESCE(SUM(ok_count), 0) AS ok, COALESCE(SUM(fail_count), 0) AS fail FROM broadcast_receipts WHERE broadcast_id = ?",
      )
      .get(broadcastId);
    db.prepare("UPDATE broadcasts SET ok_count = ?, fail_count = ? WHERE id = ?").run(sums.ok, sums.fail, broadcastId);
    return { applied: true, okCount: sums.ok, failCount: sums.fail };
  }

  /** Read broadcasts newer than a cursor — the pull path. */
  function pendingSince(seq, limit = 50) {
    return db
      .prepare(
        `SELECT id, seq, actor, audience_json, recipients_json, title, body, hit_count, wake, created_at
           FROM broadcasts WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(Number(seq) || 0, limit)
      .map((row) => ({
        id: row.id,
        seq: row.seq,
        actor: row.actor,
        audience: safeParse(row.audience_json) ?? {},
        recipients: safeParse(row.recipients_json) ?? [],
        title: row.title,
        body: row.body,
        hitCount: row.hit_count,
        wake: row.wake,
        createdAt: row.created_at,
      }));
  }

  /** One broadcast's current view, counters included. */
  function getById(id) {
    const row = db
      .prepare(
        `SELECT id, seq, actor, audience_json, title, body, hit_count, ok_count, fail_count, wake, wake_count, created_at
           FROM broadcasts WHERE id = ?`,
      )
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      seq: row.seq,
      actor: row.actor,
      audience: safeParse(row.audience_json) ?? {},
      title: row.title,
      hitCount: row.hit_count,
      okCount: row.ok_count,
      failCount: row.fail_count,
      wake: row.wake,
      wakeCount: row.wake_count,
      createdAt: row.created_at,
    };
  }

  return { recordBroadcast, recordReceipt, pendingSince, getById };
}

/**
 * @param {object} deps
 * @param {object} deps.db            the cell database handle (better-sqlite3)
 * @param {() => string} [deps.now]   injectable clock (tests)
 * @param {() => string} [deps.newId] injectable id factory (tests)
 */
export function createNotificationStore({ db, now = () => new Date().toISOString(), newId = randomId }) {
  /**
   * Write one notification per recipient. Idempotent by the unique
   * (broadcast_id, recipient_id) index — a cell re-reading the same broadcast
   * after a restart inserts nothing the second time.
   *
   * Returns { ok, fail, failures }. A per-recipient failure never aborts the rest.
   */
  function deliverToRecipients({
    broadcastId,
    recipients,
    recipientKind = "user",
    source = "broadcast",
    title = "",
    body = "",
    ref = null,
    action = null,
  }) {
    let ok = 0;
    const failures = [];
    const insert = db.prepare(
      `INSERT OR IGNORE INTO notifications
         (id, broadcast_id, recipient_kind, recipient_id, source, ref_json, action_json, title, body, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?)`,
    );
    for (const recipientId of recipients) {
      // Refuse a non-addressable recipient BEFORE the insert: `String(null)` is
      // the literal "null", which would insert fine and become a notification
      // nobody can ever read (found by the per-recipient failure test). Bad
      // input is a failure of that recipient, not a silent success.
      if (typeof recipientId !== "string" || !recipientId.trim()) {
        failures.push({ recipientId, error: "recipient id must be a non-empty string" });
        continue;
      }
      try {
        insert.run(
          newId(),
          broadcastId,
          recipientKind,
          recipientId,
          source,
          ref ? JSON.stringify(ref) : null,
          action ? JSON.stringify(action) : null,
          title,
          body,
          now(),
        );
        ok += 1;
      } catch (err) {
        // Contain per-recipient failure: the other 49 people still get theirs.
        failures.push({ recipientId, error: err?.message ?? String(err) });
      }
    }
    return { ok, fail: failures.length, failures };
  }

  /** A recipient's notifications, newest first. */
  function listFor({ recipientKind, recipientId, state = null, limit = 100 }) {
    const rows = state
      ? db
          .prepare(
            `SELECT * FROM notifications WHERE recipient_kind = ? AND recipient_id = ? AND state = ?
               ORDER BY created_at DESC LIMIT ?`,
          )
          .all(recipientKind, String(recipientId), state, limit)
      : db
          .prepare(
            `SELECT * FROM notifications WHERE recipient_kind = ? AND recipient_id = ?
               ORDER BY created_at DESC LIMIT ?`,
          )
          .all(recipientKind, String(recipientId), limit);
    return rows.map(shapeNotification);
  }

  /** Count unread — the inbox badge reads this, never a stored counter. */
  function unreadCount({ recipientKind, recipientId }) {
    const row = db
      .prepare(
        "SELECT count(*) AS c FROM notifications WHERE recipient_kind = ? AND recipient_id = ? AND state = 'unread'",
      )
      .get(recipientKind, String(recipientId));
    return row?.c ?? 0;
  }

  function markActed({ id, actedBy }) {
    const r = db
      .prepare("UPDATE notifications SET state = 'acted', acted_at = ?, acted_by = ? WHERE id = ? AND state <> 'acted'")
      .run(now(), actedBy ?? null, id);
    return r.changes > 0;
  }

  function markRead({ id }) {
    const r = db.prepare("UPDATE notifications SET state = 'read' WHERE id = ? AND state = 'unread'").run(id);
    return r.changes > 0;
  }

  function getById(id) {
    const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(id);
    return row ? shapeNotification(row) : null;
  }

  return { deliverToRecipients, listFor, unreadCount, markActed, markRead, getById };
}

export function shapeNotification(row) {
  return {
    id: row.id,
    broadcastId: row.broadcast_id ?? null,
    recipientKind: row.recipient_kind,
    recipientId: row.recipient_id,
    source: row.source,
    ref: row.ref_json ? safeParse(row.ref_json) : null,
    action: row.action_json ? safeParse(row.action_json) : null,
    title: row.title,
    body: row.body,
    state: row.state,
    createdAt: row.created_at,
    actedAt: row.acted_at ?? null,
    actedBy: row.acted_by ?? null,
  };
}

/** Both schemas, so a caller cannot create one without the other. */
export const BROADCAST_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS broadcast_seq (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS broadcasts (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  actor TEXT NOT NULL,
  audience_json TEXT NOT NULL,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  hit_count INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  wake TEXT NOT NULL DEFAULT 'none',
  wake_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcasts_seq ON broadcasts(seq);
CREATE TABLE IF NOT EXISTS broadcast_receipts (
  broadcast_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  ok_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  reported_at TEXT NOT NULL,
  PRIMARY KEY (broadcast_id, cell_id)
);
`;

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function randomId() {
  return `bc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
