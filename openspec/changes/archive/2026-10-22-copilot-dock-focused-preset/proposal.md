## Why

2026-10-21 动作闸真机走查的发现③：副驾 dock 打开的是 `/chat?embed=copilot&board=<line>`——**只带看板、不带预设**。embed 会话因此跑的是用户的默认预设（完整工具面），模型面对「改包可见性」这类写操作时，同时看得见 `facet_market_pack_visibility` 直写工具与 `propose_action` 提议通道，它选了前者：闸的提议 / 确认 / 审计被整体绕过。`add-line-boards-and-action-gate` 的设计 D6 早已把 `preset=<copilotPreset>` 画在 URL 上，但从未接线；`line-boards` 主 spec 把这条登记为「已知边界」，并承诺由后续 change「dock 按线注入聚焦预设」收紧——本 change 就是那条。

修复的落点受一条运行时事实约束：**agent 预设是 cell 级的**，不是会话级的。dsh 在 `initialize` 时烘焙预设，切换（`switchPresetTo`）= 重写 patch + 重启子进程 + 持久化 `agent.preset`，且在主对话流式回答期间被拒绝（`server/agent-session.js:862`）。因此「副驾以聚焦预设运行」在现架构下必然意味着 **dock 打开期间整个 cell 都在该线的聚焦预设上**。本 change 接受这个代价并把它做诚实：切换对主对话的 agent 选择器可见，dock 关闭即恢复，切换失败就明说。

## What Changes

- **服务端按线解析聚焦助手**：新增 `lib/copilot-presets.js`，从已安装 pack 中按**形状**（不是 pack id）判定某线的聚焦助手 pack：每条 MCP 引用都声明了非空 `allowTools`、`allowTools` 不含动作注册表登记的任何写工具、引用的服务器全部属于该线且至少一个、pack 至少有一个已 materialize 的 agent。多候选取最近安装；无候选返回 `null`。新增 `GET /api/boards/:line/copilot`，与看板路由同受 `LINE_BOARDS_ENABLED` 门控，**不拉块数据**（柏讯看板一次要打四个上游请求，dock 取预设不该付这个钱）。
- **dock 注入与恢复**：`CopilotDock` 在有看板上下文时取该线聚焦助手，iframe src 变为 `/chat?embed=copilot&board=<line>&preset=<agentId>`；打开前记住主对话的当前 agent，关闭时恢复——若用户中途在主对话手动切换过 agent，则不恢复（他的选择优先于 dock 的记忆）。
- **embed 应用预设**：`ChatPage` embed 模式读取 `preset`，socket 连上后一次性 `set_agent`；上下文条增加「聚焦预设：谦面助手」一段。切换被拒（主对话正在回答）时上下文条显示原因与重试按钮，不自动循环重试。无聚焦助手（该线助手 pack 未安装）时 URL 不带 `preset`，上下文条明示「未聚焦」，MUST NOT 伪称闸内。
- **官方助手 pack v2**：三个官方助手 pack（谦面助手 / 萬星舰队助手 / 柏讯助手）的 agent id 全叫 `assistant`——同一 cell 装两个以上时，catalog 只会 materialize 先装的那个（`catalog.js:207`），其余线解析不到聚焦助手。manifest 改为各自唯一的 agent id（`facet-assistant` / `wanxing-fleet-assistant` / `wire-assistant`），发布说明同步；**发布本身是市场侧动作**，代码对任何 agent id 都成立，不依赖发布先行。
- **spec**：`line-boards` MODIFIED「看板定义副驾的动作边界」（收掉「已知边界」句，改为 dock 注入聚焦预设的义务与无助手时的诚实降级）；`web-chat-ui` ADDED「副驾 dock 注入聚焦预设并在关闭后恢复」。

**不做**：按会话的预设（dsh 不支持，需运行时改造）；全局 per-call 工具拦截（姊妹 change 的 D2 备选，另立）；萬星外嵌 widget（`#/embed` 车道）的预设注入——那是另一个宿主，另一个 change；修改 `switchAgentTo` / `switchPresetTo` 的既有语义。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `line-boards`: **MODIFIED**「看板定义副驾的动作边界」——删除 2026-10-21 登记的「已知边界」段，改为：从线看板打开的副驾 dock SHALL 注入该线的聚焦助手预设；无可用聚焦助手时 SHALL 明示未聚焦。
- `web-chat-ui`: **ADDED**「副驾 dock 注入聚焦预设并在关闭后恢复」——dock URL 携带预设、embed 连上即应用、上下文条可见、关闭恢复、手动切换优先、流式期间被拒则可重试、无助手时诚实降级。
- `chat-activity-collapse`: **ADDED**「待确认的动作提议自动展开其活动组」——生产模型回合级验收发现：提议卡被折叠头藏起 + `ToolBlock` 以裸名全等分派动作卡从未命中（design D7/D8）。

## Impact

- 新 `lib/copilot-presets.js`（解析规则，纯函数 + DB 读取包装）；`server/routes/boards.js`（+ `GET /api/boards/:line/copilot`）
- `web/src/components/CopilotDock.tsx`（取线预设、src 带 `preset`、关闭恢复、需要 `send`——`App.tsx` 传入）；`web/src/pages/ChatPage.tsx`（embed 读 `preset`、连上后 `set_agent`、上下文条）；`packages/core/src/store/chat-store.ts`（+ `configErrorSeq`：被拒的配置变更计数，见 design D4）
- 新 `scripts/test-copilot-presets.mjs`（解析规则正反向 + 路由门控）；新 `e2e/copilot-dock.spec.js`（五场景：聚焦 / 关闭恢复 / 手动切换不恢复 / 被拒重试 / 无助手）
- `docs/official-packs/*-manifest.json`（agent id）+ `release-instructions.md`（v2 发布记录位）；`scripts/test-official-packs-lint.mjs`（agent id 互异断言 + 修 `7c6bc0b9` 遗留的 12→14 计数基线红）
- 无新 env、无新表、无新依赖；回滚 = `COPILOT_ENABLED=0` 关 dock 或回滚镜像（dock 不带 `preset` 即回到现状）
