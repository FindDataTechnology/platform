// Unit tests for session ownership (add-session-ownership). Covers the
// scenarios the specs call out, against a real temp SQLite + stub ctx/bridges:
//   - owner stamped from the recording user, never re-stamped
//   - listSessions scoping: owner scope, admin includeAll, auth-off unscoped
//   - accessSession: auth-off all-pass; auth-on owner-or-admin; NULL rows
//     admin-only; live unrowed current session allowed
//   - per-viewer delivery: two mock sockets viewing different sessions
//     receive disjoint turn events; sessions events are per-connection scoped
//   - beginTurnFor attribution is covered by the e2e (needs the real WS stack)
//
// Run: node --test scripts/test-session-ownership.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-ownership-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");
const { createAppContext } = await import("../server/context.js");

await db.initDb();

// A minimal session-manager shim so chat-history's current-session plumbing
// works; tests steer it directly.
let currentId = "platform-test-current";
chatHistory.setSessionManager({
  getSessionId: () => currentId,
  getSessionFile: () => null,
  buildSessionContext: () => ({ messages: [] }),
  newSession: () => { currentId = "platform-" + crypto.randomUUID(); },
  setSessionId: (id) => { currentId = id; },
  setSessionFile: () => {},
});
chatHistory.setPresetSource(() => "standard");
chatHistory.setWorkspaceSource(() => null);

// ── Stamping ────────────────────────────────────────────────────────────────

test("owner is stamped from the recording user and never re-stamped", () => {
  chatHistory.recordMessage("s-alice", "user", "hello from alice", undefined, "alice@example.com");
  assert.equal(db.getSessionMeta("s-alice").owner, "alice@example.com");
  // A cron/bot/foreign continuation must not re-stamp.
  chatHistory.recordMessage("s-alice", "assistant", "reply", undefined, "bob@example.com");
  chatHistory.recordMessage("s-alice", "user", "again", undefined, null);
  assert.equal(db.getSessionMeta("s-alice").owner, "alice@example.com");
});

test("no owner user leaves the row ownerless (auth-off)", () => {
  chatHistory.recordMessage("s-anon", "user", "no identity", undefined, null);
  assert.equal(db.getSessionMeta("s-anon").owner, null);
});

test("backfillSessionOwners claims only the ownerless remainder, idempotently", () => {
  assert.equal(db.backfillSessionOwners("legacy@example.com"), 1); // s-anon
  assert.equal(db.getSessionMeta("s-anon").owner, "legacy@example.com");
  assert.equal(db.getSessionMeta("s-alice").owner, "alice@example.com"); // untouched
  assert.equal(db.backfillSessionOwners("legacy@example.com"), 0); // idempotent
});

// ── Scoping ─────────────────────────────────────────────────────────────────

test("listSessions scopes by owner; includeAll sees everything", async () => {
  chatHistory.recordMessage("s-bob", "user", "bob's chat", undefined, "bob@example.com");
  const alice = (await chatHistory.listSessions({ owner: "alice@example.com" })).map((s) => s.id);
  const bob = (await chatHistory.listSessions({ owner: "bob@example.com" })).map((s) => s.id);
  const admin = (await chatHistory.listSessions({ includeAll: true })).map((s) => s.id);
  const unscoped = (await chatHistory.listSessions()).map((s) => s.id);
  assert.ok(alice.includes("s-alice") && !alice.includes("s-bob"));
  assert.ok(bob.includes("s-bob") && !bob.includes("s-alice"));
  assert.ok(admin.includes("s-alice") && admin.includes("s-bob"));
  assert.deepEqual(unscoped.sort(), admin.sort()); // auth-off sees all
});

// ── Access gating ───────────────────────────────────────────────────────────

test("accessSession: auth-off passes everything", () => {
  assert.equal(chatHistory.accessSession(null, "s-alice", { authEnabled: false, isAdmin: false }).ok, true);
  assert.equal(chatHistory.accessSession(null, "missing", { authEnabled: false, isAdmin: false }).ok, false);
});

