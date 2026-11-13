// ── kf 通道的只读 HTTP 面 ───────────────────────────────────────────────────
//
// 挂载点：`/api/archive/kf`（见 server.js）。
//
// **只有 GET**，这是刻意的。拉取与回复都不在这里：
//   - 拉取会发起对腾讯的外部请求，挂在 GET 上等于"读一下就产生副作用"；
//   - 回复是对真实客户的对外动作，必须显式（CLI 的 `reply --confirm`），
//     不能因为某个页面刷新一下就发出去。
// 所以这里只回答问题，不改世界。拉取由 CLI 或后续调度器驱动。
//
// 另一个刻意的选择：**请求路径里不做网络调用**。诊断要取票、要打 account/list，
// 放进 HTTP 会让页面卡十几秒并放大失败面；诊断留在 CLI 的 `doctor`。

import { Router } from "express";

import { getKfDatabase } from "./db.js";
import { kfInbox } from "./inbox.js";
import { replyWindow } from "./reply.js";
import {
  ensureKfSchema,
  getKfAttachmentText,
  getKfConversation,
  getKfMediaExtractState,
  kfCoverageReport,
  kfExtractionCompletion,
  kfMediaCompletion,
  listKfMessages,
  searchKfMessages,
} from "./store.js";
import { KF_ROUTE_LIMITS } from "./db.js";

function clamp(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function splitOrigins(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {import("express").Express} app
 * @param {{ getKfDb?: () => object }} [ctx]
 */
export function createKfRoutes(app, ctx = {}) {
  const getDb = ctx.getKfDb || getKfDatabase;
  const router = Router();

  /** 任何 store 异常都变成可读的 500，而不是把进程带走。 */
  const guard = (fn) => (req, res) => {
    try {
      const db = getDb();
      ensureKfSchema(db);
      const { status = 200, ...body } = fn(db, req) || {};
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  };

  router.get("/coverage", guard((db) => ({ ok: true, ...kfCoverageReport(db) })));

  router.get(
    "/inbox",
    guard((db, req) => ({
      ok: true,
      ...kfInbox(db, { limit: clamp(req.query.limit, KF_ROUTE_LIMITS.inbox, 200) }),
    })),
  );

  router.get(
    "/conversations",
    guard((db, req) => {
      const limit = clamp(req.query.limit, KF_ROUTE_LIMITS.conversations, 200);
      const rows = db
        .prepare("SELECT * FROM kf_conversation ORDER BY last_msg_at DESC LIMIT ?")
        .all(limit);
      return {
        ok: true,
        conversations: rows.map((r) => ({
          conversationId: r.conversation_id,
          openKfId: r.open_kfid,
          externalUserId: r.external_userid,
          name: r.name,
          msgCount: Number(r.msg_count || 0),
          firstMsgAt: r.first_msg_at ?? null,
          lastMsgAt: r.last_msg_at ?? null,
          // 顺手把"还能不能回"算出来：消费侧不必自己再算一遍 48 小时
          replyWindow: replyWindow({ lastCustomerAt: lastPeerAt(db, r.conversation_id) }),
        })),
      };
    }),
  );

  router.get(
    "/messages",
    guard((db, req) => {
      const conversationId = String(req.query.conversationId || "");
      if (!conversationId) return { ok: false, status: 400, error: "缺少 conversationId" };
      const limit = clamp(req.query.limit, KF_ROUTE_LIMITS.messages, 500);
      const origins = splitOrigins(req.query.origin);
      return {
        ok: true,
        conversation: getKfConversation(db, conversationId),
        messages: listKfMessages(db, {
          conversationId,
          limit,
          origins: origins.length ? origins : null,
        }),
      };
    }),
  );

  router.get(
    "/search",
    guard((db, req) => {
      const q = String(req.query.q || "").trim();
      const limit = clamp(req.query.limit, KF_ROUTE_LIMITS.search, 200);
      const origins = splitOrigins(req.query.origin);
      return {
        ok: true,
        query: q,
        // 默认只搜客户发言：这是"商机/客服"视角下最常要的。
        // 要连自己的回复一起看，传 origin=peer,self
        messages: searchKfMessages(db, {
          query: q,
          limit,
          origins: origins.length ? origins : ["peer"],
        }),
      };
    }),
  );

  router.get(
    "/attachment",
    guard((db, req) => {
      const messageId = String(req.query.messageId || "").trim();
      if (!messageId) return { ok: false, status: 400, error: "缺少 messageId" };

      const stored = getKfAttachmentText(db, messageId);
      if (stored) {
        const maxChars = clamp(req.query.maxChars, 20000, 20000);
        const text = stored.text.length > maxChars ? stored.text.slice(0, maxChars) : stored.text;
        return {
          ok: true,
          messageId,
          kind: stored.kind,
          chars: stored.chars,
          truncated: stored.truncated || text.length < stored.text.length,
          text,
        };
      }

      // 没正文要说清是哪一种：压根没附件 / 还没落盘 / 落盘了没抽出来。
      // 一律回 200 带空串会让调用方以为"客户发了个空文件"。
      const media = getKfMediaExtractState(db, messageId);
      if (!media) {
        return { ok: false, status: 404, error: "这条消息没有附件记录", messageId };
      }
      return {
        ok: false,
        status: 200,
        messageId,
        state: media.extractState || (media.state === "pending" ? "not_downloaded" : "not_extracted"),
        kind: media.kind,
        reason: media.extractError || null,
      };
    }),
  );

  router.get("/media", guard((db) => ({ ok: true, ...kfMediaCompletion(db), extraction: kfExtractionCompletion(db) })));

  /**
   * 调度状态：最后一轮什么时候跑的、成没成、连续失败几次。
   *
   * 这条接口存在的理由：kf 只保留 3 天，拉取器停了就等于开始丢数据。
   * 而"停了"不会自己报错——没有这条读面，只能靠人去翻日志。
   */
  router.get("/sync-status", (_req, res) => {
    try {
      const status = ctx.kfSyncStatus ? ctx.kfSyncStatus() : null;
      res.json({ ok: true, scheduler: status, note: status ? undefined : "未接线调度器" });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.use("/api/archive/kf", router);
}

function lastPeerAt(db, conversationId) {
  const row = db
    .prepare("SELECT MAX(sent_at) t FROM kf_message WHERE conversation_id=? AND origin='peer'")
    .get(conversationId);
  return Number(row?.t || 0) || 0;
}
