// Usage attribution three-state test (unify-im-solution 1.6).
// Mapped address → its room/conversation; unmapped → plain 1:1 (nulls);
// unbound (unbound_at set) → falls back to 1:1. And a bot session that is not
// a bot session at all yields nulls (never a wrong归属).
import test from "node:test";
import assert from "node:assert/strict";

import * as db from "../db.js";
import { sessionIdFor } from "../server/bots.js";
import { bindIdentity, unbindIdentity } from "./channel-identity.js";
import { parseBotSession, chatKeyForSession, attributionForSession } from "./usage-attribution.js";

// Hermetic db module: initDb() opens a fresh temp app.db (PLATFORM_DATA_DIR is
// set by the test runner to a temp dir). We use the real db module so the
// channel_identity + bots + bot_chats tables and the migration chain all exist.
await db.initDb();
const rawDb = db.getDb();
const handles = { getBot: db.getBot, listBotChats: db.listBotChats, rawDb };

const BOT_ID = "11111111-1111-4111-8111-111111111111";
function seedBot(platform) {
  db.addBot?.({ id: BOT_ID, type: platform, name: "t", credentials: {}, secret: "s" });
}

test("parseBotSession extracts botId + keyHash from a bot session id", () => {
  const sid = sessionIdFor(BOT_ID, "1:9");
  const p = parseBotSession(sid);
  assert.equal(p.botId, BOT_ID);
  assert.match(p.keyHash, /^[0-9a-f]{16}$/);
  assert.equal(parseBotSession("chat-abc"), null); // not a bot session
});

test("three states: mapped → room; unmapped → 1:1; unbound → 1:1 (no double count)", () => {
  seedBot("chatwoot");
  const chatKey = "1:9";
  db.upsertBotChat(BOT_ID, chatKey, "visitor"); // so chatKeyForSession can find it
  const sid = sessionIdFor(BOT_ID, chatKey);

  // (1) unmapped → plain 1:1
  let a = attributionForSession(handles, sid);
  assert.deepEqual(a, { roomId: null, conversationId: null });

  // (2) mapped → the room/conversation
  bindIdentity(rawDb, { platform: "chatwoot", chatKey, roomId: "room-42", conversationId: "conv-9" });
  a = attributionForSession(handles, sid);
  assert.deepEqual(a, { roomId: "room-42", conversationId: "conv-9" });

  // (3) unbound → falls back to 1:1 (not still room-42 — the "no double count" rule)
  unbindIdentity(rawDb, "chatwoot", chatKey);
  a = attributionForSession(handles, sid);
  assert.deepEqual(a, { roomId: null, conversationId: null });
});

test("a non-bot session yields no attribution (never a wrong归属)", () => {
  assert.deepEqual(attributionForSession(handles, "chat-xyz"), { roomId: null, conversationId: null });
  assert.deepEqual(attributionForSession(handles, "bot-unknown-0000000000000000"), { roomId: null, conversationId: null });
});

test("chatKeyForSession recovers the chatKey by recomputing the hash over bot_chats", () => {
  // chatKeyForSession is bot-agnostic: it only needs listBotChats and the
  // session's own botId prefix. Reuse the already-seeded bot.
  const ck = "chat-77";
  db.upsertBotChat(BOT_ID, ck, "u");
  const sid = sessionIdFor(BOT_ID, ck);
  assert.equal(chatKeyForSession({ listBotChats: db.listBotChats }, sid), ck);
});
