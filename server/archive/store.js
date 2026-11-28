// ── Archive store: 表归本模块自建 ────────────────────────────────────────────
//
// 跟 `input-requests.js` / `model-budget.js` 同一个约定：`ensureArchiveSchema(db)`
// 幂等建表，每个函数首参收 `db`，不进 fleets-db.js 的 schema 块。回滚=摘通道，空表无害。
//
// 两条与"普通业务表"不同的设计：
//
// 1. **同意是一等列，且不可回填**。`archive_conversation.agree_state` 只能由官方接口/回调写入；
//    规格禁止推断同意，所以这里没有"默认 agree"的路径。
// 2. **丢失区间只 append**。`archive_loss` 没有删除/更新语句——后续拉取成功不得把账洗白。
//    这是规格里「MUST NOT 被后续成功拉取清除」的结构化落地：代码里根本没有那条路。

export function ensureArchiveSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_cursor (
      id              TEXT PRIMARY KEY,
      seq             INTEGER NOT NULL DEFAULT 0,
      last_checked_at INTEGER NOT NULL DEFAULT 0,
      last_msg_at     INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS archive_conversation (
      conversation_id TEXT PRIMARY KEY,
      kind            TEXT NOT NULL DEFAULT 'unknown',
      name            TEXT NOT NULL DEFAULT '',
      agree_state     TEXT NOT NULL DEFAULT 'unknown',
      agree_at        INTEGER NOT NULL DEFAULT 0,
      first_msg_at    INTEGER,
      last_msg_at     INTEGER,
      msg_count       INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archive_conv_last ON archive_conversation(last_msg_at DESC);

    CREATE TABLE IF NOT EXISTS archive_participant (
      conversation_id TEXT NOT NULL,
      user_id         TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'unknown',
      display_name    TEXT NOT NULL DEFAULT '',
      first_seen_at   INTEGER,
      last_seen_at    INTEGER,
      PRIMARY KEY (conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS archive_message (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      msg_id          TEXT NOT NULL,
      seq             INTEGER NOT NULL DEFAULT 0,
      sent_at         INTEGER NOT NULL,
      sender          TEXT NOT NULL DEFAULT '',
      origin          TEXT NOT NULL DEFAULT 'unknown',
      msg_type        TEXT NOT NULL DEFAULT 'unknown',
      text            TEXT NOT NULL DEFAULT '',
      raw_json        TEXT,
      ingested_at     INTEGER NOT NULL,
      merge_key       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_archive_msg_conv ON archive_message(conversation_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_archive_msg_merge ON archive_message(merge_key);

    CREATE TABLE IF NOT EXISTS archive_media (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_id      TEXT NOT NULL,
      sdk_file_id     TEXT NOT NULL,
      media_type      TEXT NOT NULL DEFAULT 'unknown',
      bytes           INTEGER NOT NULL DEFAULT 0,
      state           TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archive_media_state ON archive_media(state);

    -- 丢失账本：只有 INSERT / 区间合并，没有 DELETE。见文件头第 2 条。
    CREATE TABLE IF NOT EXISTS archive_loss (
      from_ts     INTEGER PRIMARY KEY,
      to_ts       INTEGER NOT NULL,
      seats_json  TEXT NOT NULL DEFAULT '[]',
      detected_at INTEGER NOT NULL
    );

    -- 同意变更的"跨进程失效水位"。
    -- 内存缓存（createConsentCache）只活在拉起取的那个进程里；而 msg_audit_approved
    -- 回调由网关/独立进程处理。没有这张表，回调只能清掉自己进程的缓存，拉取进程
    -- 会继续用旧结论——"客户已撤回同意但我们还在写"就是从这里漏出去的。
    -- conversation_id 用 '*' 表示"认不出是哪个会话，全清"。
    CREATE TABLE IF NOT EXISTS archive_consent_event (
      conversation_id TEXT PRIMARY KEY,
      at              INTEGER NOT NULL
    );
  `);

  // 老库升级：`last_success_at` 是后加的列，CREATE TABLE IF NOT EXISTS 不会补到已存在的表上。
  // 用 PRAGMA 查过再 ALTER（幂等，不裸 ALTER）：列缺失时补 0，`evaluateLag` 会据此报
  // never_checked 而不是拿最后一条消息时间去猜——"不知道"必须显示成"不知道"。
  ensureColumn(db, "archive_cursor", "last_success_at", "INTEGER NOT NULL DEFAULT 0");
}

/** 幂等补列。SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查表结构。 */
function ensureColumn(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

// ── cursor ──────────────────────────────────────────────────────────────────

export function readCursor(db, id = "default") {
  ensureArchiveSchema(db);
  const row = db.prepare("SELECT * FROM archive_cursor WHERE id=?").get(id);
  if (!row) return { id, seq: 0, lastCheckedAt: 0, lastMessageAt: 0, lastSuccessAt: 0 };
  return {
    id: row.id,
    seq: Number(row.seq),
    lastCheckedAt: Number(row.last_checked_at),
    lastMessageAt: Number(row.last_msg_at),
    lastSuccessAt: Number(row.last_success_at ?? 0),
  };
}

export function writeCursor(db, state) {
  ensureArchiveSchema(db);
  db.prepare(
    `INSERT INTO archive_cursor(id, seq, last_checked_at, last_msg_at, last_success_at) VALUES(?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       seq             = MAX(archive_cursor.seq, excluded.seq),
       last_checked_at = MAX(archive_cursor.last_checked_at, excluded.last_checked_at),
       last_msg_at     = MAX(archive_cursor.last_msg_at, excluded.last_msg_at),
       last_success_at = MAX(archive_cursor.last_success_at, excluded.last_success_at)`,
  ).run(
    state.id || "default",
    Number(state.seq || 0),
    Number(state.lastCheckedAt || 0),
    Number(state.lastMessageAt || 0),
    Number(state.lastSuccessAt || 0),
  );
}

// ── conversation ────────────────────────────────────────────────────────────

export function upsertConversation(db, conv) {
  ensureArchiveSchema(db);
  db.prepare(
    `INSERT INTO archive_conversation(conversation_id, kind, name, agree_state, agree_at, updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       kind    = CASE WHEN excluded.kind <> 'unknown' THEN excluded.kind ELSE archive_conversation.kind END,
       name    = CASE WHEN excluded.name <> '' THEN excluded.name ELSE archive_conversation.name END,
       -- 同意状态只接受显式写入；unknown 不得覆盖已有结论
       agree_state = CASE WHEN excluded.agree_state <> 'unknown' THEN excluded.agree_state ELSE archive_conversation.agree_state END,
       agree_at    = CASE WHEN excluded.agree_state <> 'unknown' THEN excluded.agree_at ELSE archive_conversation.agree_at END,
       updated_at  = excluded.updated_at`,
  ).run(
    conv.conversationId,
    conv.kind || "unknown",
    conv.name || "",
    conv.agreeState || "unknown",
    Number(conv.agreeAt || 0),
    Number(conv.updatedAt || Date.now()),
  );
}

export function getAgreeState(db, conversationId) {
  ensureArchiveSchema(db);
  const row = db
    .prepare("SELECT agree_state FROM archive_conversation WHERE conversation_id=?")
    .get(conversationId);
  return row ? row.agree_state : "unknown";
}

/**
 * 记一条同意变更水位。只前进不后退（`MAX`）——同一毫秒内到达的两次事件不该让水位回退，
 * 否则拉取侧会"看起来是新的"而反复丢缓存。
 */
export function recordConsentEvent(db, conversationId, at) {
  ensureArchiveSchema(db);
  db.prepare(
    `INSERT INTO archive_consent_event(conversation_id, at) VALUES(?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET at = MAX(archive_consent_event.at, excluded.at)`,
  ).run(String(conversationId || "*"), Number(at || Date.now()));
}

/**
 * 该会话最近一次同意变更的时间。返回 `max(该会话的水位, 全局水位)`：
 * 全局水位（`'*'`）代表"认不出是哪个会话"，保守起见对所有会话生效。
 */
export function lastConsentEventAt(db, conversationId) {
  ensureArchiveSchema(db);
  const row = db
    .prepare(
      `SELECT MAX(at) AS at FROM archive_consent_event WHERE conversation_id IN (?, '*')`,
    )
    .get(String(conversationId || ""));
  return Number(row?.at || 0);
}

// ── message ─────────────────────────────────────────────────────────────────

/**
 * 幂等写入。冲突键是 `id`（`<conversationId>:<msgId>`），因为官方 msgid 在一个企业内唯一；
 * 跨通道重复（bot 回调 vs 存档）靠 `merge_key` 去重，见 `findByMergeKey`。
 */
export function insertMessage(db, msg) {
  ensureArchiveSchema(db);
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO archive_message
         (id, conversation_id, msg_id, seq, sent_at, sender, origin, msg_type, text, raw_json, ingested_at, merge_key)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      msg.id,
      msg.conversationId,
      msg.msgId,
      Number(msg.seq || 0),
      Number(msg.sentAt || 0),
      msg.sender || "",
      msg.origin || "unknown",
      msg.msgType || "unknown",
      msg.text || "",
      msg.rawJson ?? null,
      Number(msg.ingestedAt || Date.now()),
      msg.mergeKey || null,
    );
  return info.changes > 0;
}

export function findByMergeKey(db, mergeKey) {
  if (!mergeKey) return null;
  ensureArchiveSchema(db);
  return db.prepare("SELECT id FROM archive_message WHERE merge_key=?").get(mergeKey) || null;
}

export function refreshConversationStats(db, conversationId) {
  ensureArchiveSchema(db);
  const row = db
    .prepare(
      "SELECT COUNT(*) n, MIN(sent_at) lo, MAX(sent_at) hi FROM archive_message WHERE conversation_id=?",
    )
    .get(conversationId);
  db.prepare(
    "UPDATE archive_conversation SET msg_count=?, first_msg_at=?, last_msg_at=?, updated_at=? WHERE conversation_id=?",
  ).run(
    Number(row.n || 0),
    row.lo ?? null,
    row.hi ?? null,
    Date.now(),
    conversationId,
  );
}

// ── participant ─────────────────────────────────────────────────────────────

export function upsertParticipant(db, p) {
  ensureArchiveSchema(db);
  db.prepare(
    `INSERT INTO archive_participant(conversation_id, user_id, role, display_name, first_seen_at, last_seen_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(conversation_id, user_id) DO UPDATE SET
       role         = CASE WHEN excluded.role <> 'unknown' THEN excluded.role ELSE archive_participant.role END,
       display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE archive_participant.display_name END,
       first_seen_at = MIN(COALESCE(archive_participant.first_seen_at, excluded.first_seen_at), excluded.first_seen_at),
       last_seen_at  = MAX(COALESCE(archive_participant.last_seen_at, excluded.last_seen_at), excluded.last_seen_at)`,
  ).run(
    p.conversationId,
    p.userId,
    p.role || "unknown",
    p.displayName || "",
    p.at ?? null,
    p.at ?? null,
  );
}

// ── media ───────────────────────────────────────────────────────────────────

export function upsertMedia(db, m) {
  ensureArchiveSchema(db);
  db.prepare(
    `INSERT INTO archive_media(id, conversation_id, message_id, sdk_file_id, media_type, bytes, state, attempts, last_error, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       bytes      = excluded.bytes,
       state      = excluded.state,
       attempts   = excluded.attempts,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
  ).run(
    m.id,
    m.conversationId,
    m.messageId,
    m.sdkFileId,
    m.mediaType || "unknown",
    Number(m.bytes || 0),
    m.state || "pending",
    Number(m.attempts || 0),
    m.lastError ?? null,
    Date.now(),
  );
}

export function pendingMedia(db, limit = 50) {
  ensureArchiveSchema(db);
  return db
    .prepare("SELECT * FROM archive_media WHERE state='pending' ORDER BY updated_at ASC LIMIT ?")
    .all(limit);
}

// ── loss ledger（只 append）─────────────────────────────────────────────────

export function appendLoss(db, { fromTs, toTs, seats = [], detectedAt }) {
  ensureArchiveSchema(db);
  const from = Number(fromTs);
  const to = Number(toTs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new Error(`丢失区间非法：from=${fromTs} to=${toTs}`);
  }
  const existing = db
    .prepare("SELECT * FROM archive_loss WHERE to_ts >= ? AND from_ts <= ?")
    .get(from, to);
  if (existing) {
    const seatsMerged = [...new Set([...(JSON.parse(existing.seats_json) || []), ...seats])];
    db.prepare(
      "UPDATE archive_loss SET from_ts=?, to_ts=?, seats_json=?, detected_at=? WHERE from_ts=?",
    ).run(
      Math.min(existing.from_ts, from),
      Math.max(existing.to_ts, to),
      JSON.stringify(seatsMerged),
      Math.min(existing.detected_at, Number(detectedAt || Date.now())),
      existing.from_ts,
    );
    return;
  }
  db.prepare(
    "INSERT INTO archive_loss(from_ts, to_ts, seats_json, detected_at) VALUES(?,?,?,?)",
  ).run(from, to, JSON.stringify(seats), Number(detectedAt || Date.now()));
}

export function listLosses(db) {
  ensureArchiveSchema(db);
  return db
    .prepare("SELECT * FROM archive_loss ORDER BY from_ts")
    .all()
    .map((r) => ({
      fromTs: Number(r.from_ts),
      toTs: Number(r.to_ts),
      seats: JSON.parse(r.seats_json) || [],
      detectedAt: Number(r.detected_at),
    }));
}

// ── coverage（四口径，见 spec「禁止宣称全量」）──────────────────────────────

export function coverageReport(db, { effectiveSeats = null, purchasedSeats = null } = {}) {
  ensureArchiveSchema(db);
  const conv = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN msg_count > 0 THEN 1 ELSE 0 END) with_msgs,
              SUM(CASE WHEN agree_state='agree' THEN 1 ELSE 0 END) agreed,
              SUM(CASE WHEN agree_state='disagree' THEN 1 ELSE 0 END) disagreed
       FROM archive_conversation`,
    )
    .get();
  const msg = db
    .prepare("SELECT COUNT(*) n, MIN(sent_at) lo, MAX(sent_at) hi FROM archive_message")
    .get();
  const media = db
    .prepare(
      `SELECT SUM(CASE WHEN state='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) failed,
              COUNT(*) total FROM archive_media`,
    )
    .get();
  const total = Number(conv.total || 0);
  const agreed = Number(conv.agreed || 0);
  return {
    seats: {
      effective: effectiveSeats,
      purchased: purchasedSeats,
      gap:
        purchasedSeats !== null && effectiveSeats !== null
          ? Number(purchasedSeats) - Number(effectiveSeats)
          : null,
    },
    conversations: {
      total,
      withMessages: Number(conv.with_msgs || 0),
      agreed,
      disagreed: Number(conv.disagreed || 0),
      consentRatio: total ? agreed / total : null,
    },
    messages: {
      total: Number(msg.n || 0),
      firstAt: msg.lo ?? null,
      lastAt: msg.hi ?? null,
    },
    media: {
      total: Number(media.total || 0),
      done: Number(media.done || 0),
      failed: Number(media.failed || 0),
    },
    // 规格里明写的口径：禁止对外宣称"获取全部会话"。这里直接把话说死。
    claimsFullCoverage: false,
  };
}
