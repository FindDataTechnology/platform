## Context

见 `proposal.md`。塑造方案的事实：

- **预设是 cell 级**：`server/agent-session.js` 的 `switchPresetToInner` 重写 MCP/skills patch → `dshBridge.restart({ agentPreset })` → 持久化 `agent.preset` → 广播 `current_preset`；`switchAgentToInner` 对 pack agent 走同一路径，并把切换前的非 pack 预设停在 `agent.preset.own`。流式期间（`ctx.isStreaming`）两者都拒绝。dsh 不提供按会话预设（`dsh-bridge.js:231` 在 `initialize` 带 `agentPreset`）。
- **catalog agent id = manifest agent id**（`catalog.js:209`，不带 pack 前缀）；同 id 第二个 pack 的 agent 在安装报告里是 skipped，不进 catalog（`:207`）。三个官方助手 pack 都用 `assistant`。
- **`set_agent` 收的是 catalog id**（`switchAgentTo` 在 `switchableAgents` 里按 `a.id` 匹配），再由 `rosterPresetId` 折成 roster 形式——dock 传 catalog id 即可，不碰 roster 形式。
- **dock 是同源 iframe**（`CopilotDock.tsx`）：独立文档 / store / WS，但打的是同一个 cell；`agent_changed` 广播两边都收到。
- 聚焦模式的工具面由 `dsh-profile.js` 的 `deriveScope` 从 pack manifest 的 `allowTools` 推出（`mcpTools`），写工具不在白名单里即不可见——这是闸「不可绕过」的机制（姊妹 D2），本 change 只是让副驾真的站进去。
- `/api/boards/:line` 要跑适配器（柏讯真打四个上游）；`/api/config` 是 cell 级，装不下按线的数据。

## Goals / Non-Goals

**Goals**

- 从线看板打开的副驾默认运行在该线的聚焦助手预设上：可见工具面 = pack 读工具 + `propose_action`。
- 切换对用户可见、可恢复、失败可解释；不留下「静默换了人格」的状态。
- 解析规则不依赖 pack id 与 pack 名，任何满足形状的 pack 都能当该线的聚焦助手。

**Non-Goals**

- 按会话预设、全局 per-call 拦截、萬星 `#/embed` 宿主、修改 `switchAgentTo` 语义（见 proposal 不做清单）。

## Decisions

### D1 — 按形状解析聚焦助手，而不是登记 pack id

`lib/copilot-presets.js` 的 `resolveCopilotPreset(line, installedPacks, { writeTools, lineServers })`：

1. 每条 `manifest.mcpServers[]` 引用都声明非空 `allowTools` 且无 `fullSurface`——没声明等于整面（`deriveFullModeToolScope` 的安全阀语义相同），整面不可能是聚焦助手。
2. `allowTools` 并集与**动作注册表全部条目的 `tool`**（`lib/action-registry.js`，不分线）无交集——注册表登记的恰是受闸写工具。
3. 引用的服务器集合 ⊆ 该线服务器集合且非空。线 → 服务器表来自注册表条目的 `server` 字段（facet / wanxing），柏讯条目不带 `server`（钉在 `wire-tool-risk` 快照），故补 `wire-ops-mcp` / `wire-build-mcp` 两条常量，注释指向快照。
4. `report.agents[]` 中至少一个 `status === "installed"` 的 agent（与 `catalog.js` 同判据）；取第一个。

多候选按 `installedAt` 降序取最近安装（用户最近装的大概率是他要的），其余打一行 warn。无候选 → `null`。

**备选**：登记市场 pack id（`qCEIutJzQd49jnDtV4qeqw` 等）——部署里自铸的 pack id 随机（见 `hosted-vs-single-process` 教训），第三方做的「柏讯助手」也该能当聚焦助手；按 pack 名匹配——名字可改且跨语言。形状规则同时就是闸的安全不变量（读面 + 不含写工具），把它写成代码比写成约定可靠。

### D2 — 切换落在 embed，恢复落在宿主

- **embed 应用**：`ChatPage` embed 模式在 `status === "connected"` 后、仅一次、`currentAgent !== preset` 时 `send({ type: "set_agent", id: preset })`。URL 首帧就是契约（姊妹 D6 的形状），任何会拼这条 URL 的宿主都得到同样的行为。
- **宿主恢复**：`CopilotDock` 打开时记下 `useChatStore` 的 `currentAgent`（`agentBeforeOpen`），关闭时若 `currentAgent === 目标预设`（即仍是 dock 切过去的那个）则 `send({ type: "set_agent", id: agentBeforeOpen ?? "local" })`；若 `currentAgent` 已是别的（用户中途手动切换），不恢复。iframe 文档在 unload 时发 WS 不可靠，所以恢复不能靠 embed 自己。