test("accessSession: auth-on is owner-or-admin, NULL rows admin-only", () => {
  const alice = { email: "alice@example.com", groups: [] };
  const bob = { email: "bob@example.com", groups: [] };
  const admin = { email: "root@example.com", groups: ["admin"] };
  assert.equal(chatHistory.accessSession(alice, "s-alice", { authEnabled: true, isAdmin: false }).ok, true);
  assert.equal(chatHistory.accessSession(bob, "s-alice", { authEnabled: true, isAdmin: false }).reason, "forbidden");
  assert.equal(chatHistory.accessSession(admin, "s-alice", { authEnabled: true, isAdmin: true }).ok, true);
  // NULL-owner row (pre-migration): non-admin forbidden, admin passes.
  chatHistory.recordMessage("s-null", "user", "old row", undefined, null);
  assert.equal(chatHistory.accessSession(alice, "s-null", { authEnabled: true, isAdmin: false }).reason, "forbidden");
  assert.equal(chatHistory.accessSession(admin, "s-null", { authEnabled: true, isAdmin: true }).ok, true);
});

test("accessSession: the live unrowed current session is viewable", () => {
  // currentId is the shim's platform-test-current with no SQLite row yet.
  assert.equal(
    chatHistory.accessSession({ email: "whoever@example.com", groups: [] }, currentId, {
      authEnabled: true,
      isAdmin: false,
    }).ok,
    true,
  );
  assert.equal(
    chatHistory.accessSession({ email: "whoever@example.com", groups: [] }, "never-existed", {
      authEnabled: true,
      isAdmin: false,
    }).reason,
    "not_found",
  );
});

// ── Per-viewer delivery ─────────────────────────────────────────────────────

function makeSocket(viewedSession, user) {
  return {
    viewedSession,
    user,
    readyState: "OPEN",
    OPEN: "OPEN",
    sent: [],
    send(msg) {
      this.sent.push(JSON.parse(msg));
    },
  };
}

function makeCtx(sockets, authEnabled) {
  const ctx = createAppContext({ AUTH_MODE: authEnabled ? "logto" : "none" });
  for (const s of sockets) ctx.clients.add(s);
  ctx.isAdminUser = (u) => Array.isArray(u?.groups) && u.groups.includes("admin");
  return ctx;
}

test("sendToViewers: disjoint delivery + additive sessionId field", () => {
  const a = makeSocket("s-alice", { email: "alice@example.com", groups: [] });
  const b = makeSocket("s-bob", { email: "bob@example.com", groups: [] });
  const ctx = makeCtx([a, b], true);

  ctx.sendToViewers("s-alice", { type: "text", delta: "hi" });
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);
  assert.deepEqual(a.sent[0], { type: "text", delta: "hi", sessionId: "s-alice" });

  ctx.sendToViewers("s-bob", { type: "agent_start" });
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
});

test("broadcastSessions: per-connection scope + per-connection current", async () => {
  const a = makeSocket("s-alice", { email: "alice@example.com", groups: [] });
  const b = makeSocket("s-bob", { email: "bob@example.com", groups: [] });
  const admin = makeSocket("s-alice", { email: "root@example.com", groups: ["admin"] });
  const ctx = makeCtx([a, b, admin], true);

  await ctx.broadcastSessions();
  const ids = (s) => s.sent.filter((m) => m.type === "sessions").map((m) => m.sessions.map((x) => x.id));
  // The un-rowed live session (the shim's current id, no SQLite row) is the
  // blank canvas: merged into every entitled owner's list (see listSessions).
  assert.deepEqual(ids(a), [["s-alice", "platform-test-current"]]);
  assert.deepEqual(ids(b), [["s-bob", "platform-test-current"]]);
  const adminIds = admin.sent.find((m) => m.type === "sessions").sessions.map((x) => x.id);
  assert.ok(adminIds.includes("s-alice") && adminIds.includes("s-bob"));
  // `current` names the connection's OWN viewed session.
  assert.equal(admin.sent.find((m) => m.type === "sessions").current, "s-alice");
  assert.equal(b.sent.find((m) => m.type === "sessions").current, "s-bob");
});

test("auth-off broadcastSessions degenerates to today's shared semantics", async () => {
  const a = makeSocket("s-alice", null);
  const ctx = makeCtx([a], false);
  await ctx.broadcastSessions();
  const evt = a.sent.find((m) => m.type === "sessions");
  assert.ok(evt.sessions.some((s) => s.id === "s-alice"));
  assert.ok(evt.sessions.some((s) => s.id === "s-bob")); // sees everything
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
