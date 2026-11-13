// ── 存档数据归属：导出与完整性 ──────────────────────────────────────────────
//
// 私有化交付里有一句话必须能兑现：**客户随时能把自己的数据拿走，不需要我们的工具**。
// 所以导出格式只能是最笨的那种：目录 + 若干 JSONL + 一份清单，`sqlite3`、`jq`、
// 甚至 Excel 都能读。不打包成专有格式，不加自定义头，不做压缩。
//
// 三条设计取舍：
//
// 1. **每行一个对象，按主键排序**。排序是为了「两次导出内容一致」这条能被断言；
//    不排序的话 SQLite 的返回顺序取决于查询计划，同一份数据两次导出可能不同，
//    对账时会把"排序差异"误读成"数据变了"。
// 2. **清单只放计数与版本，不放导出时间以外的易变字段**。时间戳放在 manifest 里
//    单独的字段，方便测试比对其余部分的字节一致性。
// 3. **完整性用 `PRAGMA integrity_check`**，不自己写校验和。文件级哈希能证明"没被改"，
//    但证明不了"SQLite 自己能打开"。客户要的是后者。
//
// 一个刻意不做的事：**导出不脱敏**。这是客户自己的数据，替客户"顺手脱敏"会让导出
// 变成不可信副本；需要脱敏的场景应当在读取侧做，而不是在导出时。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const EXPORT_SCHEMA_VERSION = 1;

const TABLES = [
  {
    name: "conversations",
    file: "conversations.jsonl",
    sql: `SELECT conversation_id, kind, name, agree_state, agree_at, first_msg_at, last_msg_at, msg_count, updated_at
            FROM archive_conversation ORDER BY conversation_id`,
    row: (r) => ({
      conversationId: r.conversation_id,
      kind: r.kind,
      name: r.name,
      agreeState: r.agree_state,
      agreeAt: Number(r.agree_at),
      firstMsgAt: r.first_msg_at ?? null,
      lastMsgAt: r.last_msg_at ?? null,
      msgCount: Number(r.msg_count),
      updatedAt: Number(r.updated_at),
    }),
  },
  {
    name: "participants",
    file: "participants.jsonl",
    sql: `SELECT conversation_id, user_id, role, display_name, first_seen_at, last_seen_at
            FROM archive_participant ORDER BY conversation_id, user_id`,
    row: (r) => ({
      conversationId: r.conversation_id,
      userId: r.user_id,
      role: r.role,
      displayName: r.display_name,
      firstSeenAt: r.first_seen_at ?? null,
      lastSeenAt: r.last_seen_at ?? null,
    }),
  },
  {
    name: "messages",
    file: "messages.jsonl",
    sql: `SELECT id, conversation_id, msg_id, seq, sent_at, sender, origin, msg_type, text, merge_key, ingested_at
            FROM archive_message ORDER BY id`,
    row: (r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      msgId: r.msg_id,
      seq: Number(r.seq),
      sentAt: Number(r.sent_at),
      sender: r.sender,
      origin: r.origin,
      msgType: r.msg_type,
      text: r.text,
      mergeKey: r.merge_key ?? null,
      ingestedAt: Number(r.ingested_at),
    }),
  },
  {
    name: "media",
    file: "media.jsonl",
    sql: `SELECT id, conversation_id, message_id, sdk_file_id, media_type, bytes, state, last_error, updated_at
            FROM archive_media ORDER BY id`,
    // sdk_file_id 是重取附件的唯一凭据，导出时必须带上，否则客户拿到的库里
    // 附件是"永远取不回来"的悬空引用。
    row: (r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      messageId: r.message_id,
      sdkFileId: r.sdk_file_id,
      mediaType: r.media_type,
      bytes: Number(r.bytes),
      state: r.state,
      lastError: r.last_error ?? null,
      updatedAt: Number(r.updated_at),
    }),
  },
  {
    name: "losses",
    file: "losses.jsonl",
    sql: `SELECT from_ts, to_ts, seats_json, detected_at FROM archive_loss ORDER BY from_ts`,
    row: (r) => ({
      fromTs: Number(r.from_ts),
      toTs: Number(r.to_ts),
      seats: JSON.parse(r.seats_json) || [],
      detectedAt: Number(r.detected_at),
    }),
  },
];

/** SQLite 自检。返回 `ok` 或具体错误文本。 */
export function integrityCheck(db) {
  try {
    const row = db.prepare("PRAGMA integrity_check").get();
    const value = row ? Object.values(row)[0] : null;
    return String(value || "unknown");
  } catch (err) {
    return `error: ${err?.message || String(err)}`;
  }
}