**为什么不让宿主也做应用**：宿主与 embed 各有一条 WS，两边都 `set_agent` 会竞争同一次重启（`runExclusiveRuntimeMutation` 会串行化，但第二次是空操作加一次 `Unknown`/no-op 往返）。一处应用、一处恢复，职责不重叠。

### D3 — cell 级副作用做诚实，不做隐藏

- 切换后 `agent_changed` 广播，主对话 agent 选择器显示「谦面助手」——这是事实，不隐藏。
- embed 上下文条显示「聚焦预设：谦面助手」，与「正在看：facet」并列；用户点「清除」只清看板上下文，不动预设（预设恢复由关 dock 触发）。
- 主对话现有会话不受影响：dsh 拒绝重组已产生回合的会话，重启只影响**下一个**空白会话（既有 `switchPresetToInner` 注释）。

### D4 — 失败处置：被拒即明说，不循环

`set_agent` 在主对话流式期间返回 `{type:"error", message:"Cannot switch agent while the agent is responding"}`（只回给请求方 socket）。embed 收到后上下文条显示「主对话正在回答，暂未聚焦」+「重试」按钮；重试再发一次。不设定时自动重试——每次重试都是一次子进程重启请求，不该由前端循环驱动。

**拒绝的判据不是 `pendingConfig` 回到 null**（e2e 首跑抓出的真实竞态）：连接首帧在 `current_agent` 之后还会送 `models` → `current_preset` 等消息，store 对它们也清 `pendingConfig`，按它判会把在途的切换误报成「已拒绝」。改为 store 新增 `configErrorSeq`（只在「配置变更被拒」的错误分支递增），embed 记下发送时的值，「计数变了且未 `agent_changed`」才是拒绝。发送门槛同时推迟到 `currentPreset` 已知——那意味着首帧已过、运行时已就绪（冷启动期间发切换只会被拒）。

恢复侧同理：关闭时若被拒（副驾自己正在回答时关 dock），不再补发；主对话选择器显示的仍是真实状态，用户可手动切回。

### D5 — 无聚焦助手：不带 preset，明示未聚焦

`GET /api/boards/:line/copilot` 返回 `{ line, copilot: null }` 时，dock 不加 `preset`，embed 上下文条显示「未聚焦：该线助手 pack 未安装」。行为等于今天，但边界从「文档里的已知边界」变成「界面上的一行字」。

### D6 — 官方 pack agent id 去撞是发布动作，不是代码前置

manifest 改 `agents[0].id` 为线名前缀的唯一 id；persona / 工具面不变。市场发布走 `release-instructions.md` 既有配方（cell 设备凭据直调 `facet_market_pack_validate` → `facet_market_pack_publish`，版本自动 +1）。已装 v1 的 cell 升级 pack 后 catalog id 变化，`agent.preset` 若停在旧 id 会被 `resolvePersona` 的自愈逻辑回落为 full——与任何 pack 升级相同，不另处理。

## Risks / Trade-offs

- **重启抖动**：开 / 关 dock 各触发一次子进程重启（目标已是当前预设时跳过）。重启是模型 / 工作区 / 预设切换共用的既有路径，秒级；v1 接受。若实测扰人，下一步是让 dock 关闭不恢复、改由主对话显式切回。
- **多标签页**：另一标签页的主对话选择器会随 `agent_changed` 翻转——这是真实状态，不是 bug；D3 已选择可见。
- **候选误判**：第三方 pack 恰好满足形状（只读 + 该线服务器）会被当成聚焦助手——它确实满足闸的安全不变量，当成聚焦助手是安全的；最近安装优先让用户可控。
- **柏讯线服务器常量漂移**：柏讯 MCP 改名会让 wire 线解析不到助手 → 诚实降级（D5），单测锁定常量与 `wire-tool-risk` 快照的 server 集合一致。

## Migration Plan

