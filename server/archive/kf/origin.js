// ── 微信客服：origin 映射 ────────────────────────────────────────────────────
//
// kf 跟存档最大的一个差别，是它**不用猜**发送方：服务端在每条消息上直给 `origin`。
//
//   3 = 客户发送
//   4 = 系统推送（进入会话、会话结束、撤回、接待人员变更……）
//   5 = 接待人员发送
//
// 但"字段存在"不等于"取值可信"：官方对 `origin` 的说明只覆盖 3/4/5，别的值留给未来。
// 所以这里把不认识的取值一律落 `unknown`，**不猜**——猜错的代价是 agent 对着系统事件
// 或自己的回复再答一遍（自问自答闭环），而症状不会指向根因。

export const ORIGIN_CUSTOMER = 3;
export const ORIGIN_SYSTEM = 4;
export const ORIGIN_SERVICER = 5;

export const KF_SELF = "self";
export const KF_PEER = "peer";
export const KF_SYSTEM = "system";
export const KF_UNKNOWN = "unknown";

/** 数字/字符串都要能吃：真实响应是数字，测试夹具常写成字符串。 */
export function mapOrigin(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return KF_UNKNOWN;
  switch (n) {
    case ORIGIN_CUSTOMER:
      return KF_PEER;
    case ORIGIN_SERVICER:
      return KF_SELF;
    case ORIGIN_SYSTEM:
      return KF_SYSTEM;
    default:
      return KF_UNKNOWN;
  }
}

/**
 * 会话身份。kf 的会话是「客服账号 × 客户」的二元组：
 * 同一个客户分别向两个客服号咨询，是两段会话，不能合并。
 */
export function kfConversationId({ openKfId, externalUserId }) {
  return `${openKfId || ""}|${externalUserId || ""}`;
}

/**
 * 会话展示名。客户昵称未补全前按 external_userid 缩写显示，
 * 不用"未知客户"这类话术——那会让两行看起来是同一行。
 */
export function kfConversationName({ nickname, externalUserId }) {
  if (nickname) return nickname;
  const id = String(externalUserId || "");
  return id ? `客户 ${id.slice(0, 8)}` : "客户";
}
