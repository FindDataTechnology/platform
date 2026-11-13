// ── 微信客服：媒体拉取 ──────────────────────────────────────────────────────
//
// 为什么这件事必须单独一轮：正文入库很快也很便宜，媒体是 GET + 几十 MB 的下载。
// 混在一起会让"一条消息入库"变成可能失败的长事务，而客户真正要办的事往往就写在
// 那个 PDF 里（报价单、营业执照、合同）。所以正文先落地，附件后补。
//
// 三条纪律，与存档通道同构：
//   1. **媒体失败不回滚正文**——只改媒体自己的状态；
//   2. **先写文件，后标 done**——顺序反了会出现"状态 done、文件不存在"，而且因为
//      state='done' 不再重试，这个洞永远不会被自动补上；
//   3. **attempts 与 state 分离**——一次超时不判死，达到上限才 failed。
//
// 另有一条 kf 特有的：**JSON 当失败**。官方在媒体接口出错时返回 HTTP 200 + JSON，
// 把它当文件写下去会得到一个几百字节的"假图片"，状态还是 done。

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  pendingKfMedia,
  pendingKfExtractions,
  markKfMedia,
  markKfExtract,
  putKfAttachmentText,
  kfMediaCompletion,
} from "./store.js";
import { extractAttachment, sniffAttachmentKind } from "./extract.js";

/** 扩展名只用于人类识别，不参与任何校验。 */
const EXT_BY_TYPE = { image: "jpg", voice: "amr", video: "mp4", file: "bin" };

/**
 * 文件名只允许安全字符：media_id 来自服务端，但不能假设它不含路径分隔符。
 * 连续点也压掉——不是因为它能穿越（分隔符已经被替换），而是 `.._` 这类前缀
 * 在 `ls` 里会排在很前面，容易被误当目录。
 */
/**
 * 文件名必须**唯一**，且唯一性要来自不会被截断的位置。
 *
 * 真机踩到的坑（2026-11-12）：原来是 `${conversationId}__${messageId}` 然后
 * `slice(0, 120)`。但 messageId 本身以同一个 conversationId 开头
 * （`openKfId|externalUserid:uniquePart`），而 conversationId 有 65 字符，
 * 于是 120 字符刚好砍在重复前缀里——**唯一的尾巴被截掉了**。客户连发两个文件，
 * 第二个覆盖第一个，两条记录都是 state='done'，磁盘只剩一个文件。这是静默丢数据。
 *
 * 现在的取法：把"唯一的那段"放前面，长得不能再长的部分才交给哈希。
 *   - 会话：短哈希（10 位，够区分同一客服号下的不同客户）
 *   - 消息：冒号后的唯一尾巴（截到 40，正常都够）
 *   - 媒体：短哈希（8 位）——同一消息里多个附件也不会撞
 */
export function safeMediaName({ conversationId, messageId, mediaId, mediaType }) {
  const hash = (s, n) =>
    createHash("sha1").update(String(s ?? "")).digest("hex").slice(0, n);
  const tail = (s, n) =>
    String(s ?? "")
      .split(":")
      .pop()
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^[._]+/, "")
      .slice(0, n);

  const parts = [hash(conversationId, 10), tail(messageId, 40) || "msg"];
  if (mediaId) parts.push(hash(mediaId, 8));
  const base = parts.filter(Boolean).join("_").slice(0, 120) || "media";
  return `${base}.${EXT_BY_TYPE[mediaType] || "bin"}`;
}

/** 默认落盘器：写到 `<dir>/<safeName>`。测试注入自己的 writer，不碰磁盘。 */
export function fileWriter(dir) {
  return async (job) => {
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, safeMediaName(job));
    await writeFile(target, job.buffer);
    return target;
  };
}

/**
 * 跑一轮媒体拉取。
 *
 * @param {object} db
 * @param {{getMedia: Function}} client
 * @param {object} [opts]
 * @param {(job: {id, conversationId, messageId, mediaId, mediaType, buffer}) => Promise<string|void>} [opts.writer]
 * @param {number} [opts.limit]
 * @param {number} [opts.maxAttempts]
 */
/**
 * 自愈：把「状态 done 但文件已经不在盘上」的记录退回待拉取。
 *
 * 为什么需要（2026-11-12 实测发现）：媒体目录被清掉、或换了挂载点之后，
 * 这些行的 state 还是 done，于是永远不会重试——附件永久打不开，而库里看起来
 * 一切正常（ratio 还是 1）。这是"状态与文件脱耦"的另一半，跟"先写后标 done"
 * 是一对：那一半防的是"标了 done 文件没写成"，这一半防的是"文件后来没了"。
 *
 * 只在有 writer（即配了媒体目录）时才扫，且每轮有上限——扫全部 done 行在
 * 大库上是无谓开销。
 */
export function requeueMissingFiles(db, { limit = 50 } = {}) {
  const rows = db
    .prepare("select id, path from kf_media where state='done' order by updated_at asc limit ?")
    .all(limit);
  let requeued = 0;
  const setPending = db.prepare(
    "update kf_media set state='pending', attempts=0, last_error=? where id=?",
  );
  for (const r of rows) {
    const missing = !r.path || !existsSync(r.path);
    if (!missing) continue;
    setPending.run(r.path ? "file_missing" : "path_missing", r.id);
    requeued += 1;
  }
  return requeued;
}

/**
 * 抽取一份附件并落库，**永不抛**。
 *
 * 成败分两条线写：正文进 `kf_attachment_text`，状态进 `kf_media.extract_state`。
 * 下载状态（`state`/`bytes`/`path`）一个字节都不动——抽取失败不代表文件没取到，
 * 把 state 打回去会让下一轮重下一个已经落盘的文件。
 *
 * @returns {Promise<{ok:boolean, code?:string, kind:string, chars?:number, truncated?:boolean, reason?:string}>}
 */
