# ciyuan-roster-visibility Specification

## Purpose
规定壹座模型页 MUST 把「名册上一次判定有多旧」显示给用户，使一条数周前（或从未）重探的判定
不能被读成「今天仍然可调用」。判定本身来自 `discovery[model].probedAt`；本 spec 只管消费者侧
的呈现与陈旧阈值，不改探测、合并的实现，也不定义快照字段语义
（后者见 `openspec/specs/ciyuan-capability-endpoint/spec.md`）。

本 spec 明确**不**要求任何周期性刷新：三次实测（见 `openspec/changes/archive/2026-11-15-add-ciyuan-roster-visibility/proposal.md`）表明自动刷新的收益
（约 5 个模型 + 新鲜时间戳）与代价（229s/轮、88 个探测请求、一处新运维面）不成比例。

## Requirements

### Requirement: 探测年龄 MUST 可见

`discovery` 里每个条目的 `probedAt` 是那次判定的时刻，而判定会过期：名册与状态都可能几十天没重探。
消费方 SHALL 把「上次探测多久以前」显示在模型页上，取该 provider 名下**最新**的 `probedAt`；
当它早于 7 天时 MUST 以「陈旧」形态呈现（可辨识的样式 + 文案），MUST NOT 把陈旧判定渲染成
与今天判定无差别。

#### Scenario: 状态是 43 天前的

- **WHEN** 名册里所有条目的 `probedAt` 都早于 7 天
- **THEN** 模型页 SHALL 显示「上次探测 N 天前」并标注为陈旧
- **THEN** 它 MUST NOT 让「serving」看起来像是今天的实测结论

#### Scenario: 有条目不可用

- **WHEN** 名册里存在 `status != "serving"` 的条目
- **THEN** 同一处摘要 SHALL 给出不可用的条数（形如「2/5 不可用」）
- **THEN** 它 MUST NOT 因为摘要存在而隐藏逐条的徽标

#### Scenario: 从未探测过

- **WHEN** `discovery` 为空或没有任何可解析的 `probedAt`
- **THEN** 摘要 SHALL 显示「从未探测」，而不是「0 天前」
- **THEN** 该状态 MUST NOT 被呈现为陈旧（两者成因不同：一个是没跑过，一个是跑过但旧了）

#### Scenario: 逐条的 serving 徽标也要带年龄

- **WHEN** 用户查看某一行的 `serving` 徽标
- **THEN** 它的 tooltip SHALL 同时给出判定结果与该次判定的相对时间
- **THEN** 年龄 MUST NOT 只出现在非 serving 徽标上（否则「今天验过」与「43 天前验过」同形）

#### Scenario: 时间文本的方向正确

- **WHEN** 距上次探测不足 24 小时
- **THEN** 相对时间 SHALL 以小时为单位呈现（`Nh ago`），MUST NOT 以天为单位呈现
- **THEN** 同一页面上所有相对时间 MUST 由同一实现产出（两份拷贝分叉会让同一时刻显示出两种口径）
