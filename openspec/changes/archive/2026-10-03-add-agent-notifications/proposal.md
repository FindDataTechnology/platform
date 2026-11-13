# Proposal: add-agent-notifications

## Why

萬星对外服务的 agent 需要事件通知能力（爬虫自愈的四类事件：工单终态/PR 开出/总闸变更/超限转人工，默认走飞书）。平台侧 bot-relay 已具备「命名通道 + 机器令牌 + 限流 + 审计不落文」的出站管线，但部署的 agent child 没有任何可达路径——BOTS_RELAY_TOKEN 在平台侧，child 的 env 被洗刷且不应持平台令牌。ADR-0012 已确立「平台能力经 bridge 以宿主身份提供给 child」的模式（问询即此落地）。

## What Changes

- **platform bridge 增通知能力**：runner 组合的每个 child 经其 bridge 行获得 `bot_notify(event, text[, channel])` 调用面；调用以**宿主（runner）身份**执行——令牌永不下发 child。
- **部署绑定通知通道**：deploy 请求可带 `notifyChannel`（每 agent 一名，部署者设置；必须是管理员已预绑的命名通道）；描述符记录通道名。未绑定 → `bot_notify` 结构化拒绝（不是静默丢弃）。
- **runner 转发**：bridge 收到 notify → runner 以 `BOTS_RELAY_TOKEN` POST 平台 `POST /api/bots/relay/send`（既有路由零改动），按绑定通道投递；per-agent 限流（默认 6/分钟）；失败把 relay 的错误形状回传 child（回合可见）。
- 复用既有保障：relay 的 per-channel 限流、长度上限、审计（通道/bot/结果/长度，不落正文）原样生效。

**非目标**：入站（bot→agent 触发）不在本变更；事件文案/时机=pack 作者的 skill 职责（平台只提供通道）；每事件多通道路由（v1 每部署一通道）；预算硬停的平台侧通知（后续组合 add-serving-budgets）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-runner`: 新增「部署的 child 经 bridge 以宿主身份发平台通知」——bridge 能力、通道绑定、令牌不出 runner、限流与错误回传。
- `bot-relay`: 新增「部署的 Agent 服务经既有 relay 通道投递」——agent 来源的发送进入既有端点与全部保障，通道寻址仍是命名通道、管理员预绑。

## Impact

- **代码**：`agent-runner/compose.js`（bridge 行增 notify 面）、`agent-runner/`（转发器+BOTS_RELAY_URL/TOKEN env+限流）、`gateway/packs.js`（notifyChannel 录入）、`lib/agent-serving.js`（描述符字段）。
- **零改动**：`server/routes/bot-relay.js` 与 bots 出站管线原样复用。
- **契约**：deploy 请求可选 `notifyChannel`；描述符可选 `notify_channel`。
