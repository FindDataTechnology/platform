## ADDED Requirements

### Requirement: visibility 读取面扩 tier/tags 与 reference

fd-memory visibility 读取面 SHALL 支持 reference 页型条目的枚举并在列表摘要中返回 `tier` 与 `tags` 字段；筛选 SHALL 增加 tier（单选）与 tag（单选或多选）维度，与现有 scope/layer/time 可叠加；person/rootKey 令牌语义与正反身份拒绝不变，agent 族仍不得使用该面。

#### Scenario: 按 tier+tag 筛 reference

- **WHEN** person 令牌以 tier=canonical&tag=章程 查询
- **THEN** 只返回命中 reference 摘要，含 tier/tags 与时间

#### Scenario: agent 调用该筛选被拒

- **WHEN** deployment 令牌带 tier 筛选调用读取面
- **THEN** 结构化拒绝，结果为空
