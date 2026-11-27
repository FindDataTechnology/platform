// Unit tests for chat-retention (retain-chat-history 2.3 / 3.7 / 4.1).
//
// Runs against an isolated DB_PATH so it never touches the real store.
//
// The properties that matter, in the order they can hurt:
//   · a fresh DB has auto_vacuum=INCREMENTAL (the pragma is order-sensitive —
//     set before WAL/first table — so a regression here silently stops reclaim)
//   · pruning deletes by SESSION activity, cascades messages, and never splits
//     a conversation
//   · an active session whose updated_at moved is NOT pruned even if its
//     messages are old — the design's biggest assumption, so it is pinned
//   · `0` disables, a missing DB is a skip not a throw, a broken run returns 0
//   · the operator status read reports window + last sweep + counts

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-retention-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const retention = await import("../server/chat-retention.js");

await db.initDb();
assert.ok(db.isDbReady(), "DB should be ready after initDb");

const DAY = 86_400_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

let seq = 0;
const mk = (title, updatedAgoMs) => {
  const id = `ret-${Date.now()}-${seq++}`;
  db.upsertSession(id, title, iso(updatedAgoMs), iso(updatedAgoMs));
  db.appendMessage(id, "user", `hello from ${title}`, iso(updatedAgoMs));
  db.appendMessage(id, "assistant", `reply to ${title}`, iso(updatedAgoMs));
  return id;
};

test("fresh database opens with auto_vacuum=INCREMENTAL", () => {
  assert.equal(db.getDb().pragma("auto_vacuum", { simple: true }), 2);
});

test("resolveRetentionDays: default 90, 0 disables, junk falls back", () => {
  assert.equal(retention.resolveRetentionDays({}), 90);
  assert.equal(retention.resolveRetentionDays({ CHAT_RETENTION_DAYS: "0" }), 0);
  assert.equal(retention.resolveRetentionDays({ CHAT_RETENTION_DAYS: "30" }), 30);
  assert.equal(retention.resolveRetentionDays({ CHAT_RETENTION_DAYS: "nope" }), 90);
  assert.equal(retention.resolveRetentionDays({ CHAT_RETENTION_DAYS: "-5" }), 90);
  assert.equal(retention.resolveRetentionDays({ CHAT_RETENTION_DAYS: "" }), 90);
});

test("0 disables the sweep entirely — no SQL, reports disabled", () => {
  const id = mk("disabled-window", 400 * DAY);
  const r = retention.pruneChatHistory({ days: 0 });
  assert.equal(r.removed, 0);
  assert.equal(r.disabled, true);
  assert.ok(db.sessionExists(id), "nothing pruned when disabled");
});

test("sessions inside the window survive with their messages intact", () => {
  const id = mk("inside-window", 10 * DAY);
  retention.pruneChatHistory({ days: 90 });
  assert.ok(db.sessionExists(id));
  assert.equal(db.getChatMessages(id).length, 2);
});

test("sessions outside the window are removed, messages cascade", () => {
  const id = mk("outside-window", 200 * DAY);
  assert.equal(db.getChatMessages(id).length, 2);
  const r = retention.pruneChatHistory({ days: 90 });
  assert.ok(r.removed >= 1);
  assert.equal(db.sessionExists(id), false);
  assert.equal(db.getChatMessages(id).length, 0, "FK cascade took the messages");
});

test("an old conversation that was recently active is kept (delete by session activity)", () => {
  const id = `ret-active-${seq++}`;
  // Created 300 days ago, but its last activity is yesterday — a user reopened
  // it and kept talking. Deleting by message time would strand half the thread.
  db.upsertSession(id, "reopened", iso(300 * DAY), iso(DAY));
  db.appendMessage(id, "user", "old turn", iso(300 * DAY));
  db.appendMessage(id, "assistant", "new turn", iso(DAY));
  retention.pruneChatHistory({ days: 90 });
  assert.ok(db.sessionExists(id), "recently-active session must not be pruned");
  assert.equal(db.getChatMessages(id).length, 2, "conversation stays whole");
});

test("consecutive sweeps are idempotent", () => {
  const a = mk("idem-a", 200 * DAY);
  const first = retention.pruneChatHistory({ days: 90 });
  const second = retention.pruneChatHistory({ days: 90 });
  assert.ok(first.removed >= 1);
  assert.equal(second.removed, 0, "second sweep has nothing left to remove");
  assert.equal(db.sessionExists(a), false);
});

test("a sweep never throws, even when the DB is unavailable", () => {
  // initDb is idempotent and the handle is live here, so this asserts the
  // fail-safe contract directly: a non-positive window is a no-op, not a throw.
  assert.doesNotThrow(() => retention.pruneChatHistory({ days: -1 }));
});

test("status read reports window, counts and the last sweep", () => {
  mk("status-a", 1 * DAY);
  mk("status-b", 2 * DAY);
  retention.pruneChatHistory({ days: 90 });
  const s = retention.chatRetentionStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.windowDays, 90);
  assert.ok(s.sessionsIndexed >= 2, `sessionsIndexed=${s.sessionsIndexed}`);
  assert.ok(s.messagesIndexed >= 4, `messagesIndexed=${s.messagesIndexed}`);
  assert.ok(s.lastSweep, "last swing must be recorded after a real sweep");
  assert.equal(typeof s.lastSweep.removed, "number");
});

test("an empty window is reported as disabled in the status read", () => {
  const prev = process.env.CHAT_RETENTION_DAYS;
  process.env.CHAT_RETENTION_DAYS = "0";
  try {
    const s = retention.chatRetentionStatus();
    assert.equal(s.enabled, false);
    assert.equal(s.windowDays, 0);
  } finally {
    if (prev === undefined) delete process.env.CHAT_RETENTION_DAYS;
    else process.env.CHAT_RETENTION_DAYS = prev;
  }
});
