# tool-description-enrichment Specification

## Purpose
运行时工具描述增强：把注释层（`supply-annotation-overlay`）的 canonical brief 接入模型可见的工具面，让智能体读到策展的精准描述。铁律是只增强不改名——闭包闸、工具发现、参数 schema 全部按名字与形状校验，名字零动即零破坏；无注释或关闭开关时运行时行为与今天逐字节一致。

## Requirements

### Requirement: 增强经 overlay 通道生成与消费

profile 组装 SHALL 沿既有 patch 通道（与 tool-filter 同机制）生成 tool-description overlay：内容为 `{server+leaf → canonical brief, 来源, 注释更新时间}`，来源 SHALL 仅为注释层（`supply-annotation-overlay`）的人工策展 `canonical.brief`。dsh 运行时对有效 server 调 `tools/list` 时 SHALL 应用 overlay 到模型可见的工具描述。MUST NOT 存在第二条注入路径（平台代理改写、事件内联等）。

#### Scenario: 有注释工具的模型面获增强

- **WHEN** 一个生效 server 的某 tool 在注释层携带 canonical brief，会话 profile 组装
- **THEN** overlay 含该 tool 条目，模型可见描述按策略包含 brief 且标注来源

#### Scenario: 无 overlay 时行为不变

- **WHEN** 运行时无 overlay 文件（注释层无任何 canonical 或开关关闭）
- **THEN** `tools/list` 的工具描述与未引入本能力前逐字节一致

### Requirement: 追加默认、缺失替换的策略

对携带上游描述的工具 SHALL 默认**追加**（上游原文在前、brief 在后，可分辨）；上游描述缺失或为空 SHALL **替换**为 brief。任一策略 SHALL NOT 改变工具的 callable 名、server 名、leaf 名、参数 schema。

#### Scenario: 上游有描述时追加

- **WHEN** 一个 tool 上游描述非空且携带 brief
- **THEN** 模型可见描述含上游原文与 brief 两者，顺序可分辨

#### Scenario: 上游缺描述时替换

- **WHEN** 一个 tool 上游描述为空且携带 brief
- **THEN** 模型可见描述为 brief 本身

#### Scenario: 名字与 schema 零变化

- **WHEN** 增强生效前后分别枚举同一 server 的工具面
- **THEN** 两次的 callable 名集合、参数 schema 逐字节一致

### Requirement: 只增强不改名的不变式与闭包闸兼容

增强 SHALL NOT 改变闭包闸的输入：工具面快照的名字集合 SHALL 与增强前完全一致；快照 SHALL 附加增强计数与来源标注（可观测），MUST NOT 影响名字集合或校验结果。自报工具面对账（按名比对 live 面）SHALL 在增强开启时照常通过。

#### Scenario: 闭包闸结果不受增强影响

- **WHEN** 同一份 pack 的工具面闭包校验在增强开启与关闭两种情形下执行
- **THEN** 名字集合与校验结果完全一致，快照中仅增强计数/provenance 字段不同

### Requirement: publicFacing 生效面跳过增强

publicFacing pack 的生效工具面 SHALL 跳过增强（overlay 对其不生成条目）——「工具名和描述不泄内部词汇」的既有防线保持；被 publicFacing 删除的 server SHALL NOT 因增强复活。平台内置工具 SHALL NOT 增强。

#### Scenario: publicFacing 会话无增强

- **WHEN** 一个 publicFacing pack 的会话运行，其生效面某 tool 携带 brief
- **THEN** 模型可见描述为上游原文，brief 不出现

#### Scenario: 被删 server 不复活

- **WHEN** publicFacing pack 删除某内部 server 且该 server 注释齐全
- **THEN** 其工具不出现在生效面，与未引入本能力前一致

### Requirement: per-owner 开关与描述热更边界

owner SHALL 可关闭增强（默认开）；关闭时 overlay 不生成、行为回到纯上游。描述增强 SHALL 随 profile 组装再生生效——会话中途的注释更新 MUST NOT 侵入进行中的回合，下个组装周期生效（与 tool-filter 同节奏）。

#### Scenario: 关闭开关回到原状

- **WHEN** owner 关闭增强后新开会话
- **THEN** 全部工具描述与未引入本能力前逐字节一致

#### Scenario: 会话中途注释更新不侵入

- **WHEN** 会话进行中注释层的 brief 被更新
- **THEN** 当前会话的模型面不变，新组装的会话读到新 brief
