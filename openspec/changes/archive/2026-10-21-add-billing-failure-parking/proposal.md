# Billing-Failure Parking Proposal

## Why

2026-10-21 生产实证：一个部署者的 sub2api key 余额耗尽（`platform-test@findmail.com`，名下 4 个部署），runner 的反应是**每 60 秒重试一次注定失败的回合**——wx-alpha 的日滚纪要 48 小时刷了 2874 行失败日志（≈2874 次白烧的 LLM 调用），调用方只看到 `-32003: 403 status code (no body)`（sub2api 的 JSON 错误体在 dsh 客户端层就被丢弃），没有任何人能从错误里读出「充值即好」。这次事故因此被先后误判为「词元凭据面事故」和一个不存在的 registry 迁移回归，分诊花了一整个会话。

计费门自带一个零花费的真源：用 agent 钉住的 key 打 `GET {baseUrl}/models`——不花一分钱、不走上游、却过完整计费门（`INSUFFICIENT_BALANCE` / `INVALID_API_KEY` / 200 三态可判）。runner 今天不用它。上游常规抖动（openrouter 组每小时 1–5 次 502/503）**不该**被停车——探针 200 恰好能把它和真·计费失败分开。

## What Changes

- **失败分类**：回合以 `-32003` 失败时，runner 用该部署钉的 key（billing key，回落 runner 级 key）打一次零花费 `/models` 探针；仅对 openai-completions 型 provider 生效，其他类型不分类不停车（保持现状）。探针 `401 INVALID_API_KEY` / `403 INSUFFICIENT_BALANCE` → 停车；`200` 或网络错 → 不停（抖动归抖动）。
- **停车（park）**：`parked: Map<key, {reason, detail, since}>`，与部署者手动 pause（registry `paused` 标记，-32010）**分立**——自动触发、自愈、不写 registry。跳过缝与 pause 同位：rhythm 自节奏、日滚纪要；**入站 A2A 回合快速失败**，新错误码 `-32012`（`-32011` 已被 a2a 委派深度上限占用——archived add-agent-delegation-a2a D4；apply 期更正），消息带人话原因（如 `agent parked: deployer key rejected (INSUFFICIENT_BALANCE) since 10-21 14:32`），不再烧一次注定失败的 LLM 调用。
- **自愈**：停车期间按慢节律（env 可配，默认 10 分钟）复探；探针 200 ⇒ 自动复业 + fleet 事件。部署描述符变化（billing key 换引）触发重组/重生时清停车态。
- **可观测**：fleet 事件 `billing_parked` / `billing_unparked`（带 reason）；health/ops 快照该 agent 行加 `parked` 注记（加字段，不动既有五态）；meter 不变（失败回合本就免结算）。
- **明确不做**：不停上游抖动（探针 200）；不改 dsh 的错误上报（它在适配边界之下）；不做 facade/console 的停车展示（fd-wanxing 侧后续，`-32011` 消息本身已可读）；不做自动充值/告警。

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `agent-runner`: 新增需求 "A billing-rejected key parks the agent's turns" —— 探针分类、停车状态与跳过缝、`-32011` 快速失败、自愈复业、事件与注记。既有 pause（agent-residency）、turn budgets、health 五态需求**零修改**——纯 ADDED，与姊妹 change `add-serving-ask-bridge`（同 spec、不同需求名）归档互不阻塞。

## Impact

- 代码：`agent-runner/manager.js`（park 表 + turn 失败分类 + 入站快速失败 + 复探）、`rollover.js` / `scheduler.js`（跳过缝各加一行）、`config.js`（探针节律 env）、`index.js`（复探定时器）、`fleet.js`（两事件）、`agent-runner/test/*`。
- 出片：serving 镜像一滚即生效；无 schema/secret/registry 变更。
- 调用方：停车中的 agent 从 `-32003` 变为 `-32012`（新码，消息可读）；未停车路径零变化。
- 验收锚点：真机把某部署 key 置 0 余额 → 一个失败回合内停车、日志静默、入站得 `-32011` 人话；充值后 ≤ 一个复探周期自动复业。
