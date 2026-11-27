// Unit tests for session pinning (sidebar-pinned-and-recent, spec delta
// chat-history). Covers the additive migration, the DB setter, and the
// listSessions passthrough — the REST route is a thin dispatch over these.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-pin-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");

await db.initDb();
assert.ok(db.isDbReady());

test("migration adds the pinned_at column", () => {
  const cols = db
    .getDb()
    .prepare("PRAGMA table_info(chat_sessions)")
    .all()
    .map((c) => c.name);
  assert.ok(cols.includes("pinned_at"), "pinned_at column missing");
});

const S1 = "pin-session-" + Date.now();

test("a fresh session is not pinned", async () => {
  chatHistory.recordMessage(S1, "user", "hello");
  const rows = await chatHistory.listSessions();
  const row = rows.find((s) => s.id === S1);
  assert.equal(row.pinnedAt, null);
});

test("pinning sets pinnedAt and the list carries it", async () => {
  assert.equal(chatHistory.setSessionPinned(S1, true), true);
  const rows = await chatHistory.listSessions();
  const row = rows.find((s) => s.id === S1);
  assert.ok(row.pinnedAt, "pinnedAt must be a timestamp after pinning");
});

test("unpinning clears pinnedAt", async () => {
  assert.equal(chatHistory.setSessionPinned(S1, false), true);
  const rows = await chatHistory.listSessions();
  const row = rows.find((s) => s.id === S1);
  assert.equal(row.pinnedAt, null);
});

test("pinning an unknown id reports false (route answers 404)", () => {
  assert.equal(chatHistory.setSessionPinned("no-such-session", true), false);
});

test("the live-session list row carries pinnedAt", async () => {
  // ensureSessionInList reconstructs a filtered-out viewed session through
  // getSessionMeta; that path must not lose the pin.
  chatHistory.setSessionPinned(S1, true);
  const rows = await chatHistory.listSessions();
  const seeded = rows.filter((s) => s.id !== S1);
  const ensured = chatHistory.ensureSessionInList(seeded, S1, undefined);
  const row = ensured.find((s) => s.id === S1);
  assert.ok(row?.pinnedAt, "the reconstructed live row lost pinnedAt");
});
