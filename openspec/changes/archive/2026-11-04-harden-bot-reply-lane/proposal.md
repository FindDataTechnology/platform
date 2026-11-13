## Why

2026-10-31 生产实证（企业微信群 + 智能机器人「智语·群」）：用户发了消息，机器人回了，但**两条回复都不是答案**，因此用户报「没有回复我」。

| 消息 | 实际回复 | 根因 |
|---|---|---|
| `ninengzuos` | `The assistant is starting up. Please try again shortly.` | 那一刻平台刚被滚版，cell 已监听但 dsh runtime 未就绪（日志顺序 `runtime ready (gen=0)` → `Platform fully initialized` → `dsh-bridge spawn generation=2` → 收到消息）；`runTurn` 开头的 `isReady()` 早退直接回兜底，**根本没建会话** |
| `你能做什么` | 「根据刚读取的状态：**策略边界（decision_queue 报告）**…可委托类别…」 | 它调了舰队工具（`[fleet-access] POST /api/fleets/deputy/queue`）。生产 env `BOTS_ALLOW_TOOLS=1` 关掉了禁工具前缀与回复侧扣留；而该 bot **没有任何身份注入**，跑的是 cell 默认 preset（`user-preset-2` = 属主自己的运营人格） |

三者叠加的后果是 **bot 车道的回复不可信**：它可能是一句冷启动兜底，也可能答成另一个角色，而用户无从判断「机器人到底在不在」。

`social-bot-channels` 现有需求只覆盖了**注册表未装载**的冷启动窗口（webhook 不得以确定拒绝丢弃消息），没有覆盖**注册表已装载、runtime 未就绪**这个更常见的窗口——每次滚版都会重演。

## What Changes

- **运行时就绪前排队而非兜底**：`runTurn` 不再在 `dshBridge.isReady()` 为假时立刻回 `starting up`，改为**有界等待**（新 env `BOTS_READY_WAIT_MS`，默认 90s，沿用 `cron-runner.js` 的 deadline 轮询形状）；就绪即继续走正常回合，超时才回兜底并留日志。等待期间入站消息按现有 per-chat 队列串行，不丢、不并发。
- **bot 人格注入**：`bots` 表新增 `persona` 列（TEXT，可空）；回合提示词的 blocks 首位注入人格块，与 pack bot 的挂技能块共存（人格在前、技能在后）。为空时注入**中性默认**（「你是 `<bot 名>`，一个对外助手；只用你自己的知识回答，不要冒充运营者、舰队副驾或其他内部角色」），使未配置的 bot 也不再继承 cell 默认人格。
- **工具姿态改为 per-bot（**BREAKING**）**：`bots` 表新增 `allow_tools`（默认 0）；`BOTS_ALLOW_TOOLS` 降级为**全局上限**——只有它为 1 时 per-bot 开关才生效，为 0/unset 时所有 bot 一律禁工具。恢复 spec 的默认姿态（禁工具 + 回复侧 `usedTools` 扣留）。既有部署把 `BOTS_ALLOW_TOOLS=1` 当「所有 bot 都能用工具」的，需要为每个需要的 bot 显式打开。
- 管理面配套：`GET/POST/PATCH /api/bots` 与 `maskBot` 透出 `persona`、`allowTools`；bots 页编辑表单增加人格输入与工具开关。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `social-bot-channels`：三条需求变化——①新增「运行时就绪前的入站消息排队」；②新增「bot 回合带身份注入（persona 或中性默认）」；③改写「Bot messages are untrusted input with bounded agent exposure」的工具姿态为 per-bot 开关 + 全局上限。

## Impact

- 代码：`server/bots.js`（`runTurn` 就绪等待、人格块、工具姿态判定）、`db.js`（`bots` 表两列迁移 + `BOT_COLS` + `addBot`/`updateBot`）、`server/routes/bots.js`（CRUD 字段与 `maskBot`）、`web/src/pages/BotsPage.tsx`（表单）。
- 测试：`scripts/test-bots.mjs`（工具姿态与人格注入）、`scripts/test-wecom-bot-pipeline.mjs`、`scripts/test-bot-webhook-boot-latch.mjs`、`scripts/test-user-questions-host.mjs`、`scripts/test-pack-bot-units.mjs`（均以 `delete process.env.BOTS_ALLOW_TOOLS` 起跑，需补 per-bot 语义用例）。
- 部署：生产 env `BOTS_ALLOW_TOOLS=1` 语义改变——摘掉它即刻恢复「全 bot 禁工具」，或保留为上限并为指定 bot 逐个打开 `allow_tools`。该动作作为一条运维任务列在 tasks，不在代码里做。
- 不改：webhook 验签/解密管线、per-chat 限流与长度上限、pack bot 挂技能语义、`response_url` 被动回复窗口、群聊剥离提及标记。
- 已知风险：`BOTS_READY_WAIT_MS` 拉长会占用 per-chat 队列（同一 chat 后续消息排队等待），超时必须回落兜底而不是无限等；人格块会占提示词预算，按现有 `contextBudget` 口径计。
