# memory-tier-promotion Specification

## Purpose

tier 晋升通道的人机分工：AI 可从草稿层提议晋级但永远不能越过 stable，canonical 只由人类手势或受信信号产生；提议必须落在人可见可批的面上，且晋升候选的选材要覆盖真正承载内容的页型，而不是只覆盖已有 tag 的少数索引页。

## Requirements

### Requirement: AI 提议最高到 stable，canonical 仅人／信号

系统 SHALL 允许 AI 对处于 `draft` 的页提议晋级，但 AI 提议的落定层级 MUST NOT 超过 `stable`；`canonical` MUST 仅由人类手势或受信信号产生，AI 提议指向 canonical 时 MUST 降级为 stable。已被标记为人工设定（`tier_origin = human`）的页 MUST NOT 被 AI 提议覆盖。

#### Scenario: AI 提议 canonical 被降为 stable

- **WHEN** AI 判定某 draft 页值得 canoncial，提议写入
- **THEN** 该页实际落定为 stable（或仍为待确认的 stable 提议），不出现 AI 产生的 canonical

#### Scenario: 人工位不被 AI 覆盖

- **WHEN** 某页 tier 由人类手势设为 stable 且 `tier_origin = human`
- **THEN** 后续 AI 提议不改写该页 tier，也不把 origin 改成 ai

#### Scenario: 人类可把页升到 canonical

- **WHEN** 人对某 stable 页执行晋级手势
- **THEN** 该页落定为 canonical 且 `tier_origin` 标记为 human

### Requirement: 晋升候选覆盖承载内容的页型

晋升候选的选材 SHALL 覆盖蒸馏产出的 L2 页型（fact、experience）以及 reference 页型；选材 MUST NOT 以「是否已有 tag」作为排除条件——已有 tag 的页同样可能该晋级。候选 MUST 排除已达 stable 及以上的页。

#### Scenario: 已打 tag 的 fact 仍进候选

- **WHEN** 一个 fact 页已有 tags 且 tier 仍为 draft
- **THEN** 该页出现在晋升候选中，不因其已有 tag 被排除

#### Scenario: 已达 stable 的页不再重复提议

- **WHEN** 一个 experience 页 tier 已是 stable
- **THEN** 该页不进入晋升候选，避免反复提议同一页

#### Scenario: reference 页仍被覆盖

- **WHEN** 存在无 tag 的 reference 页
- **THEN** 它仍按既有打标行为获得 tag，并可同时成为晋升候选

### Requirement: 提议必须人可见可批，AI 不直接晋级

晋升提议 SHALL 落在 owner 可读的「待确认」面上，携带候选页、当前 tier、提议 tier、提议理由；AI MUST NOT 在无人确认的情况下直接把 draft 提升为 stable。人 MUST 能对该提议执行接受或忽略，接受后该页 tier 生效且 `tier_origin` 标明 human。

#### Scenario: 提议可读

- **WHEN** AI 产出一批晋升提议
- **THEN** owner 在其记忆面上能看到这些提议及其理由，页的 tier 在被接受前保持不变

#### Scenario: 接受后生效且归因人

- **WHEN** owner 接受一条 draft→stable 提议
- **THEN** 该页 tier 变为 stable，`tier_origin` 为 human

#### Scenario: 忽略后不再重复骚扰

- **WHEN** owner 忽略一条提议
- **THEN** 该页在可配置的冷却期内不再被重复提议

### Requirement: 晋升通道计入预算且可观测

晋升提议调用 LLM 的消耗 SHALL 计入与打标相同的 per-owner 日预算门，超预算时 MUST 停止提议而不是绕过预算。系统 SHALL 在运维指标面暴露候选数、已提议数、被人接受数，使这条通道不成为新的暗管。

#### Scenario: 预算耗尽停止提议

- **WHEN** 某 owner 当日蒸馏预算已用尽
- **THEN** 晋升提议不再发起 LLM 调用，已有提议仍可被接受

#### Scenario: 指标可见

- **WHEN** 运维读取运维指标面
- **THEN** 能读到晋升候选数与接受数，可判断这条通道是否真在流动
