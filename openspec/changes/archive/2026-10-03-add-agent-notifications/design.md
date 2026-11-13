# Design: add-agent-notifications

## Context

- bridge 通道现成：runner compose 的 presets patch 已插 platform bridge 行（`compose.js:115-126`，ADR-0012 问询模式=宿主提供能力的先例）；child 与 bridge 的调用面经 dsh SDK（request/notification）。
- relay 现成：`POST /api/bots/relay/send`（BOTS_RELAY_TOKEN 常量时间比对、命名通道、per-channel 限流、审计不落文、未配置即 404 惰性）。
- runner 与平台互通先例：`packsBaseUrl`（AGENT_RUNNER_PACKS_URL）取 llm-key 走平台内部路由。

## Goals / Non-Goals

**Goals**：child 可经 bridge 发通知（宿主身份）；部署绑定通知通道；限流+错误回传；relay 侧零改动。

**Non-Goals**：入站触发；事件文案规则（pack skill 职责）；多通道路由；预算硬停通知（后组合）。

## Decisions

- **D1 bridge 能力面**：bridge 增 `bot_notify` 方法（params: `{event, text, channel?}`）。实现骑 dsh 的 request 通道（child → bridge request → runner 处理）——与问询同层；bridge 在 runner 进程内，天然持有宿主身份。
- **D2 通道绑定**：deploy 请求 `notifyChannel: {"<agentId>": "<channel>"|null}`（部署者权限，与 rhythms/budgets 同位校验）；描述符 `notify_channel`。通道存在性不在 deploy 时校验（绑定表是平台侧活数据，部署时校验会引入跨服务依赖；未绑定/未知通道在运行期被 relay 404 结构化拒绝）。
- **D3 转发器**：runner env 增 `AGENT_RUNNER_RELAY_URL`（默认从 packsBaseUrl 推导同 host）+ `AGENT_RUNNER_RELAY_TOKEN`（=平台 BOTS_RELAY_TOKEN）；bridge 处理器 POST `{channel, text: "[event] text"}`；超时 10s；per-agent 令牌桶 6/min（env 可调）；未配置 token → bot_notify 直接结构化拒绝（not-configured，与 relay 惰性语义一致）。
- **D4 错误回传**：relay 2xx → 成功；401/404/429/5xx → 以 bridge 错误形状回传（channel 未知/超限/未配置），回合可见可写进 agent 状态。
- **D5 审计**：runner 侧每次转发记一行（agent、channel、outcome、textLen——不落正文），与 relay 侧审计双层。

## Risks / Open Items

- bridge 的具体方法注册形状依 dsh SDK 版本（适配层内实现，接口不外溢）；实施首步先在 staging 打通最小 notify 往返再铺。
- e2e：staging 部署绑 `test-channel` 的 agent → 回合内 bot_notify → 断言 relay 审计行+child 收到成功回执；未绑定/超限两拒绝路径。
