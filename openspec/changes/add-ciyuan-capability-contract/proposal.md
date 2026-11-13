## Why

词元（sub2api 增量谱系 fork）已实现 key-scoped 能力快照端点
`GET /v1/ciyuan/capabilities`（fork 仓 change `add-ciyuan-capability-endpoint`，2026-11-10 代码面完成、
未上产）。它解决的是各产品线长期自付的一笔账：

- 壹座为「知道哪些模型真能服务」自建了探针式 sync（`archive/2026-09-30-add-llm-model-discovery`：
  拉全量 id → 逐个打 1-token 补全 → 分六类），`paas/dsh-profile.js:42-60` 记了代价
  「ID 形状双向漂移——信探测，别信历史」。
- 各线（时论/之思/正信/柏讯）把 base URL 与默认模型硬编码在 `llm.py` / `settings.py`，
  换模型要改四个仓。
- 三车道通不通、图像/视频开不开、这把 key 还剩多少额度，消费方一律读不到。

**本仓已有的 `ciyuan-*` spec 全部是「跨仓行为契约」**（`ciyuan-gateway-lanes`、
`ciyuan-gateway-identity`、`ciyuan-product-surface`、`ciyuan-trial-account`、`ciyuan-account`），
口径统一为「实现归属 sub2api fork 仓；本 spec 为跨仓行为契约，审计时按文件间一致性核对」。
本 change 按同一惯例为能力快照补一条契约。

**但与既有几条不同的一点**：本条契约**刻意不复制生产者侧的需求细节**。原因是消费方真正需要
被约束的不是「响应长什么样」（那在 fork spec 里），而是**「你能从它推出什么、不能推出什么」**——
把这条写进 paas，才能让六条线的接入方在同一套推理规则上对齐，而不是各自解读同一份 JSON。

## What Changes

- 新增跨仓契约 spec `ciyuan-capability-endpoint`（消费方视角）：允许依赖的字段与语义、
  明令禁止的推断（不得把 `serving` 当实时、不得把 `null` 当 `false`、不得把 `limits` 当余额）、
  以及降级规则（端点不可达 / 返回 503 时消费方必须退回既有行为）。
- 登记两条消费方接入义务与它们的归属 change（不在本 change 实现）：
  ① 壹座 sync 改为「读快照为主、探测为校验」；② 各线默认模型改为「读推荐、失败回落硬编码」。
- 不改任何代码、不改既有 `ciyuan-*` 契约、不动 fork 仓。

## Capabilities

### New Capabilities
- `ciyuan-capability-endpoint`（跨仓契约，消费方视角）：能力快照的可依赖语义、禁止推断、降级义务。

### Modified Capabilities
（无——既有 `ciyuan-*` 契约一条不改；`/v1/models` 的 OpenAI 兼容语义也不变）

## Impact

- **代码**：零（本 change 只有 spec delta 与索引）。
- **运行时**：零。
- **消费方**：为后续两条接入单提供判据；未接入前，消费方行为与今天一致。
- **审计**：新增一条「按文件间一致性核对」的契约对象——审计时需对照 fork 仓
  `openspec/changes/add-ciyuan-capability-endpoint/specs/ciyuan-capability-endpoint/spec.md`
  与本文件，任何一侧单独改动即视为漂移。
