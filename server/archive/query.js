// ── Archive query surface（只读）─────────────────────────────────────────────
//
// agent 与看板只走这一层，不允许直接读表。理由有两个：
//   1. **同意边界必须集中在一处**。`Disagree` 的会话在规格里是"不存在"，
//      如果查询面各写各的 WHERE，迟早漏一处。
//   2. 中文检索的坑只在这里修一次。FTS5 的 trigram 分词器要求查询串 ≥3 字符，
//      两字中文词（合同/发票/客户）会**静默返回 0 条**——这个坑在 fd-wx-local 已实测踩过。
//
// 所有函数首参收 `db`，与 paas 其它模块一致（ensureXxxSchema + db 首参）。

import { parseMessage } from "./parse.js";
import { ensureArchiveSchema } from "./store.js";

const FTS_MIN_CHARS = 3;

export function ensureArchiveFts(db) {
  ensureArchiveSchema(db);
  let structured = true;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS archive_message_fts
      USING fts5(text, content='archive_message', content_rowid='rowid', tokenize='trigram');
    `);
  } catch {
    structured = false;
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS archive_message_fts
      USING fts5(text, content='archive_message', content_rowid='rowid', tokenize='unicode61');
    `);
  }
  // 外部内容表：用触发器同步，保证任何写入路径（含将来的批处理）都不会漏索引。
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS archive_message_ai AFTER INSERT ON archive_message BEGIN
      INSERT INTO archive_message_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS archive_message_ad AFTER DELETE ON archive_message BEGIN
      INSERT INTO archive_message_fts(archive_message_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS archive_message_au AFTER UPDATE OF text ON archive_message BEGIN
      INSERT INTO archive_message_fts(archive_message_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      INSERT INTO archive_message_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
  // 已有行补索引（重建比逐行补简单且幂等）
  try {
    db.exec("INSERT INTO archive_message_fts(archive_message_fts) VALUES('rebuild')");
  } catch {
    /* 空表重建失败无影响 */
  }
  return { structured };
}

/**
 * 同意闸门：只有 `agree_state='agree'` 的会话可见。
 *
 * 这里的每一处查询都**内联**写这个条件（listConversations / getMessages / search /
 * getMessageDetail），而不是抽一个 helper 共用。原先有一个
 * `visibleConversationsSql()` helper，但没有任何调用点——它是重构遗留的死代码。
 * 留着比删掉危险：下一个改这里的人会以为闸门靠它，从而漏掉某一处。
 * `scripts/test-archive-query.mjs` 逐条断言"disagree 会话连名字都列不出、内容搜不到"，
 * 那才是闸门的证据。
 */

export function listConversations(db, { limit = 30, withMessagesOnly = true } = {}) {
  ensureArchiveFts(db);
  const sql = `
    SELECT conversation_id, kind, name, agree_state, msg_count, first_msg_at, last_msg_at
      FROM archive_conversation
     WHERE agree_state='agree'
       ${withMessagesOnly ? "AND msg_count > 0" : ""}
     ORDER BY COALESCE(last_msg_at, 0) DESC
     LIMIT ?`;
  return db.prepare(sql).all(limit).map(mapConversation);
}

function mapConversation(r) {
  return {
    conversationId: r.conversation_id,
    kind: r.kind,
    name: r.name,
    msgCount: Number(r.msg_count),
    firstAt: r.first_msg_at,
    lastAt: r.last_msg_at,
  };
}

export function getMessages(db, { conversationId, limit = 50, sinceMs = null } = {}) {
  ensureArchiveFts(db);
  const visible = db
    .prepare("SELECT agree_state FROM archive_conversation WHERE conversation_id=?")
    .get(conversationId);
  if (!visible || visible.agree_state !== "agree") return [];
  const params = [conversationId];
  let sql = `SELECT id, msg_id, sent_at, sender, origin, msg_type, text
               FROM archive_message WHERE conversation_id=?`;
  if (sinceMs) {
    sql += " AND sent_at >= ?";
    params.push(Number(sinceMs));
  }
  sql += " ORDER BY sent_at ASC, id ASC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params).map((r) => ({
    id: r.id,
    msgId: r.msg_id,
    sentAt: r.sent_at,
    sender: r.sender,
    origin: r.origin,
    msgType: r.msg_type,
    text: r.text,
  }));
}

/**
 * 检索。
 *
 * `scope='peer'` 默认只搜对方说的话——本方（含 bot 自己的回复）不进检索结果，
 * 否则 agent 会把"自己昨天说过的话"当成客户新需求再答一遍。
 */
