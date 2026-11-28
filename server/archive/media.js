// ── 媒体分块拉取 ────────────────────────────────────────────────────────────
//
// 官方口径：`GetMediaData(sdkfileid, indexbuf)` 单次最多 512 KB，靠 `outIndexBuf`
// 往下翻，`is_finish` 表示这一块是最后一块。
//
// 三条设计：
//   1. **媒体失败不回滚正文**。正文早就入库了，这里只改媒体自己的状态；
//   2. **重试次数与状态分离**：`attempts` 累加，达到上限才转 `failed`，
//      不因为一次超时就把一段视频判死；
//   3. **落盘由调用方注入**。测试不碰磁盘，生产写文件/对象存储都行，
//      并且"写成功之后才标 done"——顺序反了会出现"状态 done、文件不存在"。

import { getMediaData } from "./sdk.js";
import { pendingMedia, upsertMedia } from "./store.js";

const toCamel = (row) => ({
  id: row.id,
  conversationId: row.conversation_id,
  messageId: row.message_id,
  sdkFileId: row.sdk_file_id,
  mediaType: row.media_type,
  bytes: Number(row.bytes || 0),
  state: row.state,
  attempts: Number(row.attempts || 0),
  lastError: row.last_error ?? null,
});

/**
 * 跑一轮媒体拉取。返回可对账的计数，不是一个模糊的"ok"。
 *
 * @param {object} db
 * @param {{call: Function}} driver
 * @param {object} [opts]
 * @param {(job: {mediaId: string, chunks: Buffer[], totalBytes: number}) => Promise<void>} [opts.writer]
 * @param {number} [opts.limit]        本轮最多处理几条
 * @param {number} [opts.maxAttempts]  超过即判 failed
 * @param {number} [opts.maxChunks]    单条最多翻几块（防止异常 helper 无限翻页）
 */
export async function pullMedia(db, driver, opts = {}) {
  const {
    writer = null,
    limit = 20,
    maxAttempts = 3,
    maxChunks = 256,
  } = opts;

  const report = { attempted: 0, done: 0, failed: 0, retried: 0, bytes: 0, errors: [] };
  const rows = pendingMedia(db, limit);

  for (const raw of rows) {
    const job = toCamel(raw);
    report.attempted += 1;
    const chunks = [];
    let total = 0;
    let indexBuf = "";

    try {
      let finished = false;
      for (let i = 0; i < maxChunks; i += 1) {
        const part = await getMediaData(driver, {
          sdkFileId: job.sdkFileId,
          indexBuf,
        });
        chunks.push(part.chunk);
        total += part.chunk.length;
        if (part.isFinish) {
          finished = true;
          break;
        }
        if (!part.outIndexBuf) {
          // 既没 finish 也没 next：这是协议状态矛盾，不能当"拉完了"
          throw new Error("media chunk 既未完成也未给出 outIndexBuf");
        }
        indexBuf = part.outIndexBuf;
      }
      if (!finished) {
        throw new Error(`超过单条分块上限 ${maxChunks}，判定为异常`);
      }

      // 先写、后标 done：顺序反了会出现"状态 done 但文件不存在"
      if (writer) {
        await writer({ mediaId: job.id, chunks, totalBytes: total });
      }

      upsertMedia(db, {
        ...job,
        bytes: total,
        state: "done",
        attempts: job.attempts + 1,
        lastError: null,
      });
      report.done += 1;
      report.bytes += total;
    } catch (err) {
      const attempts = job.attempts + 1;
      const terminal = attempts >= maxAttempts;
      upsertMedia(db, {
        ...job,
        state: terminal ? "failed" : "pending",
        attempts,
        lastError: `${err?.name || "Error"}: ${err?.message || String(err)}`,
      });
      if (terminal) report.failed += 1;
      else report.retried += 1;
      report.errors.push({
        mediaId: job.id,
        state: terminal ? "failed" : "pending",
        attempts,
        message: err?.message || String(err),
      });
    }
  }

  return report;
}

/** 媒体完成率——巡检面用。分母为 0 时返回 null，不返回 1（避免"空库显示 100%"）。 */
export function mediaCompletion(db) {
  const row = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN state='done' THEN 1 ELSE 0 END) done,
              SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) failed,
              SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) pending
         FROM archive_media`,
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
