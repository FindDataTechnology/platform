// Unit tests for chat-history.deleteSession (ui-nav-restructure change A).
//
// Exercises the three contract scenarios from tasks.md 7.7:
//   - happy path: deletes the SQLite row, calls the dsh bridge, returns ok
//   - current-session rejection: throws DeleteSessionError("active", ...)
//   - missing id: throws DeleteSessionError("not_found", ...)
//
// Runs against an isolated DB_PATH under os.tmpdir() and a stub dsh bridge so
// the test never touches the real agent runtime or the user's session store.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-delete-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");

// Stub session manager + dsh bridge. The chat-history module only consults
// sm.getSessionId() for the "active" check; everything else is a stub.
const stubBridge = {
  calls: [],
  async deleteSession(id) { this.calls.push(id); return true; },
};
chatHistory.setDshBridge(stubBridge);

// Track which session id the live agent "thinks" is current.
let activeId = null;
chatHistory.setSessionManager({ getSessionId: () => activeId });

await db.initDb();
assert.ok(db.isDbReady(), "DB should be ready after initDb");

const S1 = "s-" + Date.now() + "-a";
const S2 = "s-" + Date.now() + "-b";
const S3 = "s-" + Date.now() + "-c";

const now = new Date().toISOString();
db.upsertSession(S1, "first", now, now);
db.upsertSession(S2, "second", now, now);
db.upsertSession(S3, "third", now, now);
db.appendMessage(S1, "user", "hello", now);
db.appendMessage(S2, "user", "world", now);

test("happy path: removes the SQLite row + messages (FK cascade) and calls dshBridge", async () => {
  activeId = S1;
  assert.ok(db.sessionExists(S2));
  await chatHistory.deleteSession(S2);
  assert.equal(db.sessionExists(S2), false, "row should be removed");
  // FK CASCADE clears messages for the deleted session.
  const msgs = db.getChatMessages(S2);
  assert.equal(msgs.length, 0, "messages for deleted session should be gone");
  // dsh bridge was called.
  assert.deepEqual(stubBridge.calls, [S2]);
});

test("rejects the active session with code 'active'", async () => {
  activeId = S1;
  await assert.rejects(
    () => chatHistory.deleteSession(S1),
    (err) => err.code === "active" && err instanceof chatHistory.DeleteSessionError,
  );
  // Row still present.
  assert.ok(db.sessionExists(S1));
});

test("missing id throws DeleteSessionError('not_found')", async () => {
  activeId = S1;
  await assert.rejects(
    () => chatHistory.deleteSession("nope-" + Date.now()),
    (err) => err.code === "not_found" && err instanceof chatHistory.DeleteSessionError,
  );
});

test("missing id (empty string) throws DeleteSessionError('not_found')", async () => {
  activeId = S1;
  await assert.rejects(
    () => chatHistory.deleteSession(""),
    (err) => err.code === "not_found",
  );
});

test("after the active session is no longer current, it can be deleted", async () => {
  activeId = S3; // switch
  assert.ok(db.sessionExists(S1));
  await chatHistory.deleteSession(S1);
  assert.equal(db.sessionExists(S1), false);
  assert.deepEqual(stubBridge.calls, [S2, S1]);
});

test("serializes concurrent deletes against the same id (only one row removed)", async () => {
  activeId = S3;
  const target = "s-" + Date.now() + "-d";
  db.upsertSession(target, "race", now, now);
  // Fire two deletes at once; the second one should observe not_found because
  // the first removed the row before the second re-checked.
  const results = await Promise.allSettled([chatHistory.deleteSession(target), chatHistory.deleteSession(target)]);
  const fulfilled = results.filter((r) => r.status === "fulfilled").length;
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled, 1, "exactly one delete should win");
  assert.equal(rejected.length, 1, "exactly one delete should fail");
  assert.equal(rejected[0].reason.code, "not_found", "loser sees not_found");
  assert.equal(db.sessionExists(target), false);
});
