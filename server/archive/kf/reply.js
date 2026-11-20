// ── 微信客服：回复 ──────────────────────────────────────────────────────────
//
// 这个模块只做一件事：把「回一条消息」这条路径上的三个坑一次堵掉。
//
// 1. **48 小时会话窗口**。客户最后一条消息之后 48 小时内才能回复，过了就发不出去。
//    这跟拉取的 3 天窗口是两个不同的窗口，混用会算错。判定放在本地，
//    是为了给出「还差几小时」这种能行动的信息，而不是让接口返回一个 errcode。
//
// 2. **自己的回复会从拉取里再回来一次**。发送接口返回 `msgid`，用同一个 id 先落库，
//    下一轮 `sync_msg` 拉到同一条时被 `INSERT OR IGNORE` 吃掉。不这么做，
//    每回复一次就在会话里出现两条（一条本地、一条拉取），而且两条时间戳不同。
//
// 3. **对外动作必须显式**。没有任何自动回复路径：函数要求显式给出客户与会话，
//    摄取循环不导入本模块。想让它自己发，得改代码，不是改配置。

import { createHash } from "node:crypto";

import { KF_SELF } from "./origin.js";
import { inspectUpload } from "./upload-guard.js";
import {
  insertKfMessage,
  refreshKfConversationStats,
  upsertKfConversation,
  getKfConversation,
} from "./store.js";

export const REPLY_WINDOW_HOURS = 48;
const REPLY_WINDOW_MS = REPLY_WINDOW_HOURS * 3_600_000;

/**
 * 回复窗口判定。`lastCustomerAt` 必须取**客户**最后一条消息，
 * 取最后一条消息（含我方）会让窗口永远不关——自己回一句就能续命，这是假绿。
 */
export function replyWindow({ lastCustomerAt, now = Date.now() }) {
  const last = Number(lastCustomerAt || 0);
  if (!last) {
    return { open: false, hoursLeft: 0, reason: "客户从未发言，没有可回复的会话" };
  }
  const elapsed = Number(now) - last;
  if (elapsed > REPLY_WINDOW_MS) {
    return {
      open: false,
      hoursLeft: 0,
      reason: `客户最后一条消息在 ${(elapsed / 3_600_000).toFixed(1)} 小时前，超过 ${REPLY_WINDOW_HOURS} 小时回复窗口`,
    };
  }
  return { open: true, hoursLeft: (REPLY_WINDOW_MS - elapsed) / 3_600_000, reason: "窗口内" };
}

/**
 * 发一条文本回复。
 *
 * 返回 `{ ok, reason?, msgId?, window }`。失败不抛异常——调用方通常是 agent 或运维脚本，
 * 需要的是"能不能回、为什么不能"，不是 stack trace。
 */
export async function sendReply({
  db,
  client,
  conversationId,
  openKfId = "",
  externalUserId = "",
  content,
  now = Date.now(),
} = {}) {
  if (!db) throw new Error("sendReply 需要 db");
  if (!client || typeof client.sendText !== "function") throw new Error("sendReply 需要 client.sendText");

  let convId = conversationId;
  let kfid = openKfId;
  let external = externalUserId;
  if (convId && (!kfid || !external)) {
    const conv = getKfConversation(db, convId);
    kfid = kfid || conv?.openKfId || "";
    external = external || conv?.externalUserId || "";
  }
  if (!convId) convId = `${kfid}|${external}`;

  const window = replyWindow({ lastCustomerAt: lastCustomerMessageAt(db, convId), now });
  if (!window.open) return { ok: false, reason: window.reason, window };

  let sent;
  try {
    sent = await client.sendText({ externalUserId: external, openKfId: kfid, content });
  } catch (err) {
    return { ok: false, reason: err?.message || String(err), errcode: err?.errcode ?? null, window };
  }

  // 用服务端 msgid 先落库：下一轮拉取到同一条会被幂等吃掉，不会重复。
  const msgId = sent?.msgId || `local-${now}`;
  upsertKfConversation(db, { conversationId: convId, openKfId: kfid, externalUserId: external });
  insertKfMessage(db, {
    id: `${convId}:${msgId}`,
    conversationId: convId,
    msgId,
    openKfId: kfid,
    externalUserId: external,
    sentAt: Number(now),
    origin: KF_SELF,
    msgType: "text",
    text: String(content ?? ""),
    ingestedAt: Number(now),
  });
  refreshKfConversationStats(db, convId);

  return { ok: true, msgId, window };
}

/** 客户最后一条消息时间。只看 `peer`，理由见 `replyWindow`。 */
export function lastCustomerMessageAt(db, conversationId) {
  const row = db
    .prepare(
      "SELECT MAX(sent_at) t FROM kf_message WHERE conversation_id=? AND origin='peer'",
    )
    .get(conversationId);
  const t = Number(row?.t || 0);
  return t > 0 ? t : 0;
}

// ── 文件回复（add-kf-file-reply）────────────────────────────────────────────

/**
 * media_id 的进程内缓存：`sha256(内容) + mediaType + openKfId` → `{ mediaId, at }`。
 *
 * **刻意不落库**：官方口径 media_id 只有 3 天有效期。库里躺一个看着有效、其实过期的 id，
 * 比"没有"更坏——重试时把它发出去，失败原因还指向客户/网络。进程重启即失效，
 * 代价只是重传一次，远小于把过期 id 当有效用的代价。
 */
