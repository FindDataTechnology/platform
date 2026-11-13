## 1. 服务端：按线解析聚焦助手（design D1 / D5）

- [x] 1.1 新建 `lib/copilot-presets.js`：`resolveCopilotPreset(line, installedPacks, deps)` 纯函数（四条形状规则：全引用声明非空 `allowTools` 且无 `fullSurface`；`allowTools` 并集不含注册表任一 `tool`；服务器集合 ⊆ 线服务器且非空；至少一个 `report.agents[].status === "installed"`），多候选按 `installedAt` 降序取首个并 warn；`lineServersFromRegistry()` 从 `lib/action-registry.js` 的 `server` 字段推导 facet / wanxing，柏讯补 `wire-ops-mcp` / `wire-build-mcp` 常量；`copilotPresetForLine(line)` 包装 DB 读取（DB 未就绪 → null）。返回 `{ agentId, agentName, packId, packName }`。
- [x] 1.2 单测 `scripts/test-copilot-presets.mjs`：三个官方 manifest 各自解析到自己的线且不串线；含写工具（`facet_market_pack_visibility`）的 pack 被拒；某引用未声明 `allowTools` 被拒；agent 在报告里 skipped 被拒；两候选取最近安装；柏讯常量与 `lib/wire-tool-risk.js` 的 server 集合一致；未知线 → null。
- [x] 1.3 `server/routes/boards.js` 新增 `GET /api/boards/:line/copilot`：`LINE_BOARDS_ENABLED` 未开 → 404 `line_boards_disabled`；未知线 → 404 `line_not_found`；否则 `{ line, copilot }`，不调用适配器。单测：门关 404、未知线 404、已装谦面助手时返回其 agent、未装时 `copilot: null`，且 `fetchBlocks` 零调用。

## 2. dock：注入与恢复（design D2 / D3）

- [x] 2.1 `web/src/components/CopilotDock.tsx` 接收 `send`（`App.tsx` 传入）；`boardLine` 变化时 `GET /api/boards/:line/copilot`，结果存 `copilot` state；iframe src 在有 `copilot.agentId` 时追加 `&preset=<agentId>`；postMessage 的 `copilot_context` 同步携带 `preset`。
- [x] 2.2 打开时记录 `agentBeforeOpen = useChatStore.getState().currentAgent`；关闭时若 `currentAgent === copilot.agentId` 则 `send({ type: "set_agent", id: agentBeforeOpen ?? "local" })`，否则不恢复；无 `copilot` 时关闭不发任何消息。

## 3. embed：应用预设与上下文条（design D2 / D4 / D5）

- [x] 3.1 `web/src/pages/ChatPage.tsx` embed 模式读取 `preset`；`status === "connected"` 后一次性（ref 守卫）在 `currentAgent !== preset` 时 `send({ type: "set_agent", id: preset })`；监听 `agent_changed` 对齐即视为已聚焦。
- [x] 3.2 上下文条增加聚焦段：已聚焦显示「聚焦预设：<agent 名>」（名字来自 store `agents` 列表，找不到则显示 id）；`set_agent` 返回 error 时显示「主对话正在回答，暂未聚焦」+ 重试按钮（重试即重发一次）；URL 无 `preset` 时显示「未聚焦：该线助手 pack 未安装」。「清除」按钮只清 `board`，不动 `preset`。五语 locale 补 `copilot.focused` / `copilot.focusPending` / `copilot.focusRetry` / `copilot.unfocused`。
- [x] 3.4 （验收发现 D7）`ToolBlock` 动作卡分派改 `name.endsWith("__propose_action")`——运行时工具名是 `mcp__actions__propose_action`，全等从未命中，真回合里提议只渲染成普通工具块
- [x] 3.5 （验收发现 D8）core 新增 `isProposeActionBlock` / `proposalStateOf` / `groupHasPendingAction`，web `ActivityGroup` 合成：待确认提议（调用进行中或 state=pending）保持活动组展开；新 e2e `e2e/action-card-turn.spec.js`（pending 卡无需展开可见 + 不是通用工具块；executed 随组折叠、展开后为已执行面）
- [x] 3.6 （复验发现 D9）`server/dsh-events.js` 新增 `parseToolResult`（扁平 / 包裹双形状：callId、内容数组、文本、isError），`tool/result` 与 `cron-runner` 收集器共用；`scripts/test-dsh-tool-result-shape.mjs` 6/6（扁平成功文本落 tool_end 与持久块、扁平 401 错误位+指路、垃圾不抛）
- [x] 3.7 （复验发现 D10）ToolBlock 向 ActionCard 传本次渲染的 `{name,args,state,result}` 新对象（store 原地改块 + memo 引用比较 → 结果落地后卡不更新）；e2e 第三例 `tool_start`→`tool_end` 真事件路径，突变验证红绿
- [x] 3.3 e2e（`e2e/wire-board.spec.js` 追加或新 `e2e/copilot-dock.spec.js`，mock `/api/boards/:line/copilot`）：有助手时 iframe src 含 `preset=`、上下文条显示聚焦段；无助手时 src 不含 `preset` 且显示未聚焦；关闭 dock 后 WS 收到 `set_agent` 恢复消息（或断言主对话 agent 回到打开前）。

