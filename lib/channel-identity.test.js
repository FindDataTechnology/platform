// lib/channel-identity.js: bind → resolve round trip, unbind retires the
// mapping, and a missing row resolves to nulls. Migration v127 owns the table;
// this test creates it directly so it does not need the full db.js migration run.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { resolveIdentity, bindIdentity, unbindIdentity } from "../lib/channel-identity.js";

function freshDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE channel_identity (
    platform TEXT NOT NULL,
    chat_key TEXT NOT NULL,
    room_id TEXT,
    conversation_id TEXT,
    created_at INTEGER NOT NULL,
    unbound_at INTEGER,
    PRIMARY KEY (platform, chat_key)
  )`);
  return db;
}

test("bind → resolve returns the mapping", () => {
  const db = freshDb();
  bindIdentity(db, { platform: "chatwoot", chatKey: "c-1", roomId: "room-9", conversationId: "conv-3" });
  assert.deepEqual(resolveIdentity(db, "chatwoot", "c-1"), { roomId: "room-9", conversationId: "conv-3" });
});

test("rebind updates in place and revives an unbound row", () => {
  const db = freshDb();
  bindIdentity(db, { platform: "chatwoot", chatKey: "c-1", roomId: "room-1", conversationId: "conv-1" });
  unbindIdentity(db, "chatwoot", "c-1");
  bindIdentity(db, { platform: "chatwoot", chatKey: "c-1", roomId: "room-2", conversationId: "conv-2" });
  assert.deepEqual(resolveIdentity(db, "chatwoot", "c-1"), { roomId: "room-2", conversationId: "conv-2" });
  assert.equal(db.prepare("SELECT count(*) AS c FROM channel_identity").get().c, 1);
});

test("unbind → resolve returns nulls", () => {
  const db = freshDb();
  bindIdentity(db, { platform: "chatwoot", chatKey: "c-1", roomId: "room-1", conversationId: "conv-1" });
  unbindIdentity(db, "chatwoot", "c-1");
  assert.deepEqual(resolveIdentity(db, "chatwoot", "c-1"), { roomId: null, conversationId: null });
});

test("resolve on a missing row returns nulls", () => {
  const db = freshDb();
  assert.deepEqual(resolveIdentity(db, "chatwoot", "nope"), { roomId: null, conversationId: null });
});