const mediaCache = new Map();
/** TTL 取官方时效的一半：留出余量，避免"刚好过期"这种最难查的边界。 */
export const MEDIA_CACHE_TTL_MS = 36 * 60 * 60 * 1000;

function cacheKey({ digest, mediaType, openKfId }) {
  return `${digest}:${mediaType}:${openKfId}`;
}

/** 仅供测试：清空缓存，避免用例之间互相污染。 */
export function resetMediaCache() {
  mediaCache.clear();
}

/**
 * 发一份文件给客户。
 *
 * 与 `sendReply` 共用同一套窗口判定（`replyWindow` + `lastCustomerMessageAt`）——
 * 文件回复**不得**有更宽松的触发路径。上传与发送的失败分开报：
 * `uploaded:false` = 没发出去（要重传）；`uploaded:true, sent:false` = 只重发。
 */
export async function sendFileReply({
  db,
  client,
  conversationId,
  openKfId = "",
  externalUserId = "",
  filePath,
  allowedRoot = "",
  now = Date.now(),
} = {}) {
  if (!db) throw new Error("sendFileReply 需要 db");
  if (!client || typeof client.uploadMedia !== "function" || typeof client.sendFile !== "function") {
    throw new Error("sendFileReply 需要 client.uploadMedia 与 client.sendFile");
  }

  // 闸门在最早处：路径/体积/类型不过关就什么都不发，也不上传。
  const inspected = inspectUpload({ filePath, allowedRoot });
  if (!inspected.ok) return { ok: false, stage: "guard", reason: inspected.reason };

  let convId = conversationId;
  let kfid = openKfId;
  let external = externalUserId;
  if (convId && (!kfid || !external)) {
    const conv = getKfConversation(db, convId);
    kfid = kfid || conv?.openKfId || "";
    external = external || conv?.externalUserId || "";
  }
  if (!convId) convId = `${kfid}|${external}`;

  const window = replyWindow({ lastCustomerAt: lastCustomerMessageAt(db, convId), now });
  if (!window.open) {
    return { ok: false, stage: "window", reason: window.reason, window, uploaded: false, sent: false };
  }

  const digest = createHash("sha256").update(inspected.buffer).digest("hex");
  const key = cacheKey({ digest, mediaType: "file", openKfId: kfid });
  const hit = mediaCache.get(key);
  const usable = hit && Number(now) - hit.at < MEDIA_CACHE_TTL_MS;

  let mediaId = usable ? hit.mediaId : "";
  let uploaded = false;
  let reuploaded = false;

  const upload = async () => {
    const up = await client.uploadMedia({ mediaType: "file", fileName: inspected.name, buffer: inspected.buffer });
    mediaCache.set(key, { mediaId: up.mediaId, at: Number(now) });
    return up.mediaId;
  };

  if (!mediaId) {
    try {
      mediaId = await upload();
      uploaded = true;
    } catch (err) {
      return {
        ok: false,
        stage: "upload",
        reason: err?.message || String(err),
        errcode: err?.errcode ?? null,
        window,
        uploaded: false,
        sent: false,
      };
    }
  }

  const send = async (id) =>
    client.sendFile({ externalUserId: external, openKfId: kfid, mediaId: id });

  let sent;
  try {
    sent = await send(mediaId);
  } catch (err) {
    // 复用的 id 可能已过期：重传一次再发，且**必须**把这件事写进结果。
    // 不这么做就会把"id 过期"报成发送失败，调用方重试还会继续过期。
    if (!uploaded) {
      mediaCache.delete(key);
      try {
        mediaId = await upload();
        reuploaded = true;
        sent = await send(mediaId);
      } catch (err2) {
        return {
          ok: false,
          stage: "send",
          reason: err2?.message || String(err2),
          errcode: err2?.errcode ?? null,
          window,
          uploaded: reuploaded,
          reuploaded,
          sent: false,
        };
      }
    } else {
      return {
        ok: false,
        stage: "send",
        reason: err?.message || String(err),
        errcode: err?.errcode ?? null,
        window,
        uploaded,
        reuploaded: false,
        sent: false,
      };
    }
  }

  // 发送成功也要先落库（用服务端 msgid）：下一轮拉取回同一条时被幂等吃掉，
  // 与文本回复同一条纪律——否则每发一个文件，会话里就多一行。
  const msgId = sent?.msgId || `local-${now}`;
  upsertKfConversation(db, { conversationId: convId, openKfId: kfid, externalUserId: external });
  insertKfMessage(db, {
    id: `${convId}:${msgId}`,
    conversationId: convId,
    msgId,
    openKfId: kfid,
    externalUserId: external,
    sentAt: Number(now),
    origin: KF_SELF,
    msgType: "file",
    // 正文位置放文件名：检索时"发过一份报价单"比一行空文本有用，且不伪造文件内容。
    text: inspected.name,
    mediaType: "file",
    ingestedAt: Number(now),
  });
  refreshKfConversationStats(db, convId);

  return { ok: true, msgId, window, name: inspected.name, bytes: inspected.bytes, uploaded, reuploaded, sent: true };
}
