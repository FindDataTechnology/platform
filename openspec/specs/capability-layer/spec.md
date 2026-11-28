# capability-layer Specification

## Purpose
给能力（skills / MCP / memory / dashboard …）一个统一的对象：同一份推导能回答「这个 pack 提供什么」「这个团队怎么分工拿到什么」「这个 agent 实际能用什么」，并能在租赁场景下区分「没有这个能力」与「有这个能力但你看不见」。

## Requirements

### Requirement: 能力条目由三个正交轴构成

一个能力条目 SHALL 至少携带三个独立字段：`origin`（取值 `pack` / `team` / `agent` / `evolved`）、`visibility`（`private` / `tenant` / `public`）、`scope`（`shared` / `pinned` / `local`）。三轴 MUST NOT 互相推导——同一个 `origin=pack` 的条目可以是 `private` 且 `local`，同一个 `origin=evolved` 的条目也可以是 `shared`。

#### Scenario: 同源能力可以有不同可见性与一致性
- **WHEN** 两个 agent 从同一个 pack 继承了同名的 skill
- **THEN** 各自条目可以有不同 `visibility` 与 `scope`，且都不影响对方

#### Scenario: 轴不可从其他轴推断
- **WHEN** 某条目 `origin=evolved`
- **THEN** 其 `visibility` 与 `scope` 取声明的值，不由 `origin` 推断出默认

### Requirement: 三种作用域返回同一形状

系统 SHALL 提供 `deriveCapabilities(manifest, { scope })`，`scope` 取 `pack` / `team(memberRef)` / `agent(agentId)`。三种作用域 SHALL 返回同一形状（每条能力含三轴 + 来源引用），使任一展示面只需实现一种渲染。推导 SHALL 复用既有 `derivePillars` 的 memory / toolkit / dashboard 结果，MUST NOT 另写一套。

#### Scenario: pack 与 agent 两视图形状一致
- **WHEN** 同一 manifest 分别以 `scope=pack` 与 `scope=agent` 推导
- **THEN** 两者返回的条目具有相同的字段集合，仅条目集合不同

#### Scenario: 不重算支柱
- **WHEN** 推导 memory / toolkit / dashboard 三面
- **THEN** 结果与 `derivePillars` 对同一 manifest 的输出一致

### Requirement: 能力可以继承收窄，也可以扩展但须留出处

agent 声明 `resources.skills` / `resources.mcpServers` 时：取 pack 已提供条目的子集 SHALL 直接允许；声明 pack 未提供的条目 SHALL 允许，但该条目 MUST 携带 `lineage`（指向其演化来源，或显式标记 `origin: new`）。缺 `lineage` 的扩展 SHALL 被结构化拒绝并点名字段。

#### Scenario: 收窄不需要 lineage
- **WHEN** agent 只声明 pack 已提供的一部分 skill
- **THEN** 校验通过，不要求 lineage

#### Scenario: 扩展必须说明出处
- **WHEN** agent 声明一个 pack 未提供的 skill 且未给 lineage
- **THEN** 校验拒绝并点名该条目缺少 `lineage`

#### Scenario: 带出处的扩展通过
- **WHEN** 同一扩展声明携带 `lineage: {from: "<某 skill>", at: "<时间>"}`
- **THEN** 校验通过，该条目在推导结果里 `origin=agent`

### Requirement: 解析不出的声明必须被报告而非丢弃

当某个能力声明无法解析（引用不存在、被上游移除、可见性拒绝）时，系统 SHALL 在推导结果中返回「已解析」与「未解析」两段，未解析项 MUST 携带原因。MUST NOT 以 `filter` 之类的方式静默移除。

#### Scenario: 引用了不存在的 skill
- **WHEN** agent 声明了 `foo`，而 pack 与 agent 自身都没有该条目
- **THEN** 推导结果里 `unresolved` 含 `{name: "foo", reason: ...}`，且 `resolved` 不含它

### Requirement: 不可见的能力与不存在的能力必须可区分

对外投影时，`visibility` 不允许条目对调用方可见的情况下，结果 SHALL 呈现一个 opaque 占位（含「由提供方维护」一类的说明），MUST NOT 表现为该能力不存在。默认 `visibility` SHALL 为 `private`。

#### Scenario: 默认不可见
- **WHEN** 一个租来的 agent 未显式配置可见性
- **THEN** 承租方看到的是 opaque 占位而非空缺

#### Scenario: 显式放开后可读
- **WHEN** 提供方把某条目的 `visibility` 配为 `tenant`
- **THEN** 同租户内的调用方能看到该条目的三轴与引用

### Requirement: 演化策略由使用者选择

能力层 SHALL 暴露演化策略 `mode`，取值 `manual` / `auto-low-risk` / `agent-decides`。策略 SHALL 是声明，MUST NOT 被硬编码进推导逻辑。`agent-decides` 下 agent 对自身 `local` 能力的写入 SHALL 被接受。

#### Scenario: 手动模式下不自动生效
- **WHEN** `mode = manual` 且 agent 提议一项能力变更
- **THEN** 该变更停在候选态，等待人决定

#### Scenario: agent 自主模式下接受写入
- **WHEN** `mode = agent-decides` 且 agent 写入一项 `scope=local` 的能力
- **THEN** 该写入被接受并出现在后续推导中
