# memory-distiller delta

## MODIFIED Requirements

### Requirement: 产物打标支线（tags 与 tier 候选）

fd-memory 蒸馏器 SHALL 对 reference 类条目给 tags 提议（≤5 个语义标签）与 tier 晋级候选判断；所有打标产物 MUST 标记为「AI 提议」来源；打标 MUST 受主人维度的日预算门控制（超门即延迟到下一窗口，不抗拒质量），且已在 ADR 预算门纪律之内；不依赖新外部服务。

**晋升候选的选材范围**：tier 晋级候选 SHALL 覆盖蒸馏产出的 L2 页型（fact、experience）与 reference 页型；选材 MUST NOT 以「是否已有 tag」为排除条件（已有 tag 的页仍可能该晋级），MUST 排除已达 `stable` 及以上的页。原「只对无 tag 的 reference 页提议」的范围限制取消——生产实测该范围仅覆盖 10 个 reference 页（其中 9 个已有 tag），使 tier 阶梯 99.8% 的页永远停留在 draft。

**AI 提议不直接晋级**：AI 产出的 Tier 晋级判断 MUST 作为「待确认提议」登记，MUST NOT 直接改写页的 tier；提议落定需人接受。AI 判断的最高落定层级为 `stable`，指向 `canonical` 时 MUST 降级为 `stable`；`tier_origin = human` 的页 MUST NOT 被 AI 提议覆盖（与既有封顶纪律一致，本次不放松）。

#### Scenario: auto capture 的草稿第二天有 tags

- **WHEN** 一新建 reference 页过打标窗口且无人类修正
- **THEN** 页上 tags 已就位、来源记 AI 提议，budget 摘要归因

#### Scenario: 预算门触发时的姿态

- **WHEN** 当 owner 日打标预算耗尽
- **THEN** 当批 reference 只登记不打标，下一窗口重补，不重跑已标条目

#### Scenario: 已打 tag 的 fact 进入晋升候选

- **WHEN** 一个 fact 页已有 tags 且 tier 仍为 draft
- **THEN** 该页进入晋升候选，不因其已有 tag 被排除

#### Scenario: 已达 stable 的页不再提议

- **WHEN** 一个 experience 页 tier 已是 stable
- **THEN** 它不进入晋升候选，避免重复提议

#### Scenario: AI 不直接提升 draft

- **WHEN** AI 判定某 draft 页值得升 stable
- **THEN** 该页 tier 保持 draft 直到人接受提议，提议本身记 AI 来源
