// ── Consent gate & origin tagging ───────────────────────────────────────────
//
// 两条"看起来该是数据状态、其实必须前置"的规则：
//
// 1. **不同意就不存在**。外部客户逐会话选择是否同意存档（官方 `check_single_agree` /
//    `check_room_agree` 返回 `agree_status ∈ {Agree, Disagree}`）。`Disagree` 的消息
//    MUST NOT 入库——不是入库后标记删除。先存后删会留残留：备份、全文索引、缩略图缓存、
//    日志。这类残留比"少存一条"严重得多。
//
// 2. **本方发言必须能识别**。存档里既有对方消息，也有本方员工与 **bot 自己**发出的回复。
//    不标 origin，消费侧就会把 agent 自己的回复当成新的用户输入再答一遍——自问自答闭环。
//    症状是"答非所问/重复"，不会指向根因，所以必须在入库时打标。

export const ORIGIN_SELF = "self";
export const ORIGIN_PEER = "peer";

/** 官方状态值的大小写并不统一，这里一次收敛，避免下游各自比对。 */
export function normalizeAgreeStatus(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "agree") return "agree";
  if (v === "disagree") return "disagree";
  return "unknown";
}

/**
 * 入库前判定。返回 `{ admit, reason }`。
 *
 * 注意 `unknown` 的处理：**不放行**。查询失败 / 未返回时按"未同意"处理，
 * 宁可少存也不越权。规格里写的是"不得推断同意"，这条就是它的实现。
 */
export function admitByConsent(status) {
  const state = normalizeAgreeStatus(status);
  if (state === "agree") return { admit: true, reason: "agree" };
  if (state === "disagree") return { admit: false, reason: "disagree" };
  return { admit: false, reason: "unknown_treated_as_disagree" };
}

/**
 * 同意状态缓存：会话级、带 TTL。
 *
 * 外部客户可以随时变更同意（官方有 `msg_audit_approved` 回调）。缓存必须有失效路径，
 * 否则"客户明确同意了，但我们还按旧状态丢弃"会变成静默丢数据。
 */
export function createConsentCache({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  const store = new Map();
  return {
    /**
     * 带写入时间的读取。给"跨进程失效"用：回调在另一个进程里落了一条失效记录，
     * 这边必须能比较"缓存是什么时候写的"与"失效是什么时候发生的"。
     */
    getEntry(conversationId) {
      const hit = store.get(conversationId);
      if (!hit) return null;
      if (now() - hit.at > ttlMs) {
        store.delete(conversationId);
        return null;
      }
      return { status: hit.status, at: hit.at };
    },
    get(conversationId) {
      return this.getEntry(conversationId)?.status ?? null;
    },
    set(conversationId, status) {
      store.set(conversationId, { status: normalizeAgreeStatus(status), at: now() });
    },
    /** 回调到达时按会话失效；也支持全清（例如凭据轮换后）。 */
    invalidate(conversationId) {
      if (conversationId === undefined) store.clear();
      else store.delete(conversationId);
    },
    size() {
      return store.size;
    },
  };
}

/**
 * 判定一条消息是本方还是对方。
 *
 * 三条依据，按可靠性排序：
 *   1. 存档里的 `from` 是否等于企业成员 userid（最可靠）；
 *   2. bot 自身发出的消息带固定标记（不同通道字段不同，用集合判定）；
 *   3. 兜底 unknown —— 未知来源**不猜测**，由消费侧决定（默认按对方处理会导致闭环，
 *      所以消费侧必须以 `origin !== self` **且** 该通道已声明可信 为前提）。
 */
export function classifyOrigin({ from, memberUserIds = [], selfMarkers = {}, msgMeta = {} }) {
  const sender = String(from ?? "");
  if (sender && memberUserIds.includes(sender)) return ORIGIN_SELF;
  for (const [key, values] of Object.entries(selfMarkers)) {
    if (msgMeta?.[key] !== undefined && values.includes(msgMeta[key])) return ORIGIN_SELF;
  }
  if (!sender) return "unknown";
  return ORIGIN_PEER;
}

/**
 * 消费侧守卫：把一批消息里本方的挑出去。
 *
 * 这是"防止自问自答"的最后一道闸。它同样拒绝 `unknown`：
 * 在存档通道里，无法判定来源的消息不能当成新输入。
 */
export function filterForAgentInput(messages) {
  const kept = [];
  const dropped = [];
  for (const m of messages || []) {
    if (m?.origin === ORIGIN_PEER) kept.push(m);
    else dropped.push({ id: m?.id, origin: m?.origin, reason: "not_peer" });
  }
  return { kept, dropped };
}

/**
 * 同一会话两个视角（bot 实时 / 存档历史）的归并键。
 *
 * 两侧 `msgid` 不同源，不能直接当主键；用「会话 + 秒级时间 + 发送者 + 正文摘要」做软键，
 * 只为去重服务，不用于业务身份。
 */
export function mergeKey({ conversationId, tsSeconds, sender, textDigest }) {
  return [conversationId, Math.floor(Number(tsSeconds) / 1) , sender, textDigest].join("|");
}
