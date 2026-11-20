## Purpose

部署者（owner）对自己记忆的可读与可忘：按 scope / 层（L0-L2）/ 时间的筛选读取面，与带审计、可确认的逻辑删除（forget）——agent 面不扩权，可见性只对人。

## Requirements

### Requirement: owner 可按 scope / 层 / 时间筛读自己的记忆

fd-memory SHALL 暴露 owner 范围的记忆读取面（HTTP，person 令牌）：按 scope（project 名）、层（L0 观测 / L1 交接与笔记 / L2 事实与经验）、时间区间过滤，分页返回条目摘要（类型、标题、时间、layer、sources、project）；person 令牌 MUST 只见自己 owner root 下的内容。agent（deployment / pod）令牌 MUST NOT 使用该面——agent 的读取仍走各自 MCP 面，不因可见性面获得 owner 级枚举能力。

**平台缝变体**：platform / runner 族令牌（与 `/admin/report` 同信任级的受信平台缝）SHALL 可以显式 `rootKey` 参数调用该面读取对应 root 的记忆——deployer 可见性经此车道由受信调用方（facade 等）承载，fd-memory 自身不解析 deployer 身份或 packId 映射；不带 rootKey 的非 person 调用 MUST 结构化拒绝。

#### Scenario: 部署者筛出某项目的 L2 经验

- **WHEN** person 令牌以 scope=<project>&layer=L2 查询
- **THEN** 返回该项目全部 fact / experience 摘要，含时间与 sources，不含其他 project 条目

#### Scenario: agent 令牌被拒

- **WHEN** 一枚 deployment 令牌调用可见性读取面（带或不带 rootKey）
- **THEN** 结构化拒绝，无内容返回

#### Scenario: 平台缝带 rootKey 读部署根

- **WHEN** platform 令牌以 rootKey=d-<packId>&scope=<project>&layer=L2 查询
- **THEN** 返回该 pack 根下对应条目摘要；审计/调用可由运维面追溯
### Requirement: forget 是带确认的逻辑删除且审计可查

fd-memory SHALL 提供 `forget`：对指定页面做逻辑删除——frontmatter 落 `forgotten_at`、派生索引剔除该页（查询 / recent 不再返回）、markdown 真源文件保留（审计与申诉依据）；MUST 要求显式确认参数（防误删），每次 forget MUST 落审计行（主体、scope、页面、时间）。被 forget 的页 MUST NOT 再被任何面返回；蒸馏 MUST NOT 以被 forget 的页为候选或来源续写。**平台缝变体**：platform / runner 族令牌 SHALL 可以显式 `rootKey` 参数执行 forget（同确认参数与逻辑删语义，审计主体为该令牌身份）；agent 族 MUST NOT。

#### Scenario: forget 后查询不现

- **WHEN** owner 对一条 experience 执行 forget 后以 query / recent / 可见性面检索
- **THEN** 该页不再出现在任何结果中，其 markdown 真源与审计行仍在

#### Scenario: 无确认参数拒绝

- **WHEN** forget 调用不带确认参数
- **THEN** 结构化拒绝，无任何变更

#### Scenario: 蒸馏不吃被忘条目

- **WHEN** 某经验被 forget 后该 scope 再蒸馏
- **THEN** 候选集不含该页，也不以其为 supersedes 目标

#### Scenario: 平台缝 forget 带审计主体

- **WHEN** platform 令牌以 rootKey 对某页执行带确认的 forget
- **THEN** 页面从全部读面消失，审计行主体为该 platform 令牌身份

### Requirement: visibility 读取面扩 tier/tags 与 reference

fd-memory visibility 读取面 SHALL 支持 reference 页型条目的枚举并在列表摘要中返回 `tier` 与 `tags` 字段；筛选 SHALL 增加 tier（单选）与 tag（单选或多选）维度，与现有 scope/layer/time 可叠加；person/rootKey 令牌语义与正反身份拒绝不变，agent 族仍不得使用该面。

#### Scenario: 按 tier+tag 筛 reference

- **WHEN** person 令牌以 tier=canonical&tag=章程 查询
- **THEN** 只返回命中 reference 摘要，含 tier/tags 与时间

#### Scenario: agent 调用该筛选被拒

- **WHEN** deployment 令牌带 tier 筛选调用读取面
- **THEN** 结构化拒绝，结果为空