## 4. 官方 pack v2（design D6）

- [x] 4.1 `docs/official-packs/{facet-assistant,wanxing-fleet-assistant,wire-assistant}-manifest.json` 的 `agents[0].id` 改为 `facet-assistant` / `wanxing-fleet-assistant` / `wire-assistant`，`notes` 标 v2 原因；`release-instructions.md` 增「v2 发布记录」位与 agent id 去撞说明。
- [x] 4.2 市场发布三包 v2（用户 2026-10-22 点头；aloadtree 设备身份现铸 token → NodePort 直调 facet-market-mcp：validate `valid:true/publishEligible` → publish → versions 核实）：谦面助手 `qCEIutJzQd49jnDtV4qeqw` v2 / 萬星舰队助手 `INdsRWpgpp2Q03I0z3XoFA` v2 / 柏讯助手 `ALuUIiL23WP5OqLIgSRX1g` v2（仍 private）。aloadtree cell 走真市场链 `{packId, version:2}` 装谦面助手 → agent `facet-assistant` installed → `GET /api/boards/facet/copilot` 非 null（wanxing/wire 未装，诚实 null）

## 5. 验证与上产

- [x] 5.1 `npm run test:unit`（含新测试）、`biome check`、`tsc --noEmit`（web）、`web:build`，e2e fast 项目相关 spec 绿。
- [x] 5.2 出片：`fd-build-channel` 判路 → `fd-build-snapshot` → relay → ccr → ArgoCD（`argocd.argoproj.io/refresh` 注解，image 字段翻转 ~60s 为准）；digest ↔ pod imageID 比对。
- [x] 5.3 真机验收：platform-demo（装 v2 agent id 的谦面助手）ego 真浏览器三轮全过——`/boards/facet` 开 dock src 带 `preset=facet-assistant`、上下文条「Focused preset: 谦面助手」（set_agent→重启→agent_changed 全链）、context-free 不带 preset、wanxing 诚实未聚焦；反向对拍 cell 3fdc 白名单带写工具的「谦面市场助手」被解析器正确拒绝。**模型回合级验收（aloadtree cell 让模型改可见性→只出 propose_action 卡）未做**——需真 cell 的 facet-market 凭据环境，留待 aloadtree 走查（platform-demo 为滚动即清卷，测试安装无残留）：`/boards/facet` 开 dock → src 带 `preset` → 上下文条「聚焦预设：谦面助手」→ 主对话选择器同步显示 → 让模型「把包 X 改成私有」→ 只出 `propose_action` 确认卡、无 `facet_market_pack_visibility` 直调 → 关 dock → 主对话 agent 恢复。记录到 `docs/registry-maintenance.md` 发布记录。

## 6. 收口

- [x] 6.1 同步主 spec（`line-boards` MODIFIED、`web-chat-ui` ADDED、`chat-activity-collapse` ADDED），三 spec validate 绿（`--all` 余 4 个红是 knowledge-collection/weknora 空 spec 基线，与本 change 无关）。
- [x] 6.2 归档 change（archive/2026-10-22-copilot-dock-focused-preset）；台账 §15.4 补记二；持久记忆更新（发现③收口、cell 级预设副作用与恢复策略、tool/result 扁平形状平台级回归）。
