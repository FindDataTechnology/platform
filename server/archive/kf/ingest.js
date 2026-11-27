// ── 微信客服：摄取循环 ──────────────────────────────────────────────────────
//
// 五步，顺序不能换：
//
//   1. 读游标（文字游标 + 检查水位 + 数据水位）
//   2. 逐批 sync_msg（最多 maxBatches 批，防止一次占用太多配额）
//   3. 每批解析 → 客户占位 → 会话 upsert → 消息幂等入库
//   4. **消息落库之后**才写游标（顺序反了，写消息失败会永久跳过一段）
//   5. 客户资料单独一轮补全（失败不回滚消息）
//
// 两个守卫值得单说：
//   - `has_more=1` 且 `next_cursor` 没变 → 立即报错终止。否则每轮都"成功"、
//     都不推进、都烧配额，报表上却一片绿。
//   - 批次用尽但 `has_more` 仍为真 → 记一次截断（`truncations`）。
//     截断本身不是错误，但它意味着"这一轮没拉完"，巡检面必须看得见。

import { evaluateLag, MS_PER_DAY } from "../window.js";
import { filterForAgentInput } from "../consent.js";
import { mapOrigin, KF_SYSTEM } from "./origin.js";
import { toKfRow } from "./parse.js";
import {
  ensureKfSchema,
  readKfCursor,
  writeKfCursor,
  upsertKfConversation,
  refreshKfConversationStats,
  insertKfMessage,
  listKfMessages,
  queueKfMedia,
  ensureKfCustomer,
  pendingKfCustomers,
  markKfCustomer,
  upsertKfCustomer,
  getKfAttachmentText,
  getKfMediaExtractState,
} from "./store.js";

export const KF_WINDOW_DAYS = 3;
export const KF_WARN_DAYS = 2;

/**
 * 跑一轮拉取。
 *
 * 返回的报告是运维与测试的唯一事实来源：`pulled` 是服务端给了多少，
 * `inserted` 是真正新增多少（重放时这两个数会不同，这正是幂等生效的证据）。
 */