function writeJsonl(file, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(file, body ? `${body}\n` : "", "utf8");
  return body ? rows.length : 0;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * 导出到目录。
 *
 * 返回清单，调用方可直接把它当验收材料的一部分。
 */
export function exportArchive(db, { dir, now = Date.now() } = {}) {
  if (!dir) throw new Error("exportArchive 需要 dir");
  mkdirSync(dir, { recursive: true });

  const integrity = integrityCheck(db);
  const counts = {};
  const files = {};

  for (const t of TABLES) {
    const rows = db.prepare(t.sql).all().map(t.row);
    const file = path.join(dir, t.file);
    counts[t.name] = writeJsonl(file, rows);
    files[t.file] = { rows: counts[t.name], sha256: sha256(file) };
  }

  const cursor = db.prepare("SELECT * FROM archive_cursor WHERE id='default'").get();
  const manifest = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Number(now),
    // 这一行是给客户看的：导出时库本身是不是健康的
    integrity,
    counts,
    files,
    cursor: cursor
      ? {
          seq: Number(cursor.seq),
          lastCheckedAt: Number(cursor.last_checked_at),
          lastMessageAt: Number(cursor.last_msg_at),
        }
      : null,
    // 口径必须跟着数据一起走，否则客户拿到一份"看起来是全量"的库
    coverageNote:
      "本导出为存档通道的本地副本：只包含已入库的会话与消息；外部客户不同意的会话不在其中；" +
      "腾讯只保留 5 天，拉取中断造成的缺口不可补偿。不宣称覆盖全部历史。",
    format:
      "每行一个 JSON 对象（JSONL），按主键排序。无需本项目工具即可读取：sqlite3 / jq / 任意语言。",
  };
  writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/**
 * 从导出目录导回一个新库。
 *
 * 存在的唯一理由是**证明导出可用**：只有能导回去且条数一致，"客户拿得走"才算被验证过。
 * 不追求覆盖所有字段语义，只保证主键与计数忠实。
 */
export function importArchive(db, { dir } = {}) {
  if (!dir) throw new Error("importArchive 需要 dir");
  const read = (name) => {
    const file = path.join(dir, name);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  };

  const result = { conversations: 0, participants: 0, messages: 0, media: 0, losses: 0 };

  for (const c of read("conversations.jsonl")) {
    db.prepare(
      `INSERT OR REPLACE INTO archive_conversation
         (conversation_id, kind, name, agree_state, agree_at, first_msg_at, last_msg_at, msg_count, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      c.conversationId,
      c.kind ?? "unknown",
      c.name ?? "",
      c.agreeState ?? "unknown",
      Number(c.agreeAt || 0),
      c.firstMsgAt ?? null,
      c.lastMsgAt ?? null,
      Number(c.msgCount || 0),
      Number(c.updatedAt || Date.now()),
    );
    result.conversations += 1;
  }

  for (const p of read("participants.jsonl")) {
    db.prepare(
      `INSERT OR REPLACE INTO archive_participant
         (conversation_id, user_id, role, display_name, first_seen_at, last_seen_at)
       VALUES(?,?,?,?,?,?)`,
    ).run(
      p.conversationId,
      p.userId,
      p.role ?? "unknown",
      p.displayName ?? "",
      p.firstSeenAt ?? null,
      p.lastSeenAt ?? null,
    );
    result.participants += 1;
  }

  for (const m of read("messages.jsonl")) {
    db.prepare(
      `INSERT OR REPLACE INTO archive_message
         (id, conversation_id, msg_id, seq, sent_at, sender, origin, msg_type, text, raw_json, ingested_at, merge_key)
       VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?)`,
    ).run(
      m.id,
      m.conversationId,
      m.msgId,
      Number(m.seq || 0),
      Number(m.sentAt || 0),
      m.sender ?? "",
      m.origin ?? "unknown",
      m.msgType ?? "unknown",
      m.text ?? "",
      Number(m.ingestedAt || Date.now()),
      m.mergeKey ?? null,
    );
    result.messages += 1;
  }

  for (const md of read("media.jsonl")) {
    db.prepare(
      `INSERT OR REPLACE INTO archive_media
         (id, conversation_id, message_id, sdk_file_id, media_type, bytes, state, attempts, last_error, updated_at)
       VALUES(?,?,?,?,?,?,?,0,?,?)`,
    ).run(
      md.id,
      md.conversationId,
      md.messageId,
      md.sdkFileId,
      md.mediaType ?? "unknown",
      Number(md.bytes || 0),
      md.state ?? "pending",
      md.lastError ?? null,
      Number(md.updatedAt || Date.now()),
    );
    result.media += 1;
  }

  for (const l of read("losses.jsonl")) {
    db.prepare(
      "INSERT OR REPLACE INTO archive_loss(from_ts, to_ts, seats_json, detected_at) VALUES(?,?,?,?)",
    ).run(Number(l.fromTs), Number(l.toTs), JSON.stringify(l.seats || []), Number(l.detectedAt || 0));
    result.losses += 1;
  }

  return result;
}
