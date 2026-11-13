// ── 微信客服：消息体归一化 ──────────────────────────────────────────────────
//
// 目标只有一个：让检索面和 agent 输入拿到**人能读的正文**，并且明确标出哪些是媒体待补。
//
// 一条设计取舍：所有类型都产生非空 `text`。
// 早先在存档通道踩过——把文件名/链接标题留在 payload 里不写进正文，结果站内搜索
// "报销制度"搜不到那份 PDF，因为正文是空的。这类空正文在报表上只表现为"召回偏低"，
// 不会指向根因。所以这里宁可写 `[文件]` 占位，也不留空。

const MEDIA_TYPES = new Set(["image", "voice", "video", "file"]);

/** 媒体验收要用的类型名；非媒体返回 null。 */
export function mediaTypeOf(msgType) {
  return MEDIA_TYPES.has(msgType) ? msgType : null;
}

/** 各类型里承载媒体 id 的字段。kf 统一叫 `media_id`，但按类型分开取值更稳。 */
export function mediaIdOf(msg) {
  if (!msg) return null;
  for (const key of ["image", "voice", "video", "file"]) {
    const id = msg[key]?.media_id;
    if (id) return String(id);
  }
  return null;
}

function joinParts(parts) {
  return parts.filter((p) => p !== undefined && p !== null && String(p).trim() !== "").join(" ");
}

/**
 * 归一化一条 kf 消息。
 *
 * 返回 `{ msgType, text, mediaId, mediaType, eventType, known }`。
 * `known=false` 的类型仍然入库（保留 `raw`），只是正文是占位——
 * 丢掉它们会让"客户到底发了什么"变成黑洞，留着至少能人工回看。
 */
export function parseKfMessage(msg) {
  const msgType = String(msg?.msgtype || "unknown");
  const mediaId = mediaIdOf(msg);

  let text = "";
  let eventType = null;

  switch (msgType) {
    case "text":
      text = String(msg.text?.content ?? "");
      break;

    case "image":
      text = "[图片]";
      break;

    case "voice":
      text = "[语音]";
      break;

    case "video":
      text = "[视频]";
      break;

    case "file":
      // kf 的 file 结构只有 media_id，没有 name（这点跟存档不同），不要假装有。
      text = "[文件]";
      break;

    case "location": {
      const loc = msg.location || {};
      text = joinParts([
        "[位置]",
        loc.name,
        loc.address,
        loc.latitude && loc.longitude ? `${loc.latitude},${loc.longitude}` : null,
      ]);
      break;
    }

    case "link": {
      const l = msg.link || {};
      text = joinParts(["[链接]", l.title, l.desc, l.url]);
      break;
    }

    case "business_card": {
      const b = msg.business_card || {};
      text = joinParts(["[名片]", b.userid || b.corpid]);
      break;
    }

    case "miniprogram": {
      const m = msg.miniprogram || {};
      text = joinParts(["[小程序]", m.title, m.appid, m.page]);
      break;
    }

    case "msgmenu": {
      const m = msg.msgmenu || {};
      text = joinParts(["[菜单]", m.content, m.head_content]);
      break;
    }

    case "event": {
      // 系统事件：入库、可审计，但不作为 agent 输入（origin 已判为 system）。
      eventType = String(msg.event?.event_type || "");
      text = joinParts(["[事件]", eventType]);
      break;
    }

    case "channels":
    case "channels_shop_product":
    case "channels_shop_order":
      text = `[视频号] ${msgType}`;
      break;

    default:
      text = `[${msgType}]`;
      break;
  }

  const known = !(msgType === "unknown" || text === `[${msgType}]` && msgType !== "unknown");
  return {
    msgType,
    text: text || `[${msgType}]`,
    mediaId,
    mediaType: mediaTypeOf(msgType),
    eventType,
    known,
  };
}

/**
 * 归一化后的消息 → 可直接入库的行。
 *
 * `id` 用 `<会话ID>:<msgid>`：官方 msgid 在企业内唯一，但跨通道/跨客服号可能重复，
 * 带上会话前缀才能保证主键真的唯一。
 */
export function toKfRow(msg, { openKfId, externalUserId, origin, now = Date.now() } = {}) {
  const parsed = parseKfMessage(msg);
  const conv = `${openKfId || msg?.open_kfid || ""}|${externalUserId || msg?.external_userid || ""}`;
  const msgId = String(msg?.msgid || "");
  const sendTime = Number(msg?.send_time || 0);
  return {
    id: `${conv}:${msgId}`,
    conversationId: conv,
    msgId,
    openKfId: openKfId || String(msg?.open_kfid || ""),
    externalUserId: externalUserId || String(msg?.external_userid || ""),
    servicerUserId: String(msg?.servicer_userid || ""),
    sentAt: sendTime > 0 ? sendTime * 1000 : Number(now),
    origin,
    msgType: parsed.msgType,
    text: parsed.text,
    mediaId: parsed.mediaId,
    mediaType: parsed.mediaType,
    eventType: parsed.eventType,
    rawJson: JSON.stringify(msg ?? {}),
    ingestedAt: Number(now),
  };
}
