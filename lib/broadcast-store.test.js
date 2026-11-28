// Tests for the broadcast ledger + notification store
// (add-broadcast-and-notification-inbox 1.4).
//
// Pins the properties that make partial delivery honest and pull safe:
//   · seq is monotonic (a cursor over timestamps would skew across 65 nodes);
//   · re-reading the same broadcast inserts nothing (restart-safe pull);
//   · one recipient's failure never aborts the other 49;
//   · delivery counts come from RECEIPTS and survive a retry.
import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createBroadcastLedger, createNotificationStore, BROADCAST_LEDGER_DDL } from "./broadcast-store.js";

function ledgerDb() {
  const db = new Database(":memory:");
  db.exec(BROADCAST_LEDGER_DDL);
  return db;
}

function notifDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE notifications (id TEXT PRIMARY KEY, broadcast_id TEXT, recipient_kind TEXT NOT NULL,
    recipient_id TEXT NOT NULL, source TEXT NOT NULL, ref_json TEXT, action_json TEXT,
    title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'unread',
    created_at TEXT NOT NULL, acted_at TEXT, acted_by TEXT)`);
  db.exec(`CREATE UNIQUE INDEX idx_nb ON notifications(broadcast_id, recipient_id) WHERE broadcast_id IS NOT NULL`);
  return db;
}

function ids(prefix = "id") {
  let n = 0;
  return () => `${prefix}${++n}`;
}

test("ledger: seq is monotonic across broadcasts", () => {
  const l = createBroadcastLedger({ db: ledgerDb(), now: () => "2026-11-24T00:00:00Z", newId: ids() });
  const a = l.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 3 });
  const b = l.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 3 });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
});

test("ledger: counters start at zero — a send is not a delivery", () => {
  const l = createBroadcastLedger({ db: ledgerDb(), newId: ids() });
  const b = l.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 50 });
  const view = l.getById(b.id);
  assert.equal(view.hitCount, 50);
  assert.equal(view.okCount, 0, "nothing is delivered until a node reports it");
  assert.equal(view.failCount, 0);
});

test("ledger: receipts accumulate across cells, and a retry replaces not adds", () => {
  const l = createBroadcastLedger({ db: ledgerDb(), now: () => "t", newId: ids() });
  const b = l.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 5 });
  l.recordReceipt({ broadcastId: b.id, cellId: "c1", ok: 2, fail: 0 });
  l.recordReceipt({ broadcastId: b.id, cellId: "c2", ok: 3, fail: 0 });
  assert.deepEqual([l.getById(b.id).okCount, l.getById(b.id).failCount], [5, 0]);
  // c1 retries with the same numbers: totals must not double.
  l.recordReceipt({ broadcastId: b.id, cellId: "c1", ok: 2, fail: 0 });
  assert.equal(l.getById(b.id).okCount, 5);
});

test("ledger: a receipt for an unknown broadcast is refused, not silently written", () => {
  const l = createBroadcastLedger({ db: ledgerDb(), newId: ids() });
  assert.equal(l.recordReceipt({ broadcastId: "nope", cellId: "c1", ok: 1, fail: 0 }).applied, false);
});

test("ledger: pendingSince returns only newer rows, in order, recipients included", () => {
  const l = createBroadcastLedger({ db: ledgerDb(), newId: ids() });
  const a = l.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 1, recipients: ["u1@x"] });
  const b = l.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 1, recipients: ["u2@x"] });
  assert.deepEqual(l.pendingSince(0)[0].recipients, ["u1@x"], "a node receives the resolved list, never the selector");
  assert.deepEqual(l.pendingSince(0).map((r) => r.seq), [a.seq, b.seq]);
  assert.deepEqual(l.pendingSince(a.seq).map((r) => r.seq), [b.seq]);
});

test("notifications: re-delivering the same broadcast inserts nothing", () => {
  const s = createNotificationStore({ db: notifDb(), newId: ids("n") });
  const args = { broadcastId: "b1", recipients: ["u1@x", "u2@x"], title: "t", body: "b" };
  assert.equal(s.deliverToRecipients(args).ok, 2);
  s.deliverToRecipients(args);
  assert.equal(s.listFor({ recipientKind: "user", recipientId: "u1@x" }).length, 1);
});

test("notifications: one recipient failing never aborts the rest", () => {
  const s = createNotificationStore({ db: notifDb(), newId: ids("n") });
  const r = s.deliverToRecipients({ broadcastId: "b1", recipients: ["u1@x", null, "u2@x"] });
  assert.equal(r.ok, 2);
  assert.equal(r.fail, 1);
  assert.equal(r.failures[0].recipientId, null);
});

test("notifications: recipients are scoped — another recipient's rows never leak", () => {
  const s = createNotificationStore({ db: notifDb(), newId: ids("n") });
  s.deliverToRecipients({ broadcastId: "b1", recipients: ["u1@x"] });
  s.deliverToRecipients({ broadcastId: "b2", recipients: ["u2@x"] });
  assert.equal(s.listFor({ recipientKind: "user", recipientId: "u1@x" }).length, 1);
  assert.equal(s.unreadCount({ recipientKind: "user", recipientId: "u1@x" }), 1);
  assert.equal(s.unreadCount({ recipientKind: "user", recipientId: "u2@x" }), 1);
});

test("notifications: unread is derived from state and cleared by read/acted", () => {
  const s = createNotificationStore({ db: notifDb(), newId: ids("n") });
  const r = s.deliverToRecipients({ broadcastId: "b1", recipients: ["u1@x"] });
  assert.equal(r.ok, 1);
  const [n] = s.listFor({ recipientKind: "user", recipientId: "u1@x" });
  assert.equal(s.unreadCount({ recipientKind: "user", recipientId: "u1@x" }), 1);
  assert.equal(s.markRead({ id: n.id }), true);
  assert.equal(s.unreadCount({ recipientKind: "user", recipientId: "u1@x" }), 0);
  // acted is a distinct terminal state, not a synonym for read.
  assert.equal(s.markActed({ id: n.id, actedBy: "u1@x" }), true);
  assert.equal(s.getById(n.id).state, "acted");
  assert.equal(s.getById(n.id).actedBy, "u1@x");
});

// ── Cursor monotonicity under deletion (found live 2026-11-24) ────────────────
//
// A cell's cursor is "the last seq I consumed". If seq comes from MAX(seq),
// clearing the ledger restarts numbering at 1, and every cell already past 1
// skips the next broadcast FOREVER with nothing reporting it. That is exactly
// what acceptance hit: ledger cleared → seq restarted at 1 → the next broadcast
// never reached a cell whose cursor was 1.
test("ledger: clearing the ledger must NOT restart seq (a cursor would skip everything)", () => {
  const db = ledgerDb();
  const l = createBroadcastLedger({ db, newId: ids() });
  const a = l.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 1 });
  const b = l.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 1 });
  assert.deepEqual([a.seq, b.seq], [1, 2]);

  db.prepare("DELETE FROM broadcasts").run(); // retention cleanup / manual prune / rollback
  db.prepare("DELETE FROM broadcast_receipts").run();

  const c = l.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 1 });
  assert.equal(c.seq, 3, "seq must keep counting up — never restart at 1");
  assert.deepEqual(l.pendingSince(2).map((r) => r.id), [c.id], "a cell holding cursor 2 still receives it");
});

test("ledger: seq survives a process restart (the counter is durable, not in memory)", () => {
  const db = ledgerDb();
  createBroadcastLedger({ db, newId: ids() }).recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 1 });
  const again = createBroadcastLedger({ db, newId: ids("n") });
  assert.equal(again.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 1 }).seq, 2);
});

test("ledger: a ledger written before the counter adopts its high-water mark", () => {
  const db = ledgerDb();
  db.exec("DROP TABLE broadcast_seq"); // a pre-counter ledger
  db.prepare(
    `INSERT INTO broadcasts (id, seq, actor, audience_json, title, body, created_at) VALUES ('old', 7, 'a@x', '{}', '', '', 't')`,
  ).run();
  const l = createBroadcastLedger({ db, newId: ids() });
  assert.equal(l.recordBroadcast({ actor: "a@x", audience: { kind: "all" }, hitCount: 1 }).seq, 8);
});