export function search(db, { query, limit = 20, scope = "peer" } = {}) {
  ensureArchiveFts(db);
  const q = String(query ?? "").trim();
  if (!q) return [];
  const scopeSql = scope === "all" ? "" : " AND m.origin='peer'";

  // 短词走 LIKE：trigram 对 <3 字符会静默返回 0 条
  if ([...q].length < FTS_MIN_CHARS) {
    return likeSearch(db, q, limit, scopeSql);
  }
  try {
    const rows = db
      .prepare(
        `SELECT m.id, m.conversation_id, m.msg_id, m.sent_at, m.sender, m.origin, m.msg_type, m.text,
                c.name AS conversation_name
           FROM archive_message_fts f
           JOIN archive_message m ON m.rowid = f.rowid
           JOIN archive_conversation c ON c.conversation_id = m.conversation_id
          WHERE archive_message_fts MATCH ?
            AND c.agree_state='agree'${scopeSql}
          ORDER BY m.sent_at DESC
          LIMIT ?`,
      )
      .all(quotePhrase(q), limit);
    if (rows.length) return rows.map(mapHit);
  } catch {
    /* 语法/分词边界：退化为 LIKE */
  }
  return likeSearch(db, q, limit, scopeSql);
}

function likeSearch(db, q, limit, scopeSql) {
  return db
    .prepare(
      `SELECT m.id, m.conversation_id, m.msg_id, m.sent_at, m.sender, m.origin, m.msg_type, m.text,
              c.name AS conversation_name
         FROM archive_message m
         JOIN archive_conversation c ON c.conversation_id = m.conversation_id
        WHERE m.text LIKE ?
          AND c.agree_state='agree'${scopeSql}
        ORDER BY m.sent_at DESC
        LIMIT ?`,
    )
    .all(`%${q}%`, limit)
    .map(mapHit);
}

function mapHit(r) {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    conversationName: r.conversation_name,
    msgId: r.msg_id,
    sentAt: r.sent_at,
    sender: r.sender,
    origin: r.origin,
    msgType: r.msg_type,
    text: r.text,
  };
}

/** FTS5 查询串转义：用户输入里的 - : * " 都是操作符。 */
function quotePhrase(q) {
  return `"${q.replace(/"/g, '""')}"`;
}

/**
 * 未覆盖原因分布（4.1b）。
 *
 * 口径就是规格里那张表：没消息的会话要能说清是"不同意"、"状态未知"还是"确实没聊"。
 * 这个数字决定覆盖率报告可不可信——只有一个总数时，42% 未覆盖没人能解释。
 */
export function coverageReasons(db) {
  ensureArchiveSchema(db);
  const rows = db
    .prepare(
      `SELECT agree_state, CASE WHEN msg_count > 0 THEN 1 ELSE 0 END AS has_msg, COUNT(*) n
         FROM archive_conversation
        GROUP BY agree_state, has_msg`,
    )
    .all();
  const out = {
    withMessages: 0,
    disagree: 0,
    unknownConsent: 0,
    agreedButEmpty: 0,
    total: 0,
  };
  for (const r of rows) {
    out.total += Number(r.n);
    if (Number(r.has_msg) === 1) {
      out.withMessages += Number(r.n);
    } else if (r.agree_state === "disagree") {
      out.disagree += Number(r.n);
    } else if (r.agree_state === "unknown") {
      out.unknownConsent += Number(r.n);
    } else {
      out.agreedButEmpty += Number(r.n);
    }
  }
  return out;
}

/** 单条消息的解析视图（含媒体描述），给"点开一条看看到底是什么"用。 */
export function getMessageDetail(db, id) {
  ensureArchiveFts(db);
  const row = db
    .prepare(
      `SELECT m.*, c.agree_state FROM archive_message m
         JOIN archive_conversation c ON c.conversation_id = m.conversation_id
        WHERE m.id=?`,
    )
    .get(id);
  if (!row || row.agree_state !== "agree") return null;
  let raw = {};
  try {
    raw = JSON.parse(row.raw_json || "{}");
  } catch {
    raw = {};
  }
  const parsed = parseMessage(raw);
  const media = db
    .prepare("SELECT sdk_file_id, media_type, bytes, state, attempts, last_error FROM archive_media WHERE message_id=?")
    .all(id);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sentAt: row.sent_at,
    sender: row.sender,
    origin: row.origin,
    msgType: row.msg_type,
    text: row.text,
    parsed: { known: parsed.known, media: parsed.media },
    media,
  };
}
