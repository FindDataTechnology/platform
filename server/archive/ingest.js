// ── Archive ingest cycle ────────────────────────────────────────────────────
//
// 把一个拉取周期要做的五件事按固定顺序串起来，每一件都能单独注入桩：
//
//   1. 取同意状态（缓存优先）→ 不同意就不入库（不是入库后删）
//   2. 拉一批（seq 游标，limit ≤1000）
//   3. 逐条解密 → 判 origin（本方/bot 自身不许进 agent 输入）
//   4. 归一化入库（幂等；媒体另立 pending 队列，失败不阻塞正文）
//   5. 推进游标（只增不减；断流也推进"检查时间"）
//
// 为什么循环要写成可注入：真 SDK 与真席位都不在手边。用桩驱动跑通整条链，
// 比等环境到位再验证更早暴露"顺序错了/游标在失败时被推进了"这类问题。

import { getChatData, decryptMessage, classify } from "./sdk.js";
import { advanceCursor, evaluateLag, recordLoss } from "./window.js";
import { admitByConsent, classifyOrigin, mergeKey, normalizeAgreeStatus } from "./consent.js";
import { parseMessage } from "./parse.js";
import {
  appendLoss,
  getAgreeState,
  insertMessage,
  findByMergeKey,
  readCursor,
  refreshConversationStats,
  upsertConversation,
  upsertMedia,
  upsertParticipant,
  writeCursor,
} from "./store.js";

/** 从官方原始报文里取会话标识。群用 roomid/chatid，单聊用对方 id。 */
export function conversationIdOf(payload = {}) {
  const room = payload.roomid || payload.chatid || payload.room_id;
  if (room) return String(room);
  const from = String(payload.from || "");
  const toList = payload.tolist || payload.to_list || [];
  const to = Array.isArray(toList) ? String(toList[0] || "") : "";
  // 单聊：把两端排序后拼起来，保证两侧视角得到同一个键
  const pair = [from, to].filter(Boolean).sort();
  return pair.length === 2 ? `dm:${pair[0]}:${pair[1]}` : `dm:${from}`;
}

/**
 * 归一化一条官方消息。
 *
 * `msgType` 保留原始类型字符串（text/image/voice/…），未识别的落 `unknown` 并保留 raw：
 * 官方会新增类型，解析器不应因为"没见过"而丢消息。
 */
export function normalizeMessage(payload, { conversationId, seq, origin, ingestedAt, parsed }) {
  const msgId = String(payload.msgid || payload.msg_id || "");
  const sentAt = Number(payload.msgtime || payload.msg_time || 0);
  // 正文与媒体一律走 parse.js：官方把 sdkfileid 嵌在 image/voice/file 里，
  // 顶层没有这个字段。早先这里读顶层，结果媒体永远进不了队列。
  const p = parsed || parseMessage(payload);
  const msgType = String(payload.msgtype || payload.msg_type || p.msgType || "unknown");
  const text = p.text ?? "";
  return {
    id: `${conversationId}:${msgId}`,
    conversationId,
    msgId,
    seq: Number(seq || 0),
    sentAt,
    sender: String(payload.from || ""),
    origin,
    msgType,
    text: typeof text === "string" ? text : "",
    rawJson: JSON.stringify(payload),
    ingestedAt: ingestedAt || Date.now(),
    mergeKey: mergeKey({
      conversationId,
      tsSeconds: Math.floor(sentAt / 1000),
      sender: String(payload.from || ""),
      textDigest: digest(typeof text === "string" ? text : ""),
    }),
  };
}