export async function extractAndRecord(db, { messageId, buffer, fileNameHint = "", ...opts } = {}) {
  let sniffed = { kind: "unknown", reason: "未取到内容" };
  try {
    sniffed = sniffAttachmentKind({ buffer, fileNameHint });
    const res = await extractAttachment({ buffer, kind: sniffed.kind, fileNameHint, ...opts });
    if (res.ok) {
      putKfAttachmentText(db, {
        messageId,
        kind: res.kind,
        text: res.text,
        chars: res.chars,
        truncated: res.truncated,
      });
      markKfExtract(db, { id: messageId, state: "done", kind: res.kind });
      return { ok: true, kind: res.kind, chars: res.chars, truncated: res.truncated };
    }
    markKfExtract(db, { id: messageId, state: res.code, kind: res.kind, error: res.reason });
    return { ok: false, code: res.code, kind: res.kind, reason: res.reason };
  } catch (err) {
    // 走到这里说明连"记状态"都可能失败（例如库被锁）。仍然不抛：
    // 抽取是加值步骤，它绝不能把拉取轮次带崩。
    const reason = `${err?.name || "Error"}: ${err?.message || String(err)}`.slice(0, 300);
    try {
      markKfExtract(db, { id: messageId, state: "error", kind: sniffed.kind, error: reason });
    } catch {
      /* 状态都写不进去时，唯一正确的动作是继续 */
    }
    return { ok: false, code: "error", kind: sniffed.kind, reason };
  }
}

/**
 * 回填：把"已落盘、还没有正文"的附件补抽一遍。给升级后的存量用。
 *
 * 只读已有的文件，不发起任何下载——这是它与 `pullKfMedia` 的分界。
 *
 * @param {object} db
 * @param {{limit?:number, readFile?:Function}} [opts] `readFile` 仅测试注入
 */
export async function runKfExtractionBackfill(db, { limit = 20, readFile = null } = {}) {
  const { readFileSync } = await import("node:fs");
  const read = readFile || ((p) => readFileSync(p));
  const report = { attempted: 0, extracted: 0, failed: 0, skipped: 0, errors: [] };

  for (const job of pendingKfExtractions(db, limit)) {
    report.attempted += 1;
    let buffer;
    try {
      buffer = read(job.path);
    } catch (err) {
      // 文件没了：不是抽取的错。记 skipped，交给 media 的自愈去处理（它会退回 pending 重下）。
      report.skipped += 1;
      report.errors.push({ messageId: job.messageId, code: "file_missing", reason: String(err?.message || err) });
      continue;
    }
    const res = await extractAndRecord(db, {
      messageId: job.messageId,
      buffer,
      fileNameHint: job.path,
    });
    if (res.ok) report.extracted += 1;
    else {
      report.failed += 1;
      report.errors.push({ messageId: job.messageId, code: res.code, reason: res.reason });
    }
  }
  return report;
}

export async function pullKfMedia(db, client, opts = {}) {
  const { writer = null, limit = 20, maxAttempts = 3, voiceFormat = 0 } = opts;
  if (!client || typeof client.getMedia !== "function") {
    throw new Error("pullKfMedia 需要 client.getMedia");
  }

  const report = {
    attempted: 0,
    done: 0,
    failed: 0,
    retried: 0,
    requeued: 0,
    bytes: 0,
    extracted: 0,
    extractFailed: 0,
    extractErrors: [],
    errors: [],
  };

  // 自愈要在挑待拉取之前做，否则这一轮仍然看不见那些"done 但没文件"的行。
  if (writer) report.requeued = requeueMissingFiles(db, { limit });

  for (const job of pendingKfMedia(db, limit)) {
    report.attempted += 1;
    try {
      const part = await client.getMedia({ mediaId: job.mediaId, voiceFormat });
      if (!part || !Buffer.isBuffer(part.buffer)) {
        throw new Error("媒体响应不是二进制");
      }

      // 先写、后标 done
      let savedPath = null;
      if (writer) {
        savedPath = (await writer({ ...job, buffer: part.buffer })) || null;
      }

      markKfMedia(db, {
        id: job.id,
        state: "done",
        bytes: part.buffer.length,
        path: savedPath,
        attempts: job.attempts + 1,
        error: null,
      });
      report.done += 1;
      report.bytes += part.buffer.length;

      // 落盘之后同轮抽文本。抽取自己的失败**不得**影响上面那条 done：
      // 文件已经在盘上、消息已经入库，抽取只是加值。
      if (writer && savedPath) {
        const ex = await extractAndRecord(db, {
          messageId: job.messageId,
          buffer: part.buffer,
          fileNameHint: savedPath,
        });
        if (ex.ok) report.extracted += 1;
        else {
          report.extractFailed += 1;
          report.extractErrors.push({ messageId: job.messageId, code: ex.code, reason: ex.reason });
        }
      }
    } catch (err) {
      const attempts = job.attempts + 1;
      const terminal = attempts >= maxAttempts;
      markKfMedia(db, {
        id: job.id,
        state: terminal ? "failed" : "pending",
        attempts,
        error: `${err?.name || "Error"}: ${err?.message || String(err)}`.slice(0, 500),
      });
      if (terminal) report.failed += 1;
      else report.retried += 1;
      report.errors.push({
        mediaId: job.mediaId,
        state: terminal ? "failed" : "pending",
        attempts,
        message: err?.message || String(err),
      });
    }
  }

  return report;
}

export { kfMediaCompletion };
