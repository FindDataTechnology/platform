// Usage attribution via channel_identity (unify-im-solution 1.6).
//
// A bot turn's usage row (pack_usage_events) is keyed by (user_email,
// session_id) today — it answers "which user", not "which conversation". When
// several inbound addresses (an IM group, a support-desk conversation) belong
// to ONE归属 (a room), billing and "what did we say to X" must follow the
// mapping, not the raw address. This module turns a bot session id into the
// chatKey it came from, then asks channel_identity for that chatKey's归属.
//
// It is deliberately advisory: it returns the attribution, it does not write.
// The caller attaches it to the usage row under failure isolation (a missing
// mapping, a non-bot session, a broken lookup all yield "no attribution" —
// which is exactly the pre-change behavior, never a wrong归属).
//
// Why reverse-lookup instead of storing chatKey: sessionIdFor() encodes only
// sha1(chatKey)[:16], not the chatKey itself. bot_chats holds (bot_id, chat_key,
// ...), so the session's chatKey is found by recomputing sessionIdFor over the
// rows of that bot — exact, and no schema change to the session store.

import crypto from "node:crypto";
import { resolveIdentity } from "./channel-identity.js";

const SESSION_RE = /^bot-(.+)-([0-9a-f]{16})$/;

/** `bot-<botId>-<sha1(chatKey)[:16]>` → { botId } | null. */
export function parseBotSession(sessionId) {
  const m = SESSION_RE.exec(String(sessionId ?? ""));
  if (!m) return null;
  return { botId: m[1], keyHash: m[2] };
}

/** The chatKey a bot session came from, by recomputing the hash over bot_chats. */
export function chatKeyForSession(db, sessionId) {
  const parsed = parseBotSession(sessionId);
  if (!parsed) return null;
  let chats;
  try {
    // The bot's own chats only — a row from another bot hashes over a different
    // botId prefix and can never collide with this session.
    chats = (db.listBotChats?.() ?? []).filter((c) => c.botId === parsed.botId);
  } catch {
    return null;
  }
  for (const c of chats) {
    const h = crypto.createHash("sha1").update(String(c.chatKey)).digest("hex").slice(0, 16);
    if (h === parsed.keyHash) return c.chatKey;
  }
  return null;
}

/**
 * Attribution for a turn's usage row: which room/conversation this session's
 * chat belongs to, or all-null when it is a plain 1:1 (unmapped) or not a bot
 * session. `platform` comes from the bot row (the session id carries botId, and
 * bot.type is the platform).
 *
 * `handles` = { getBot, listBotChats, rawDb } — the db module's row readers plus
 * the raw better-sqlite handle (resolveIdentity needs .prepare). All optional;
 * a missing handle yields "no attribution", never a wrong归属.
 */
export function attributionForSession(handles, sessionId) {
  const none = { roomId: null, conversationId: null };
  const { getBot, listBotChats, rawDb } = handles ?? {};
  const parsed = parseBotSession(sessionId);
  if (!parsed || typeof getBot !== "function" || typeof rawDb?.prepare !== "function") return none;
  let bot;
  try {
    bot = getBot(parsed.botId) ?? null;
  } catch {
    return none;
  }
  if (!bot) return none;
  const chatKey = chatKeyForSession({ listBotChats }, sessionId);
  if (!chatKey) return none;
  try {
    return resolveIdentity(rawDb, bot.type, chatKey);
  } catch {
    return none;
  }
}
