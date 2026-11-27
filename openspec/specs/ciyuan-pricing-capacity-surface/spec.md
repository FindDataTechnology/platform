# ciyuan-pricing-capacity-surface Specification

## Purpose
规定壹座侧如何展示词元的 `pricing`（峰谷价）与 `capacity`（观测吞吐）两个字段。
前者回答「现在跑贵不贵、什么时候便宜」，后者回答「这把 key 实测能扛多少、失败率多高」。

这两行的**可依赖语义**由本仓 `openspec/specs/ciyuan-capability-endpoint/spec.md` 定义
（含五条禁止推断；2026-11-14 由 change `add-ciyuan-capability-contract` 归档落为正式规格），本 spec 只约束**展示行为**，
不重新定义字段含义、不改动生产者的推导口径。

> 消费者接入义务的归属：`openspec/changes/archive/2026-11-14-add-ciyuan-capability-contract/tasks.md`
> 的 3.2/3.3 明确「各自在独立 change 内完成」。本条即 3.3 之外的第二类消费面（展示），
> 实现落在 `lib/ciyuan-capabilities.js` 与 `server/routes/ciyuan-account.js`。

## Requirements

### Requirement: 已在低谷与下次低谷 MUST 被区分

生产者的 `pricing.next_offpeak_start` 在**已在低谷**时给出的是**当前这段低谷的起点**
（`backend/internal/lanes/capabilities_pricing.go` 的注释：调用方的问题是「什么时候能便宜地跑」，
答案就是「现在，直到 X 点」）。消费方 SHALL 依 `pricing.peak` 区分两种叙述，
MUST NOT 无条件把 `next_offpeak_start` 展示成「下次低谷开始时间」。

#### Scenario: 此刻就在低谷

- **WHEN** 快照返回 `pricing.peak == false` 且 `pricing.next_offpeak_end` 非空
- **THEN** 展示 SHALL 说明「当前处于低谷」，并给出这段低谷的结束时刻
- **THEN** 它 MUST NOT 说成「下次低谷将在 `next_offpeak_start` 开始」（那个时刻就是现在）

#### Scenario: 此刻处于高峰

- **WHEN** 快照返回 `pricing.peak == true`（`multiplier > 1`）
- **THEN** 展示 SHALL 给出当前复合倍率与 `pricing.peak_ends_at`（高峰结束时刻）
- **THEN** 若 `next_offpeak_start` 非空，它 MAY 一并给出，但 MUST NOT 把 `multiplier` 说成结算倍率

### Requirement: 无数据 MUST NOT 显示为 0

`capacity.sustainable_rps` 与 `capacity.error_ratio` 在样本不足时为 `null`，`pricing` 在旧版词元
或分组无峰谷配置时整块为 `null`。消费方 SHALL 把 `null` 展示为「无数据」，
MUST NOT 折叠成 `0`、`0 rps`、`0%`，也 MUST NOT 用同一次读取的其它字段去推断其取值。

#### Scenario: 吞吐样本不足

- **WHEN** 快照返回 `capacity.sustainable_rps == null` 且 `confidence == "low"`
- **THEN** 展示 SHALL 显示「无数据（样本不足）」一类文案
- **THEN** 它 MUST NOT 显示 `0`，也 MUST NOT 隐藏 `capacity.model`（那是观测对象，不是估计值）

#### Scenario: 旧版词元没有这两个字段

- **WHEN** 快照响应不含 `pricing` 或 `capacity`（旧版生产者）
- **THEN** 消费方 SHALL 静默省略对应展示行
- **THEN** 卡片其余部分（额度、车道、模型计数）MUST 保持原样，不得整体退化为「无数据」

### Requirement: 这两个字段 MUST NOT 成为准入或调度闸门

生产者对两个字段都声明 `advisory: true`，且契约 `ciyuan-capability-endpoint` 已禁止把
`capacity` 当容量映射或硬闸门、把 `pricing.multiplier` 当结算倍率。消费方 SHALL 只把它们用于展示与
**建议**，MUST NOT 据其拒绝请求、限流、或改写调度决策。

#### Scenario: 吞吐偏低仍须放行

- **WHEN** 快照返回较低的 `capacity.sustainable_rps` 或较高的 `capacity.error_ratio`
- **THEN** 消费方 MUST NOT 因此拒绝或延后用户的模型请求
- **THEN** 真正的硬顶仍由词元侧执行（余额耗尽不触上游）

#### Scenario: 快照读不到不影响发起

- **WHEN** `fetchCapabilities` 返回 `null`（超时 / 非 2xx / 形状不符）
- **THEN** 消费方 SHALL 退回既有行为并如实标注「无数据」
- **THEN** 它 MUST NOT 因为「读不到峰谷或吞吐」而阻断任何调用