/** 简单摘要：只为归并去重服务，不做安全用途。 */
export function digest(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * 跑一个拉取周期。
 *
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.driver            SDK driver（stub 或 stdio）
 * @param {(convId: string) => Promise<string>} [deps.queryConsent]
 *        官方 check_single_agree / check_room_agree 的包装；缺省则读库里已有状态
 * @param {string[]} [deps.selfUserIds]   本方成员 userid（判 origin 用）
 * @param {number} [deps.now]
 * @param {number} [deps.limit]
 */
export async function runPullCycle(deps) {
  const {
    db,
    driver,
    queryConsent,
    selfUserIds = [],
    now = Date.now(),
    limit = 1000,
    consentCache,
    maxBatches = 10,
  } = deps;

  const state = readCursor(db);
  // 拉取**之前**的滞后。丢失判定必须用它，不能用循环结束后的 cursor：
  // 整机停摆 6 天后重启，第一轮就拉成功，成功水位会被推到 now，
  // 之后算出来的滞后永远是 ok —— 那 6 天缺口一个字都不进账，等于被"恢复成功"洗白。
  //
  // 水位是「最后一次成功拉取」：失败不推进（真断流要进账），成功空拉推进
  // （上游答复过"没有新的"，安静不算丢失）。
  const lagBeforePull = evaluateLag({
    lastMessageAt: state.lastMessageAt,
    lastCheckedAt: state.lastCheckedAt,
    lastSuccessAt: state.lastSuccessAt,
    now,
  });
  const report = {
    batches: 0,
    pulled: 0,
    admitted: 0,
    rejectedConsent: 0,
    rejectedOrigin: 0,
    duplicates: 0,
    mediaQueued: 0,
    cursorFrom: state.seq,
    cursorTo: state.seq,
    lag: null,
    lagBeforePull,
    errors: [],
  };

  let cursor = state;
  let batches = 0;

  while (batches < maxBatches) {
    let batch;
    try {
      batch = await getChatData(driver, { seq: cursor.seq, limit });
    } catch (err) {
      // 拉取失败：**不推进游标、也不推进成功水位**，只推进检查时间（证明"我们试过"）。
      report.errors.push({ stage: "pull", name: err?.name, message: err?.message });
      cursor = advanceCursor(cursor, { seq: cursor.seq, now, pulled: 0, success: false });
      writeCursor(db, cursor);
      break;
    }

    batches += 1;
    report.batches = batches;
    report.pulled += batch.messages.length;

    for (const payload of batch.messages) {
      // 1) 先解密。
      //
      // **顺序不能反过来**：官方 GetChatData 返回的外层只有
      // `msgid / seq / publickey_ver / encrypt_random_key / encrypt_chat_msg`，
      // `roomid` 与 `from` 都在**密文里**。所以"先算会话标识、再问同意"根本算不出来，
      // `conversationIdOf(payload)` 会恒等于 `"dm:"`，同意闸门对每条消息都判
      // 「无法确定会话」→ **全量静默丢弃**，而报告只显示"本轮 0 条入库"。
      // 这条被演练抓出来之前，测试夹具把 from/roomid 也放在外层，把洞盖住了。
      let plain = "";
      try {
        plain = await decryptMessage(driver, {
          encryptRandomKey: payload.encrypt_random_key,
          encryptChatMsg: payload.encrypt_chat_msg,
          seq: cursor.seq,
        });
      } catch (err) {
        report.errors.push({
          stage: "decrypt",
          msgId: payload.msgid,
          name: err?.name,
          message: err?.message,
        });
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(plain);
      } catch {
        report.errors.push({ stage: "parse", msgId: payload.msgid, message: "解密结果不是 JSON" });
        continue;
      }
      if (!parsed?.msgid) parsed.msgid = payload.msgid;

      // 2) 会话标识：解密之后才算得出来。
      const conversationId = conversationIdOf(parsed);
      if (!conversationId || conversationId === "dm:") {
        // 解出来仍认不出会话（from 与 roomid 都缺）：这是报文形状问题，不是"客户不同意"。
        // 明说并跳过——按未同意处理会让这类消息被当成合规原因丢掉，查都没法查。
        report.errors.push({
          stage: "resolve",
          msgId: payload.msgid,
          message: "解密后仍无会话标识（roomid / from 都缺）",
        });
        continue;
      }

      // 3) 同意闸门：不同意/未知都不入库。
      //    缓存策略**不在这里做**：由提供 queryConsent 的一方负责。原因很具体——
      //    同意变更回调落在另一个进程，清不掉这里的缓存；resolver 命中缓存前必须
      //    先比对回调水位。这里若先查缓存，就把那条失效路径短路了（客户撤回同意后
      //    我们还会继续写满一个 TTL）。
      const consent = queryConsent
        ? await queryConsent(conversationId)
        : (consentCache?.get(conversationId) ?? getAgreeState(db, conversationId));
      if (consentCache && !queryConsent && consent) consentCache.set(conversationId, consent);
      const gate = admitByConsent(consent);
      if (!gate.admit) {
        report.rejectedConsent += 1;
        continue;
      }

      // 4) 解析（msgtype 插件）+ origin：本方与 unknown 不入 agent 输入
      const parsedMsg = parseMessage(parsed);
      const origin = classifyOrigin({ from: parsed.from, memberUserIds: selfUserIds });
      if (origin !== "peer") report.rejectedOrigin += 1;

      const msg = normalizeMessage(parsed, {
        conversationId,
        seq: cursor.seq,
        origin,
        ingestedAt: now,
        parsed: parsedMsg,
      });

      // 5) 归并去重：另一通道可能已经落了同一条
      if (findByMergeKey(db, msg.mergeKey)) {
        report.duplicates += 1;
        continue;
      }

      const inserted = insertMessage(db, msg);
      if (!inserted) {
        report.duplicates += 1;
        continue;
      }
      report.admitted += 1;

      upsertConversation(db, {
        conversationId,
        kind: String(parsed.roomid ? "group" : "single"),
        name: parsed.roomname || "",
        agreeState: normalizeAgreeStatus(consent),
        agreeAt: now,
        updatedAt: now,
      });
      upsertParticipant(db, {
        conversationId,
        userId: String(parsed.from || ""),
        role: origin === "self" ? "member" : "external",
        at: msg.sentAt,
      });
      refreshConversationStats(db, conversationId);

      // 5) 媒体独立队列：失败不影响正文
      const media = parsedMsg.media;
      if (media?.sdkFileId) {
        upsertMedia(db, {
          id: `${msg.id}:${media.sdkFileId}`,
          conversationId,
          messageId: msg.id,
          sdkFileId: media.sdkFileId,
          mediaType: media.mediaType || parsed.msgtype || "unknown",
          bytes: Number(media.bytes || 0),
          state: "pending",
        });
        report.mediaQueued += 1;
      }
    }

    // 批次推进：只增不减。这一批没有异常 ⇒ 成功水位前进（空批次也算：上游答复过）。
    const before = cursor.seq;
    cursor = advanceCursor(cursor, {
      seq: batch.seq,
      now,
      pulled: batch.messages.length,
      success: true,
    });
    writeCursor(db, cursor);
    report.cursorTo = cursor.seq;

    // 游标停滞闸：批次非空但游标没动 = 协议异常（例如消息里缺 seq）。
    // 不设这道闸会**无限重复拉同一批**，而且每一轮都"成功"——最坏的一种静默故障：
    // 日志全是 200，数据一条没多，CPU 一直烧。
    if (batch.messages.length > 0 && cursor.seq === before) {
      report.errors.push({
        stage: "cursor",
        message: "批次非空但游标未前进（消息缺 seq 或 helper 未回游标），已停止本轮以避免重复拉取",
        messagesInBatch: batch.messages.length,
      });
      break;
    }

    // 拉空即停：官方在没有新消息时返回空批次
    if (batch.messages.length === 0) break;
    if (batch.seq === state.seq && batches > 0 && batch.messages.length < limit) break;
  }

  report.lag = evaluateLag({
    lastMessageAt: cursor.lastMessageAt,
    lastCheckedAt: cursor.lastCheckedAt,
    lastSuccessAt: cursor.lastSuccessAt,
    now,
  });

  // 滞后超窗口 → 记一笔不可补偿的丢失（只 append）。
  //
  // 判据取「拉取前」与「拉取后」的**并集**：
  //   • 拉取前就 lost：说明这一轮之前已经断了超过保留窗口。哪怕这一轮拉成功
  //     （水位跳到 now、滞后显示 ok），缺口也必须进账——否则整机停摆 6 天后
  //     重启即成功，账面会干干净净。
  //   • 拉取后仍 lost：这一轮没拉成（失败或空批次同时断了成功水位），按当时水位同样记一笔。
  //
  // 缺口起点取「最后一次成功拉取的时刻」：那是我们最后一次确知"上游答复过、没有遗漏"的点。
  const lostDetected = lagBeforePull.level === "lost" || report.lag.level === "lost";
  if (lostDetected) {
    const from = Number(state.lastSuccessAt || state.lastMessageAt || 0);
    if (from > 0) {
      appendLoss(db, { fromTs: from, toTs: now, detectedAt: now });
    }
  }

  return report;
}

export { classify, recordLoss };
