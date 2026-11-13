// ── 同意变更回调：`msg_audit_approved`（任务 3.2b）─────────────────────────
//
// 客户随时可以在微信里改"是否同意存档"。官方会把这个变化推成一条事件回到应用的
// 接收消息 URL，`Event=msg_audit_approved`，带着成员、外部联系人、群 id 与状态。
//
// 我们为什么必须有这条路径：同意状态有 5 分钟缓存（`createConsentCache`）。没有回调时，
// 客户点了"同意"，我们要等缓存过期才发现；客户点了"不同意"，我们要继续往库里写最多
// 5 分钟——后者是**合规问题**，不是延迟问题。所以回调的第一职责是**让缓存失效**。
//
// 三条设计取舍：
//
// 1. **回包字段名做多写法兼容，但绝不猜状态。** 官方文档在不同版本里对这几个字段的
//    拼写不一致（`UserID`/`Userid`、`OpenId`/`ExternalOpenId`/`ExteranalOpenId`），
//    这里全收；但 `Status` 认不出来时**只失效、不落库**——我们不拿"没看懂"当"同意"，
//    也不当"不同意"（后者会让客户的消息被静默丢弃）。下一次拉取会用官方接口重新问一次。
//
// 2. **认不出是哪个会话时，全清缓存。** 缓存 5 分钟就过期，全清的代价近乎为零；
//    而"认不出就什么都不做"会让一次同意变更被漏掉。宁可多问一次接口。
//
// 3. **落库的写入路径与接口查询共用 `upsertConversation`。** 那张 SQL 已经写了
//    "unknown 不得覆盖已有结论"，回调这边不需要再实现一遍规则。

import { normalizeAgreeStatus } from "./consent.js";
import { recordConsentEvent, upsertConversation } from "./store.js";

export const APPROVAL_EVENT = "msg_audit_approved";

/** 取一个 XML 字段，容忍 CDATA 与非 CDATA 两种写法，以及大小写差异。 */
function field(xml, ...names) {
  for (const name of names) {
    const re = new RegExp(`<${name}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${name}>`, "i");
    const m = re.exec(xml);
    if (m) return unescapeXml(m[1].trim());
  }
  return "";
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 官方两种表达都存在：`Status=1/0` 与 `AgreeStatus=Agree/Disagree`。 */
function statusOf(raw) {
  const v = String(raw ?? "").trim();
  if (v === "1") return "agree";
  if (v === "0") return "disagree";
  return normalizeAgreeStatus(v);
}

/**
 * 解析一条回调 XML（**明文**）。加密包由上层（网关 / adapter）先解密再交进来。
 *
 * @returns {{event:string, userId:string, openId:string, chatId:string,
 *            status:"agree"|"disagree"|"unknown", statusRaw:string,
 *            conversationId:string|null}}
 */
export function parseApprovalEvent(xml) {
  const text = String(xml ?? "");
  const userId = field(text, "UserID", "Userid", "UserId");
  const openId = field(text, "OpenId", "OpenID", "ExternalOpenId", "ExteranalOpenId");
  const chatId = field(text, "ChatId", "ChatID", "RoomId");
  const statusRaw = field(text, "Status", "AgreeStatus", "agree_status");

  let conversationId = null;
  if (chatId) conversationId = chatId;
  else if (userId && openId) conversationId = `dm:${[userId, openId].sort().join(":")}`;

  return {
    event: field(text, "Event"),
    userId,
    openId,
    chatId,
    statusRaw,
    status: statusOf(statusRaw),
    conversationId,
  };
}

/**
 * 应用一条回调：先失效缓存，能确定的才落库。
 *
 * @returns {{handled:boolean, reason?:string, event:string, conversationId:string|null,
 *            status:string, invalidated:"one"|"all"|"none", persisted:boolean}}
 */
export function applyApprovalEvent({ db = null, cache = null, xml = "", now = () => Date.now() } = {}) {
  const ev = parseApprovalEvent(xml);
  const base = {
    event: ev.event,
    conversationId: ev.conversationId,
    status: ev.status,
    invalidated: "none",
    persisted: false,
  };

  if (ev.event !== APPROVAL_EVENT) {
    // 其它事件（进入会话、通讯录变更……）不该被这条路径消费。只报"不是我的"，
    // 不做任何副作用——回调 URL 往往是全企业共用的。
    return { ...base, handled: false, reason: "not_approval_event" };
  }

  // 1) 失效优先：无论状态读没读懂，我们都不该继续用旧结论。
  if (cache) {
    if (ev.conversationId) {
      cache.invalidate(ev.conversationId);
      base.invalidated = "one";
    } else {
      cache.invalidate();
      base.invalidated = "all";
    }
  }
  if (db) {
    // 落一条跨进程水位：回调往往在另一个进程里（网关），内存缓存清不到拉取进程。
    // 认不出会话就记 '*', 让所有会话下一次都重新问一遍接口。
    recordConsentEvent(db, ev.conversationId || "*", now());
  }

  // 2) 状态读不懂 → 到此为止（不猜）。下一次拉取会重新问官方接口。
  if (ev.status === "unknown") {
    return { ...base, handled: false, reason: `unrecognized_status:${ev.statusRaw || "<missing>"}` };
  }

  // 3) 认不出会话 → 也无法落库；缓存已全清，够了。
  if (!ev.conversationId) {
    return { ...base, handled: false, reason: "unresolved_conversation" };
  }

  if (db) {
    const kind = ev.chatId ? "group" : "single";
    upsertConversation(db, {
      conversationId: ev.conversationId,
      kind,
      agreeState: ev.status,
      agreeAt: now(),
      updatedAt: now(),
    });
    base.persisted = true;
  }

  return { ...base, handled: true };
}