export async function runKfPullCycle({
  db,
  client,
  now = Date.now(),
  limit = 1000,
  maxBatches = 5,
  openKfId = "",
  cursorId = "default",
  syncCustomers = true,
  customerLimit = 100,
  windowDays = KF_WINDOW_DAYS,
} = {}) {
  if (!db) throw new Error("runKfPullCycle 需要 db");
  if (!client || typeof client.syncMsg !== "function") {
    throw new Error("runKfPullCycle 需要 client.syncMsg");
  }
  ensureKfSchema(db);

  // open_kfid 是官方必填项。没传就自动解析（只有一个账号时直接用），
  // 绝不臆造"不填就拉全部"——文档没有这种行为。
  let effectiveKfId = openKfId;
  if (!effectiveKfId && typeof client.resolveOpenKfId === "function") {
    const resolved = await client.resolveOpenKfId();
    if (!resolved.openKfId) {
      return {
        batches: 0,
        pulled: 0,
        inserted: 0,
        mediaQueued: 0,
        openKfId: "",
        errors: [{ stage: "config", message: resolved.reason || "无法确定 open_kfid" }],
        lag: null,
      };
    }
    effectiveKfId = resolved.openKfId;
  }
  if (!effectiveKfId) {
    return {
      batches: 0,
      pulled: 0,
      inserted: 0,
      mediaQueued: 0,
      openKfId: "",
      errors: [{ stage: "config", message: "缺少 open_kfid（官方必填）" }],
      lag: null,
    };
  }

  const startedAt = Number(now);
  const state = readKfCursor(db, cursorId);
  const report = {
    batches: 0,
    pulled: 0,
    inserted: 0,
    conversations: 0,
    systemEvents: 0,
    selfMessages: 0,
    peerMessages: 0,
    unknownOrigin: 0,
    mediaQueued: 0,
    openKfId: effectiveKfId,
    cursorBefore: state.cursor,
    cursorAfter: state.cursor,
    hasMore: false,
    truncated: false,
    historyFrom: state.historyFrom || null,
    customers: { requested: 0, updated: 0, failed: 0 },
    errors: [],
    lag: null,
  };

  // 首轮：3 天之前的历史永远拿不到，这个事实要落进数据，不能只写在文档里。
  let historyFrom = state.historyFrom || 0;
  if (!state.lastCheckedAt && !historyFrom) {
    historyFrom = startedAt - windowDays * MS_PER_DAY;
    report.historyFrom = historyFrom;
  }

  let cursor = state.cursor;
  let lastMessageSendAt = state.lastMessageAt;
  let hasMore = false;
  let truncations = 0;
  const touchedConversations = new Set();
  const seenCustomers = new Set();
  // 本轮是否真的从上游拿到过答复（哪怕 0 条）。只有它才推进"成功拉取水位"：
  // 失败时那个水位不动，滞后判定才能认出真断流；反之成功空拉必须推进，
  // 否则一个几天没人说话的客服号会被永久判成"不可补偿的丢失"。
  let syncOk = false;

  for (let i = 0; i < Math.max(1, maxBatches); i++) {
    const before = cursor;
    let res;
    try {
      res = await client.syncMsg({ cursor: before, openKfId: effectiveKfId, limit });
    } catch (err) {
      report.errors.push({
        stage: "sync_msg",
        name: err?.name || "Error",
        message: err?.message || String(err),
        errcode: err?.errcode ?? null,
      });
      hasMore = false;
      break;
    }
    syncOk = true;
    report.batches += 1;
    const messages = Array.isArray(res?.messages) ? res.messages : [];
    report.pulled += messages.length;

    // ── 3. 入库（先写数据，后写游标）────────────────────────────────────
    try {
      for (const raw of messages) {
        const origin = mapOrigin(raw?.origin);
        const externalUserId = String(
          raw?.external_userid || (origin === KF_SYSTEM ? "system" : ""),
        );
        const kfid = String(raw?.open_kfid || effectiveKfId || "");
        const row = toKfRow(raw, {
          openKfId: kfid,
          externalUserId,
          origin,
          now: startedAt,
        });

        if (origin === "peer") report.peerMessages += 1;
        else if (origin === "self") report.selfMessages += 1;
        else if (origin === "system") report.systemEvents += 1;
        else report.unknownOrigin += 1;

        if (externalUserId) {
          ensureKfCustomer(db, externalUserId);
          seenCustomers.add(externalUserId);
        }
        upsertKfConversation(db, {
          conversationId: row.conversationId,
          openKfId: kfid,
          externalUserId,
          name: "",
          updatedAt: startedAt,
        });
        const added = insertKfMessage(db, row);
        if (added) {
          report.inserted += 1;
          touchedConversations.add(row.conversationId);
        }
        // 附件入队（幂等）。正文已经在上面落地，这一步失败也不该拖垮整批。
        if (row.mediaId) {
          queueKfMedia(db, {
            id: row.id,
            messageId: row.id,
            conversationId: row.conversationId,
            mediaId: row.mediaId,
            mediaType: row.mediaType,
          });
          report.mediaQueued += 1;
        }
        if (row.sentAt > lastMessageSendAt) lastMessageSendAt = row.sentAt;
      }
    } catch (err) {
      // 写库失败：**不推进游标**。下一轮从同一位置重拉，靠幂等去重。
      report.errors.push({
        stage: "store",
        name: err?.name || "Error",
        message: err?.message || String(err),
      });
      hasMore = false;
      break;
    }

    const nextCursor = String(res?.nextCursor || "");
    hasMore = Boolean(res?.hasMore);

    // ── 4. 游标守卫 ────────────────────────────────────────────────────
    if (hasMore && (!nextCursor || nextCursor === before)) {
      report.errors.push({
        stage: "cursor",
        message: hasMore && !nextCursor
          ? "has_more=1 但未返回 next_cursor：游标无法推进，终止本轮回环"
          : "has_more=1 但 next_cursor 与请求值相同：继续循环只会重复拉同一批",
      });
      hasMore = false;
      break;
    }

    if (nextCursor && nextCursor !== before) {
      cursor = nextCursor;
      writeKfCursor(db, {
        id: cursorId,
        cursor,
        lastCheckedAt: startedAt,
        lastMessageAt: lastMessageSendAt,
        lastSuccessAt: startedAt,
        historyFrom,
        updatedAt: startedAt,
      });
    }

    if (!hasMore) break;
    if (i === Math.max(1, maxBatches) - 1) {
      // 批次用尽仍未拉完：记截断，让巡检面知道"这一轮没到底"。
      truncations += 1;
      report.truncated = true;
    }
  }

  // 没有新消息也要推进检查水位：断流期不推进，恢复后无法判断停了多久。
  // 成功水位只在这一轮真的拿到过上游答复时推进（syncOk）；失败时传 0，
  // writeKfCursor 的 MAX 会保留上一轮的值。
  writeKfCursor(db, {
    id: cursorId,
    cursor,
    lastCheckedAt: startedAt,
    lastMessageAt: lastMessageSendAt,
    lastSuccessAt: syncOk ? startedAt : 0,
    historyFrom,
    truncations,
    updatedAt: startedAt,
  });

  for (const convId of touchedConversations) refreshKfConversationStats(db, convId);
  report.conversations = touchedConversations.size;
  report.cursorAfter = readKfCursor(db, cursorId).cursor;
  report.hasMore = hasMore;

  // ── 5. 客户资料补全（独立一轮，失败不阻塞）─────────────────────────────
  if (syncCustomers && typeof client.getCustomers === "function") {
    const pending = pendingKfCustomers(db, customerLimit);
    if (pending.length) {
      report.customers.requested = pending.length;
      try {
        const { customers, invalid } = await client.getCustomers(pending);
        for (const c of customers) {
          upsertKfCustomer(db, c);
          report.customers.updated += 1;
        }
        for (const id of invalid) {
          markKfCustomer(db, { externalUserId: id, state: "failed", error: "invalid_external_userid" });
          report.customers.failed += 1;
        }
      } catch (err) {
        for (const id of pending) {
          markKfCustomer(db, {
            externalUserId: id,
            state: "failed",
            error: String(err?.message || err).slice(0, 200),
          });
        }
        report.customers.failed += pending.length;
        report.errors.push({
          stage: "customer",
          name: err?.name || "Error",
          message: err?.message || String(err),
          errcode: err?.errcode ?? null,
        });
      }
    }
  }

  report.lag = evaluateLag({
    lastMessageAt: lastMessageSendAt,
    lastCheckedAt: startedAt,
    lastSuccessAt: readKfCursor(db, cursorId).lastSuccessAt,
    now: startedAt,
    warnDays: KF_WARN_DAYS,
    hardLimitDays: windowDays,
  });

  return report;
}

