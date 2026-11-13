## ADDED Requirements

### Requirement: 官方集合以规格书呈现

官方集合呈现面 SHALL 以三桶规格书呈现每个官方条目（消费共享规格书契约：三桶恒显、类型徽章、三轴 provenance、引导来自文档数据），而非仅徽章加筛选。匿名访客 SHALL 能看到官方条目的规格书呈现（沿官方集合匿名读语义），且匿名面不得下发 manifest 敏感结构（沿 pack-visibility「探测教不出东西」纪律——匿名读面给什么，规格书就只能显示什么）。

#### Scenario: 匿名访客看懂一支官方团队

- **WHEN** 匿名访客打开官方集合
- **THEN** 每支官方团队以规格书呈现（角色/技能/工具三桶、类型徽章、provenance、引导），无需登录

#### Scenario: 匿名面不放大敏感结构

- **WHEN** 匿名读面对某官方条目只提供摘要投影
- **THEN** gallery 的规格书按该投影渲染，不出现要求完整 manifest 才有的细节

### Requirement: 官方条目带克隆入口

官方集合的每个条目 SHALL 提供「克隆到我的工作室」入口，行为沿 `agent-fork-lineage` 契约（种子来自可读 manifest、落壹座 Studio 工作文档、血缘盖章）。匿名访客激活克隆 SHALL 得到登录引导（沿既有登录墙语义），不得直接执行写动作。

#### Scenario: 登录用户克隆官方团队

- **WHEN** 已登录用户在官方 gallery 对一支官方团队激活克隆
- **THEN** 壹座 Agent Studio 打开以该 manifest 为种子的可编辑工作文档，且未产生任何市场/部署实体

#### Scenario: 匿名访客的克隆是登录引导

- **WHEN** 匿名访客激活克隆入口
- **THEN** 呈现登录引导而非执行 fork；登录后重复该动作可完成克隆

### Requirement: starter 序列在 gallery 可见

官方集合 SHALL 标记五支官方 starter 团队的序列位置（说明卡数据与种子 manifest 同源，沿 `official-starter-teams` 既有语义），使新用户可循序列从 gallery 进入「装—看—学」路径。序列标记 SHALL 为呈现层注记，不改变三段聚合端点契约。

#### Scenario: 循序列学平台

- **WHEN** 新用户打开官方 gallery
- **THEN** 五支 starter 团队带序列标记且说明卡与市场详情同源；从任一卡可进入其市场详情与引导