1. 代码 + 单测 + e2e 合入，随常规出片链上产；无 env、无表、无依赖变更。
2. 生产验收（aloadtree）：`/boards/facet` 开 dock → iframe src 带 `preset` → 上下文条显示聚焦预设 → 让模型「把某包改成私有」→ 只出现 `propose_action` 确认卡、无直写工具调用 → 关 dock → 主对话 agent 恢复。
3. 官方 pack v2 发布（市场侧，按 `release-instructions.md`），验收 cell 升级后三线各自解析到助手。
4. 回滚：回滚镜像即可（dock 不带 `preset` 回到现状）；`COPILOT_ENABLED=0` 关 dock 仍有效。

## Open Questions

- 关 dock 的恢复是否该改为「不恢复，只提示」——取决于真机体感（重启两次 vs. 主对话被换人格的时长）。
- 萬星 `#/embed` 宿主（副驾 widget）是否也注入聚焦预设——它面向匿名 / 外部身份，工具面模型不同，另立 change。

## 验收发现（2026-10-22 生产模型回合级验收）

aloadtree 真 cell + v2 谦面助手聚焦预设，中性指令「把我名下的包改成私有」：模型明确「写操作不直接执行，先只读核实再提案」，两条 `facet.pack.visibility` 提议落库 pending、`action_audit` 零新增——**发现③的绕闸场景不复现**。但确认卡在界面上不可见，两处缺陷：

- **D7 — 动作卡识别按后缀匹配**：`ToolBlock` 以 `name === "__propose_action"` 分派动作卡，而运行时工具名是 `mcp__actions__propose_action`（cron / delegate 两张卡早就用 `endsWith`）。真回合里提议从未渲染成卡，只是普通工具块；此前 e2e 只经看板按钮路径渲染过 ActionCard，没走过 ToolBlock 分派。改为 `endsWith("__propose_action")`。
- **D8 — 待确认提议不折叠**：活动组折叠把 `propose_action` 块一并折进「执行了 N 步」头后面；折叠规则只豁免了报错块与进行中的提问卡。新增 `groupHasPendingAction`（core，与 `groupHasPendingAsk` 同形：调用进行中或提议 state=pending 即保持展开），web `ActivityGroup` 合成；已执行 / 拒绝 / 过期的卡随组折叠。小程序侧无 ActionCard，暂不合成（移动端审批是姊妹 change 的 Open Question）。

**顺带登记（不在本 change 修）**：模型第一份提议把参数键写成 `packId/packName`，注册表 `facet.pack.visibility` 的影响面模板读 `id/name`，落库 `impact_text` 成「包「undefined」」；模型自己察觉后按 `id` 键重提。propose 入口应按动作声明校验 / 归一参数键（或 `propose_action` 的 inputSchema 按动作细化），否则会留下不可批准的垃圾提议。

- **D9 — `tool/result` 形状双容（第二片复验揪出的平台级潜伏回归）**：分派修好后卡渲染出来了却停在「提议中...」——`block.result` 为空。溯源：生产 dsh 的 `tool/result` 是**扁平**形状（`message.content` 即 MCP 内容数组、`isError` 在 message 层），`server/dsh-events.js` 与 `server/cron-runner.js` 读的是**包裹**形状（`content[0].content` / `content[0].isError`，单测夹具一直这么喂）。aloadtree cell trace 704/704 条全扁平——线上所有工具块「输出」为空、持久化历史无结果、UNKNOWN_TOOL 候选补全与工具层 401 置 stale 全部静默失效；动作卡是第一个真正依赖结果文本的消费者。新增 `parseToolResult(ev)` 双形状解析（两处共用），`scripts/test-dsh-tool-result-shape.mjs` 以扁平形状钉死 tool_end 文本 / 错误位 / 401 指路 / 持久块。
- **D10 — 动作卡接收本次渲染的块字段，而非块引用（第三片复验揪出）**：D9 修好后持久化块已含提议 JSON、活动组也自动展开了，卡仍停在「提议中...」。根因：store 对 `tool_end` 是**原地改块对象**（只克隆 turn 与 blocks 数组，块对象共享——`currentAssistant` 注释明写此为 O(1) 流式策略），而 `ActionCard` 是 `memo` 包裹、只收 `block` 一个 prop：首帧（调用进行中）挂载后，结果落地时 prop 引用未变 → memo 跳过 → 永远不更新。通用 ToolBlock 不受影响是因为父组件每次传新的 `onToggle` 闭包。修法：ToolBlock 把本次渲染的 `{name,args,state,result}` 作为新对象传给卡，卡内 `useMemo` 仍按 `block.result` 文本去重。e2e 第三例走真实事件路径（`tool_start` → 卡挂载无按钮 → `tool_end` → 出现确认/取消），突变验证：还原该行即红。