/**
 * 取「可以喂给 agent」的消息。
 *
 * 复用存档通道的 `filterForAgentInput`：只有 `peer` 留下。
 * kf 这里系统事件特别多（进入会话、会话结束、撤回、接待人员变更），
 * 不过滤就会让 agent 对着"客户已进入会话"写一段回答。
 *
 * 附件另算：kf 的 `file` 消息正文是空串（`parse.js` 里写明官方不给文件名），
 * 所以客户发来一份报价单，不补附件正文的话 agent 看到的是一条**空消息**。
 * 这里给带附件的消息补上 `attachment`，并**如实说明状态**——没抽出来就说没抽出来，
 * 不能伪装成"客户什么都没说"。
 */
export const AGENT_ATTACHMENT_MAX_CHARS = 4000;

export function kfAgentInput(
  db,
  { conversationId, limit = 50, attachmentMaxChars = AGENT_ATTACHMENT_MAX_CHARS } = {},
) {
  const rows = listKfMessages(db, { conversationId, limit: Math.min(400, limit * 3) });
  const { kept, dropped } = filterForAgentInput(rows);
  const messages = kept.slice(0, limit).map((msg) => withAttachment(db, msg, attachmentMaxChars));
  return { messages, dropped };
}

/** 给单条消息挂上附件正文（有界）。无附件的消息原样返回。 */
function withAttachment(db, msg, maxChars) {
  if (!msg.mediaId && !msg.mediaType) return msg;

  const stored = getKfAttachmentText(db, msg.id);
  if (stored) {
    const cap = Math.max(1, Number(maxChars) || AGENT_ATTACHMENT_MAX_CHARS);
    const truncated = stored.text.length > cap;
    return {
      ...msg,
      attachment: {
        status: "extracted",
        kind: stored.kind,
        chars: stored.chars || stored.text.length,
        truncated: truncated || stored.truncated,
        text: truncated ? stored.text.slice(0, cap) : stored.text,
      },
    };
  }

  const media = getKfMediaExtractState(db, msg.id);
  return {
    ...msg,
    attachment: {
      status: media?.extractState || "not_extracted",
      kind: media?.kind || null,
      reason: media?.extractError || null,
    },
  };
}
