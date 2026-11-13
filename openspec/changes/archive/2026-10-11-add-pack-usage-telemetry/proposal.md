# Proposal: add-pack-usage-telemetry

## Why

M1 的出口判据是「≥5 个内部 pack 周活跃」（facet-wanxing-roadmap），但壹座 cell 今天不记录"哪个 pack 被谁用了多少回合"——判据无法度量，内容线下一批垂类该做什么也没有数据依据。这是反馈线（M1 三线之末、出口判据的闸）。

## What Changes

- **回合打点**：`finishTurn` 落一行用量（时间、用户、会话、当前 agent、pack 归属、结果、时长）进主库新小表 `pack_usage_events`；failure-isolated（遥测错误绝不破聊天回合）；local/自定义预设记 pack 为空的单列行。
- **聚合面**：`GET /api/ops/pack-usage?days=N`（ops 凭据门）——per pack：回合数、去重活跃用户数、最近使用；非 pack（local/自建）单列一行。7 天窗即"周活跃"判据的直接答案。
- **ops 台区块**：services/ops-console 加"内部 pack 用量"板块（走既有板块源模式），周活 pack 数一眼可见。
- **有界存储**：180 天修剪（沿 trace 层的定时修剪纪律，防 2026-10-10 式无限增长）。
- v1 不做：token 用量计量（LLM 侧已有账）、CSV 导出、历史回填。

## Capabilities

### New Capabilities

- `pack-usage-telemetry`：回合打点、有界存储、聚合查询、ops 门与台面。

### Modified Capabilities

（无——打点对用户面零可观测变化，聚合面是全新 ops 面。）
