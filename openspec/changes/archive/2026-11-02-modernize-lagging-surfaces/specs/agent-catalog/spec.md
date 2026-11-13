# agent-catalog Delta Spec

## ADDED Requirements

### Requirement: 目录卡的头像纪律与信息层级

智能体目录卡（构建器总门面的供给/创作区沿用同一卡）SHALL 采用统一头像体系：单一色系字母/字形头像或统一图标体系，MUST NOT 以高饱和多色 emoji 拼贴与主操作争夺注意力；卡内信息层级 SHALL 固定为 名称 → 一句话职责 → 状态/统计 → 标签，标签数量上限 3，超出收纳进 Tooltip；主操作蓝色 SHALL 全目录至多每卡一处。

#### Scenario: 头像不抢灯

- WHEN 目录同时渲染 10 张以上智能体卡
- THEN 头像均为统一色系字形/图标，页面不存在多色 emoji 头像墙

#### Scenario: 标签溢出收纳

- WHEN 某卡片标签超过 3 个
- THEN 仅显示前 3 个，其余以 Tooltip 呈现完整清单
