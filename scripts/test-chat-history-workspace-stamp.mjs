// Unit tests for the session workspace stamp (add-sidebar-workspaces).
//
// Spec contract (specs/chat-history delta): the mirror stamps the runtime
// workspace on a session when its first turn is mirrored and never changes
// it afterwards, even when the workspace source flips mid-conversation.
// Also covers the additive migration (v10) on a fresh DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-workspace-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");

await db.initDb();
assert.ok(db.isDbReady());

// Migration landed: the column exists on a fresh database.
test("migration v10 adds the workspace column", () => {
  const cols = db
    .getDb()
    .prepare("PRAGMA table_info(chat_sessions)")
    .all()
    .map((c) => c.name);
  assert.ok(cols.includes("workspace"), "workspace column missing");
});

// The workspace source is a getter (server.js wires it to the live runtime
// workspace); simulate a switch by mutating this variable between turns.
let liveWorkspace = "/home/me/project-a";
chatHistory.setWorkspaceSource(() => liveWorkspace);

const S1 = "ws-session-" + Date.now();

test("first turn stamps the current workspace", () => {
  chatHistory.recordMessage(S1, "user", "hello from project a");
  const meta = db.getSessionMeta(S1);
  assert.equal(meta.workspace, "/home/me/project-a");
});

test("a workspace switch does not re-stamp the session", () => {
  liveWorkspace = "/home/me/project-b";
  chatHistory.recordMessage(S1, "assistant", "second turn, new workspace");
  const meta = db.getSessionMeta(S1);
  assert.equal(meta.workspace, "/home/me/project-a", "stamp must stay the creation value");
});

test("sessions created after the switch stamp the new workspace", () => {
  const S2 = S1 + "-b";
  chatHistory.recordMessage(S2, "user", "hello from project b");
  const meta = db.getSessionMeta(S2);
  assert.equal(meta.workspace, "/home/me/project-b");
});

test("listSessions exposes the workspace field", async () => {
  const sessions = await chatHistory.listSessions();
  const a = sessions.find((s) => s.id === S1);
  assert.equal(a.workspace, "/home/me/project-a");
  const b = sessions.find((s) => s.id === S1 + "-b");
  assert.equal(b.workspace, "/home/me/project-b");
});

test("a null source leaves the stamp blank (legacy/Ungrouped behavior)", () => {
  chatHistory.setWorkspaceSource(null);
  const S3 = S1 + "-c";
  chatHistory.recordMessage(S3, "user", "no workspace source");
  const meta = db.getSessionMeta(S3);
  assert.equal(meta.workspace, null);
});
