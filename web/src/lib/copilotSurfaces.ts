// 萬星外向副驾的挂载判定（unify-yizuo-copilot-surface D2）。
//
// 一个界面只能有一个对话入口。壹座里「本身就有原生对话入口」的面上，萬星那枚
// 圆钮是多余的第二个对话：
//
//   /chat*            整页对话
//   /zhiyu*           智语房间对话
//   /boards/*         线看板 —— 头部 CopilotDockTrigger，dock 带线上下文
//   /fleets*          舰队页 —— 同上
//   /packs            市场页（重定向到 /agents?tab=market）
//   /agents?tab=market|agents|""  市场 tab —— 同上
//   /login            登录中转
//
// 其余页面（配置、知识库、记忆、应用中心、团队、设备…）没有对话入口，
// 「这东西怎么用 / 我的额度在哪」恰恰该有人回答——萬星副驾留在那里。
//
// 与 `CopilotDock.tsx` 的 `lineForLocation` / `isMarketTab` 同源：那边决定
// 哪里挂 dock 入口，这里决定哪里让萬星退场，两者互为补集。改一处必须看另一处。

/** `/agents` 的哪些 tab 属于市场面（与 CopilotDock 的 isMarketTab 同口径）。 */
function isMarketTab(tab: string | null): boolean {
  return tab === null || tab === "" || tab === "market" || tab === "agents";
}

/** 本路由是否应挂载萬星外向副驾。 */
export function shouldMountWanxingCopilot(
  pathname: string,
  search = "",
): boolean {
  const path = pathname || "/";
  if (path === "/chat" || path.startsWith("/chat/")) return false;
  if (path === "/zhiyu" || path.startsWith("/zhiyu/")) return false;
  if (path.startsWith("/boards/")) return false;
  if (path === "/fleets" || path.startsWith("/fleets/")) return false;
  if (path === "/packs") return false;
  if (path === "/agents") {
    return !isMarketTab(new URLSearchParams(search).get("tab"));
  }
  if (path === "/login") return false;
  return true;
}
