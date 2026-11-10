// 舰队 MCP 的拒绝话术（2026-10-29 真机诊断 §15.88）。
//
// 为什么单独一个模块：`server/fleet-mcp.js` 顶层 `await server.connect(...)` 直接
// 占用 stdio，任何测试 import 它都会挂住——拒绝话术这样纯字符串的决定放进独立
// 文件才测得到。
//
// 背景：常务岗三件工具（decision_queue / decision_resolve /
// decision_escalate_to_owner）是**按岗授权**的，服务端 deputyGuard 校验归因岗位
// = 舰队策略的 deputyMemberId；而 MCP 子进程每 cell 一个、工具清单静态，没法只对
// 常务岗露出来。于是非常务岗也会看到并去点。
//
// 真机证据：CEO 岗在**成功**的一轮里连点 decision_queue 三次，每次只拿回一句
// `this post is not the fleet's delegated deputy`——信息量不足以让模型停止，它
// 换个角度再试；失败那轮还白烧 1 步，而那一轮正顶着 10 分钟回合预算。
//
// 所以拒绝要**自带结论和下一步**：告诉它这不是权限抖动、不要换参数重试，以及
// 现在该干什么。只在「非常务岗」这一条错误上做——通用的「别重试」会把真故障
// 也一起噤声。

export const DEPUTY_ONLY_HINT =
  "这是常务岗（决策代理）专用工具；本岗位不是本舰队的常务岗，调不通，也不要换参数重试。" +
  "本轮职责是巡视与报数——直接用 report_status 交数，确需主人定夺的用 escalate。";

/** 「不是本舰队常务岗」这一条错误，带上结论与下一步；其余错误原样返回。 */
export function deputyDeniedText(message) {
  return `${message} — ${DEPUTY_ONLY_HINT}`;
}

/**
 * decision_resolve 的拒绝分两种，下一步完全不同：
 *   - 不是常务岗 → 收手去报数（指它去 decision_escalate_to_owner 等于再烧两步，
 *     因为那个工具它同样调不通）；
 *   - 常务岗越权（类别/严重度/预算）→ 上升给主人。
 */
export function decisionResolveErrorText(message, status) {
  if (/not the fleet's delegated deputy/i.test(message)) return deputyDeniedText(message);
  const suffix =
    status === 403 || status === 429
      ? " — this is beyond your delegation mandate: escalate it to the owner (decision_escalate_to_owner) instead of retrying."
      : "";
  return message + suffix;
}

/** 三条 deputy 路由：403 才是「你不是常务岗」，其余状态原样。 */
export function deputyToolErrorText(message, status) {
  return status === 403 ? deputyDeniedText(message) : message;
}
