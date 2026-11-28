// ── 微信客服：存储 ──────────────────────────────────────────────────────────
//
// 跟 `archive/store.js` 一个约定：`ensureKfSchema(db)` 幂等建表，每函数首参收 `db`，
// 回滚=摘通道，空表无害。
//
// 与存档表的三处刻意差异：
//
// 1. **游标是文字不是数字**。`next_cursor` 是不透明串，不能比较大小，
//    所以"只进不退"只能靠"非空且与请求不同"来判，不能照抄 `MAX(seq, excluded.seq)`。
// 2. **没有 agree_state 列**。kf 是客户主动咨询，不存在外部客户的存档同意问题；
//    加一列恒为 `agree` 的字段等于伪造同意。
// 3. **`history_from` 是一等字段**。3 天窗口意味着首轮之前的历史永远拿不到，
//    这个事实必须落在数据里，否则巡检面会以为库里的是全部。

export function ensureKfSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kf_cursor (
      id              TEXT PRIMARY KEY,
      cursor          TEXT NOT NULL DEFAULT '',
      last_checked_at INTEGER NOT NULL DEFAULT 0,
      last_msg_at     INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER NOT NULL DEFAULT 0,
      history_from    INTEGER NOT NULL DEFAULT 0,
      truncations     INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS kf_conversation (
      conversation_id  TEXT PRIMARY KEY,
      open_kfid        TEXT NOT NULL DEFAULT '',
      external_userid  TEXT NOT NULL DEFAULT '',
      name             TEXT NOT NULL DEFAULT '',
      first_msg_at     INTEGER,
      last_msg_at      INTEGER,
      msg_count        INTEGER NOT NULL DEFAULT 0,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kf_conv_last ON kf_conversation(last_msg_at DESC);

    CREATE TABLE IF NOT EXISTS kf_message (
      id               TEXT PRIMARY KEY,
      conversation_id  TEXT NOT NULL,
      msg_id           TEXT NOT NULL,
      open_kfid        TEXT NOT NULL DEFAULT '',
      external_userid  TEXT NOT NULL DEFAULT '',
      servicer_userid  TEXT NOT NULL DEFAULT '',
      sent_at          INTEGER NOT NULL,
      origin           TEXT NOT NULL DEFAULT 'unknown',
      msg_type         TEXT NOT NULL DEFAULT 'unknown',
      text             TEXT NOT NULL DEFAULT '',
      media_id         TEXT,
      media_type       TEXT,
      event_type       TEXT,
      raw_json         TEXT,
      ingested_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kf_msg_conv ON kf_message(conversation_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_kf_msg_sent ON kf_message(sent_at DESC);

    CREATE TABLE IF NOT EXISTS kf_customer (
      external_userid TEXT PRIMARY KEY,
      nickname        TEXT NOT NULL DEFAULT '',
      avatar          TEXT NOT NULL DEFAULT '',
      gender          INTEGER NOT NULL DEFAULT 0,
      unionid         TEXT NOT NULL DEFAULT '',
      state           TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      fetched_at      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_kf_customer_state ON kf_customer(state);

    -- 媒体：正文早就入库了，这里只管"附件有没有真的取到"。
    -- 一条消息一个媒体，所以主键直接用消息主键。
    CREATE TABLE IF NOT EXISTS kf_media (
      id              TEXT PRIMARY KEY,
      message_id      TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      media_id        TEXT NOT NULL,
      media_type      TEXT NOT NULL DEFAULT 'unknown',
      bytes           INTEGER NOT NULL DEFAULT 0,
      path            TEXT,
      state           TEXT NOT NULL DEFAULT 'pending',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kf_media_state ON kf_media(state);

    -- 附件正文。**故意不放进 kf_media**：那张表是下载状态机，pendingKfMedia 用
    -- SELECT * 整行取；把两万字符的正文塞进去，每轮待取查询都会拖着所有历史正文。
    -- 主键取消息主键：检索与取正文都是按消息定位的（kf 一条消息一个附件）。
    CREATE TABLE IF NOT EXISTS kf_attachment_text (
      message_id      TEXT PRIMARY KEY,
      kind            TEXT NOT NULL DEFAULT 'unknown',
      text            TEXT NOT NULL,
      chars           INTEGER NOT NULL DEFAULT 0,
      truncated       INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL
    );
  `);

  // 老库升级：`last_success_at` 是后加的列。补列而不是重建表——客户库里已经有游标与
  // history_from，重建会丢"不可得边界"。补 0 之后 `evaluateLag` 报 never_checked，
  // 等第一轮成功同步把它填上。
  ensureKfColumn(db, "kf_cursor", "last_success_at", "INTEGER NOT NULL DEFAULT 0");

  // 附件抽取状态同样补列。`kind` 是内容判定出来的类型（kf 不给文件名，
  // 见 extract.js 的说明）；`extract_state` 与 `state` 分开——抽取失败绝不能
  // 让下载状态回退，否则下一轮会重下一个已经落盘的文件。
  ensureKfColumn(db, "kf_media", "kind", "TEXT");
  ensureKfColumn(db, "kf_media", "extract_state", "TEXT NOT NULL DEFAULT ''");
  ensureKfColumn(db, "kf_media", "extract_error", "TEXT");
}

/** 幂等补列（SQLite 没有 ADD COLUMN IF NOT EXISTS）。 */
function ensureKfColumn(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

// ── cursor ──────────────────────────────────────────────────────────────────

export function readKfCursor(db, id = "default") {
  ensureKfSchema(db);
  const row = db.prepare("SELECT * FROM kf_cursor WHERE id=?").get(id);
  if (!row) {
    return {
      id,
      cursor: "",
      lastCheckedAt: 0,
      lastMessageAt: 0,
      lastSuccessAt: 0,
      historyFrom: 0,
      truncations: 0,
    };
  }
  return {
    id: row.id,
    cursor: String(row.cursor || ""),
    lastCheckedAt: Number(row.last_checked_at),
    lastMessageAt: Number(row.last_msg_at),
    lastSuccessAt: Number(row.last_success_at ?? 0),
    historyFrom: Number(row.history_from),
    truncations: Number(row.truncations),
  };
}

/**
 * 写游标。
 *
 * 文字游标没法比大小，所以这里的"只进"靠调用方保证：只在消息落库之后、
 * 且 `next_cursor` 与请求值不同时调用。这里额外做的是三件单调事：
 * 检查水位与数据水位取 max，`history_from` 一旦写下就不再改（它记录的是不可得边界）。
 */
export function writeKfCursor(db, state) {
  ensureKfSchema(db);
  const id = state.id || "default";
  const prev = readKfCursor(db, id);
  const cursor = state.cursor ? String(state.cursor) : prev.cursor;
  const historyFrom = prev.historyFrom || Number(state.historyFrom || 0);
  db.prepare(
    `INSERT INTO kf_cursor(id, cursor, last_checked_at, last_msg_at, last_success_at, history_from, truncations, updated_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       cursor          = excluded.cursor,
       last_checked_at = MAX(kf_cursor.last_checked_at, excluded.last_checked_at),
       last_msg_at     = MAX(kf_cursor.last_msg_at, excluded.last_msg_at),
       last_success_at = MAX(kf_cursor.last_success_at, excluded.last_success_at),
       history_from    = MAX(kf_cursor.history_from, excluded.history_from),
       truncations     = kf_cursor.truncations + excluded.truncations,
       updated_at      = excluded.updated_at`,
  ).run(
    id,
    cursor,
    Number(state.lastCheckedAt || 0),
    Number(state.lastMessageAt || 0),
    Number(state.lastSuccessAt || 0),
    historyFrom,
    Math.max(0, Number(state.truncations || 0)),
    Number(state.updatedAt || Date.now()),
  );
}

// ── conversation ────────────────────────────────────────────────────────────

export function upsertKfConversation(db, conv) {
  ensureKfSchema(db);
  db.prepare(
    `INSERT INTO kf_conversation(conversation_id, open_kfid, external_userid, name, updated_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET
       open_kfid       = CASE WHEN excluded.open_kfid <> '' THEN excluded.open_kfid ELSE kf_conversation.open_kfid END,
       external_userid = CASE WHEN excluded.external_userid <> '' THEN excluded.external_userid ELSE kf_conversation.external_userid END,
       name            = CASE WHEN excluded.name <> '' THEN excluded.name ELSE kf_conversation.name END,
       updated_at      = excluded.updated_at`,
  ).run(
    conv.conversationId,
    conv.openKfId || "",
    conv.externalUserId || "",
    conv.name || "",
    Number(conv.updatedAt || Date.now()),
  );
}

export function getKfConversation(db, conversationId) {
  ensureKfSchema(db);
  const row = db.prepare("SELECT * FROM kf_conversation WHERE conversation_id=?").get(conversationId);
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    openKfId: row.open_kfid,
    externalUserId: row.external_userid,
    name: row.name,
    firstMsgAt: row.first_msg_at ?? null,
    lastMsgAt: row.last_msg_at ?? null,
    msgCount: Number(row.msg_count || 0),
  };
}

/**
 * 会话列表（按最近消息倒序），带上「客户最后发言 / 我方最后回复」两列。
 *
 * 这两列是回复窗口判定的原料：工具面与 CLI 都要用，所以放在 store 里算一次，
 * 而不是让两个调用方各自拼 SQL（拼两遍必然会漂）。
 */
export function listKfConversations(db, { limit = 50 } = {}) {
  ensureKfSchema(db);
  return db
    .prepare(
      `SELECT c.*,
              (SELECT MAX(sent_at) FROM kf_message m
                 WHERE m.conversation_id = c.conversation_id AND m.origin = 'peer') AS last_peer_at,
              (SELECT MAX(sent_at) FROM kf_message m
                 WHERE m.conversation_id = c.conversation_id AND m.origin = 'self') AS last_self_at
         FROM kf_conversation c
        ORDER BY c.last_msg_at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(500, Number(limit) || 50)))
    .map((r) => ({
      conversationId: r.conversation_id,
      openKfId: r.open_kfid,
      externalUserId: r.external_userid,
      name: r.name || "",
      firstMsgAt: r.first_msg_at ?? null,
      lastMsgAt: r.last_msg_at ?? null,
      msgCount: Number(r.msg_count || 0),
      lastPeerAt: Number(r.last_peer_at || 0) || null,
      lastSelfAt: Number(r.last_self_at || 0) || null,
    }));
}

export function refreshKfConversationStats(db, conversationId) {  ensureKfSchema(db);
  const row = db
    .prepare(
      "SELECT COUNT(*) n, MIN(sent_at) lo, MAX(sent_at) hi FROM kf_message WHERE conversation_id=?",
    )
    .get(conversationId);
  db.prepare(
    "UPDATE kf_conversation SET msg_count=?, first_msg_at=?, last_msg_at=?, updated_at=? WHERE conversation_id=?",
  ).run(Number(row.n || 0), row.lo ?? null, row.hi ?? null, Date.now(), conversationId);
}

// ── message ─────────────────────────────────────────────────────────────────

/** 幂等写入。主键 `<会话ID>:<msgid>`，重放同一批不增产。 */
export function insertKfMessage(db, msg) {
  ensureKfSchema(db);
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO kf_message
         (id, conversation_id, msg_id, open_kfid, external_userid, servicer_userid,
          sent_at, origin, msg_type, text, media_id, media_type, event_type, raw_json, ingested_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      msg.id,
      msg.conversationId,
      msg.msgId,
      msg.openKfId || "",
      msg.externalUserId || "",
      msg.servicerUserId || "",
      Number(msg.sentAt || 0),
      msg.origin || "unknown",
      msg.msgType || "unknown",
      msg.text || "",
      msg.mediaId ?? null,
      msg.mediaType ?? null,
      msg.eventType ?? null,
      msg.rawJson ?? null,
      Number(msg.ingestedAt || Date.now()),
    );
  return info.changes > 0;
}

export function kfMessageCount(db) {
  ensureKfSchema(db);
  return Number(db.prepare("SELECT COUNT(*) n FROM kf_message").get().n || 0);
}

/**
 * 列出消息。默认按时间倒序，可按会话收窄。
 * `origin` 可传数组用于消费侧过滤（agent 输入只允许 peer）。
 */
export function listKfMessages(db, { conversationId, origins, limit = 100, before } = {}) {
  ensureKfSchema(db);
  const where = [];
  const args = [];
  if (conversationId) {
    where.push("conversation_id=?");
    args.push(conversationId);
  }
  if (Array.isArray(origins) && origins.length) {
    where.push(`origin IN (${origins.map(() => "?").join(",")})`);
    args.push(...origins);
  }
  if (before !== undefined && before !== null) {
    where.push("sent_at < ?");
    args.push(Number(before));
  }
  const sql = `SELECT * FROM kf_message ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY sent_at DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, Math.max(1, Math.min(1000, Number(limit) || 100)))
    .map(rowToMessage);
}

export function rowToMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    msgId: row.msg_id,
    openKfId: row.open_kfid,
    externalUserId: row.external_userid,
    servicerUserId: row.servicer_userid,
    sentAt: Number(row.sent_at),
    origin: row.origin,
    msgType: row.msg_type,
    text: row.text,
    mediaId: row.media_id ?? null,
    mediaType: row.media_type ?? null,
    eventType: row.event_type ?? null,
    ingestedAt: Number(row.ingested_at),
  };
}

/**
 * 检索。
 *
 * 这里**不用 FTS5 trigram**：那个索引对 2 字中文查询静默返回 0（已在存档侧踩过），
 * 而中文咨询里两字词（"报价""合同""发票"）恰恰是最常搜的。kf 的消息量级（未认证 100 客户）
 * 用 LIKE 全表扫完全够，换来的是"搜得到"。
 */
export function searchKfMessages(db, { query = "", limit = 50, origins = null } = {}) {
  ensureKfSchema(db);
  const q = String(query || "").trim();
  const size = Math.max(1, Math.min(500, Number(limit) || 50));
  const filters = [];
  const args = [];
  if (Array.isArray(origins) && origins.length) {
    filters.push(`m.origin IN (${origins.map(() => "?").join(",")})`);
    args.push(...origins);
  }
  if (!q) {
    const sql = `SELECT m.* FROM kf_message m ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
                 ORDER BY m.sent_at DESC LIMIT ?`;
    return db.prepare(sql).all(...args, size).map(rowToMessage);
  }
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // 附件正文也要能搜到：客户发来的报价单里写着"含税单价"，搜"含税"必须命中那封邮件，
  // 而不是因为他没在正文里打字就搜不到。`attachment_hit` 把"命中在哪"带出来，
  // 否则调用方看到一条 text 为空的命中会以为是脏数据。
  filters.push(
    `(m.text LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM kf_attachment_text t
                  WHERE t.message_id = m.id AND t.text LIKE ? ESCAPE '\\'))`,
  );
  args.push(like, like);
  return db
    .prepare(
      `SELECT m.*,
              CASE WHEN EXISTS (SELECT 1 FROM kf_attachment_text t
                                 WHERE t.message_id = m.id AND t.text LIKE ? ESCAPE '\\')
                   THEN 1 ELSE 0 END AS attachment_hit
         FROM kf_message m WHERE ${filters.join(" AND ")}
         ORDER BY m.sent_at DESC LIMIT ?`,
    )
    .all(like, ...args, size)
    .map((row) => {
      const msg = rowToMessage(row);
      if (row.attachment_hit) msg.matchedIn = "attachment";
      return msg;
    });
}

// ── customer ────────────────────────────────────────────────────────────────

/** 消息入库时先占位：`external_userid` 原样存，昵称等资料另外补。 */
export function ensureKfCustomer(db, externalUserId) {
  ensureKfSchema(db);
  db.prepare(
    "INSERT OR IGNORE INTO kf_customer(external_userid, state) VALUES(?, 'pending')",
  ).run(String(externalUserId));
}

export function pendingKfCustomers(db, limit = 100) {
  ensureKfSchema(db);
  return db
    .prepare(
      "SELECT external_userid FROM kf_customer WHERE state IN ('pending','failed') ORDER BY attempts ASC LIMIT ?",
    )
    .all(Math.max(1, Math.min(100, Number(limit) || 100)))
    .map((r) => r.external_userid);
}

export function markKfCustomer(db, { externalUserId, state, error = null }) {
  ensureKfSchema(db);
  db.prepare(
    `UPDATE kf_customer SET state=?, attempts=attempts+1, last_error=?, fetched_at=?
     WHERE external_userid=?`,
  ).run(state, error, Date.now(), String(externalUserId));
}

export function upsertKfCustomer(db, customer) {
  ensureKfSchema(db);
  db.prepare(
    `INSERT INTO kf_customer(external_userid, nickname, avatar, gender, unionid, state, attempts, last_error, fetched_at)
     VALUES(?,?,?,?,?,'done',1,NULL,?)
     ON CONFLICT(external_userid) DO UPDATE SET
       nickname = CASE WHEN excluded.nickname <> '' THEN excluded.nickname ELSE kf_customer.nickname END,
       avatar   = CASE WHEN excluded.avatar <> '' THEN excluded.avatar ELSE kf_customer.avatar END,
       gender   = CASE WHEN excluded.gender <> 0 THEN excluded.gender ELSE kf_customer.gender END,
       unionid  = CASE WHEN excluded.unionid <> '' THEN excluded.unionid ELSE kf_customer.unionid END,
       state    = 'done',
       last_error = NULL,
       fetched_at = excluded.fetched_at`,
  ).run(
    String(customer.external_userid || customer.externalUserId || ""),
    String(customer.nickname || ""),
    String(customer.avatar || ""),
    Number(customer.gender || 0),
    String(customer.unionid || ""),
    Date.now(),
  );
}

// ── media ───────────────────────────────────────────────────────────────────

/** 入队。主键=消息主键：一条消息只有一个媒体，重复入队是无害的 no-op。 */
export function queueKfMedia(db, row) {
  ensureKfSchema(db);
  db.prepare(
    `INSERT OR IGNORE INTO kf_media(id, message_id, conversation_id, media_id, media_type, state, updated_at)
     VALUES(?,?,?,?,?,'pending',?)`,
  ).run(row.id, row.messageId, row.conversationId, row.mediaId, row.mediaType || "unknown", Date.now());
}

export function pendingKfMedia(db, limit = 20) {
  ensureKfSchema(db);
  return db
    .prepare("SELECT * FROM kf_media WHERE state='pending' ORDER BY updated_at ASC LIMIT ?")
    .all(Math.max(1, Number(limit) || 20))
    .map((r) => ({
      id: r.id,
      messageId: r.message_id,
      conversationId: r.conversation_id,
      mediaId: r.media_id,
      mediaType: r.media_type,
      bytes: Number(r.bytes || 0),
      path: r.path ?? null,
      state: r.state,
      attempts: Number(r.attempts || 0),
      lastError: r.last_error ?? null,
    }));
}

export function markKfMedia(db, { id, state, bytes = 0, path = null, attempts = 0, error = null }) {
  ensureKfSchema(db);
  db.prepare(
    "UPDATE kf_media SET state=?, bytes=?, path=?, attempts=?, last_error=?, updated_at=? WHERE id=?",
  ).run(state, Number(bytes || 0), path, Number(attempts || 0), error, Date.now(), id);
}

/** 完成率。分母为 0 返回 null，不返回 1——空库不该显示 100%。 */
export function kfMediaCompletion(db) {
  ensureKfSchema(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN state='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) failed,
              SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) pending
         FROM kf_media`,
    )
    .get();
  const total = Number(row.total || 0);
  return {
    total,
    done: Number(row.done || 0),
    failed: Number(row.failed || 0),
    pending: Number(row.pending || 0),
    ratio: total ? Number(row.done || 0) / total : null,
  };
}

// ── attachment text ─────────────────────────────────────────────────────────

/** 写/覆盖一条附件正文。主键是消息主键，重复跑幂等。 */
export function putKfAttachmentText(db, { messageId, kind = "unknown", text, chars = 0, truncated = false }) {
  ensureKfSchema(db);
  db.prepare(
    `INSERT INTO kf_attachment_text(message_id, kind, text, chars, truncated, updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(message_id) DO UPDATE SET
       kind = excluded.kind,
       text = excluded.text,
       chars = excluded.chars,
       truncated = excluded.truncated,
       updated_at = excluded.updated_at`,
  ).run(
    String(messageId),
    String(kind || "unknown"),
    String(text ?? ""),
    Number(chars || 0),
    truncated ? 1 : 0,
    Date.now(),
  );
}

export function getKfAttachmentText(db, messageId) {
  ensureKfSchema(db);
  const r = db.prepare("SELECT * FROM kf_attachment_text WHERE message_id=?").get(String(messageId));
  if (!r) return null;
  return {
    messageId: r.message_id,
    kind: r.kind,
    text: r.text,
    chars: Number(r.chars || 0),
    truncated: Boolean(r.truncated),
    updatedAt: Number(r.updated_at),
  };
}

/** 记抽取自身的状态。**不碰 state/bytes/path**——那是下载状态机的列。 */
export function markKfExtract(db, { id, state, kind = null, error = null }) {
  ensureKfSchema(db);
  db.prepare(
    "UPDATE kf_media SET extract_state=?, kind=COALESCE(?, kind), extract_error=?, updated_at=? WHERE id=?",
  ).run(String(state), kind, error, Date.now(), id);
}

/**
 * 待抽取的附件：已落盘、还没有正文、且没有被判定失败。
 *
 * 失败行刻意不再选——一个坏文件每轮重抽一遍，既是无用功，也会把日志刷满。
 * 要重试一个失败的附件，先手动清它的 `extract_state`。
 */
export function pendingKfExtractions(db, limit = 20) {
  ensureKfSchema(db);
  return db
    .prepare(
      `SELECT m.* FROM kf_media m
        WHERE m.state='done' AND m.path IS NOT NULL AND m.path <> ''
          AND (m.extract_state IS NULL OR m.extract_state IN ('', 'pending'))
          AND NOT EXISTS (SELECT 1 FROM kf_attachment_text t WHERE t.message_id = m.message_id)
        ORDER BY m.updated_at ASC LIMIT ?`,
    )
    .all(Math.max(1, Number(limit) || 20))
    .map((r) => ({
      id: r.id,
      messageId: r.message_id,
      conversationId: r.conversation_id,
      mediaId: r.media_id,
      mediaType: r.media_type,
      bytes: Number(r.bytes || 0),
      path: r.path ?? null,
      state: r.state,
      kind: r.kind ?? null,
      extractState: r.extract_state ?? "",
      extractError: r.extract_error ?? null,
    }));
}

/** 单条附件的抽取状态。用于把"还没抽/抽失败了"如实告诉调用方，而不是给个空正文。 */
export function getKfMediaExtractState(db, messageId) {
  ensureKfSchema(db);
  const r = db
    .prepare("SELECT state, kind, extract_state, extract_error FROM kf_media WHERE id=?")
    .get(String(messageId));
  if (!r) return null;
  return {
    state: r.state,
    kind: r.kind ?? null,
    extractState: r.extract_state ?? "",
    extractError: r.extract_error ?? null,
  };
}

/** 抽取口径。分母只数"已落盘的附件"——没下载的附件谈不上抽取。 */
export function kfExtractionCompletion(db) {
  ensureKfSchema(db);
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN state='done' THEN 1 ELSE 0 END) total,
         SUM(CASE WHEN extract_state='done' THEN 1 ELSE 0 END) extracted,
         SUM(CASE WHEN extract_state='failed' THEN 1 ELSE 0 END) failed,
         SUM(CASE WHEN extract_state='no_extractor' THEN 1 ELSE 0 END) no_extractor,
         SUM(CASE WHEN extract_state='unknown_kind' THEN 1 ELSE 0 END) unknown_kind
       FROM kf_media`,
    )
    .get();
  const total = Number(row.total || 0);
  const extracted = Number(row.extracted || 0);
  return {
    total,
    extracted,
    failed: Number(row.failed || 0),
    noExtractor: Number(row.no_extractor || 0),
    unknownKind: Number(row.unknown_kind || 0),
    ratio: total ? extracted / total : null,
  };
}

// ── coverage ────────────────────────────────────────────────────────────────

/**
 * 覆盖口径。**禁止宣称全量**，理由有三条，全部写进返回值：
 *   - 窗口只有 3 天（`windowDays`）；
 *   - 首轮之前的历史不可得（`historyFrom`）；
 *   - 单轮批次上限会截断（`truncations`）。
 */
export function kfCoverageReport(db, { cursorId = "default", windowDays = 3 } = {}) {
  ensureKfSchema(db);
  const cursor = readKfCursor(db, cursorId);
  const conv = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN msg_count > 0 THEN 1 ELSE 0 END) with_msgs
       FROM kf_conversation`,
    )
    .get();
  const msg = db.prepare("SELECT COUNT(*) n, MIN(sent_at) lo, MAX(sent_at) hi FROM kf_message").get();
  const cust = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN state='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) failed
       FROM kf_customer`,
    )
    .get();
  const origin = db
    .prepare("SELECT origin, COUNT(*) n FROM kf_message GROUP BY origin")
    .all()
    .reduce((acc, r) => { acc[r.origin] = Number(r.n); return acc; }, {});

  return {
    channel: "wecom-kf",
    windowDays,
    cursor: {
      position: cursor.cursor,
      lastCheckedAt: cursor.lastCheckedAt || null,
      lastMessageAt: cursor.lastMessageAt || null,
      // 滞后判定的水位。为 null 时表示老库还没记录过成功拉取（诊断会报 never_checked）。
      lastSuccessAt: cursor.lastSuccessAt || null,
      historyFrom: cursor.historyFrom || null,
      truncations: cursor.truncations,
    },
    conversations: {
      total: Number(conv.total || 0),
      withMessages: Number(conv.with_msgs || 0),
    },
    messages: {
      total: Number(msg.n || 0),
      firstAt: msg.lo ?? null,
      lastAt: msg.hi ?? null,
      byOrigin: origin,
    },
    customers: {
      total: Number(cust.total || 0),
      done: Number(cust.done || 0),
      failed: Number(cust.failed || 0),
    },
    media: kfMediaCompletion(db),
    claimsFullCoverage: false,
    coverageNote:
      "微信客服只保留最近 3 天消息；首次同步之前的历史不可补。本报告不宣称覆盖全部历史。",
  };
}
