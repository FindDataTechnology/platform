// Channel identity map (Chatwoot reception): which paas room / Chatwoot
// conversation a given (platform, chat_key) belongs to. Migration v127 owns the
// table. No consumer is wired yet — this is the seam a later task binds.
//
// `unbound_at` retires a mapping instead of deleting it: resolve reads a retired
// row as unmapped, bind revives it (clears unbound_at).

const EMPTY = { roomId: null, conversationId: null };

export function resolveIdentity(db, platform, chatKey) {
  const row = db
    .prepare(
      "SELECT room_id, conversation_id FROM channel_identity WHERE platform = ? AND chat_key = ? AND unbound_at IS NULL"
    )
    .get(platform, chatKey);
  return row ? { roomId: row.room_id, conversationId: row.conversation_id } : EMPTY;
}

export function bindIdentity(db, { platform, chatKey, roomId = null, conversationId = null }) {
  db.prepare(
    `INSERT INTO channel_identity (platform, chat_key, room_id, conversation_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(platform, chat_key) DO UPDATE SET
       room_id = excluded.room_id,
       conversation_id = excluded.conversation_id,
       unbound_at = NULL`
  ).run(platform, chatKey, roomId, conversationId, Date.now());
}

export function unbindIdentity(db, platform, chatKey) {
  db.prepare(
    "UPDATE channel_identity SET unbound_at = ?, room_id = NULL, conversation_id = NULL WHERE platform = ? AND chat_key = ?"
  ).run(Date.now(), platform, chatKey);
}