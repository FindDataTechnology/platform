## ADDED Requirements

### Requirement: 产物打标支线（tags 与 tier 候选）

fd-memory 蒸馏器 SHALL 对 reference 类条目给 tags 提议（≤5 个语义标签）与 tier 晋级候选判断；所有打标产物 MUST 标记为「AI 提议」来源；打标 MUST 受主人维度的日预算门控制（超门即延迟到下一窗口，不抗拒质量），且已在 ADR 预算门纪律之内；不依赖新外部服务。

#### Scenario: auto capture 的草稿第二天有 tags

- **WHEN** 一新建 reference 页过打标窗口且无人类修正
- **THEN** 页上 tags 已就位、来源记 AI 提议，budget 摘要归因

#### Scenario: 预算门触发时的姿态

- **WHEN** 当 owner 日打标预算耗尽
- **THEN** 当批 reference 只登记不打标，下一窗口重补，不重跑已标条目

### Requirement: 修正回灌学习词表

人类/AI 对 tag 或 tier 的修正 SHALL 写为 correction note（含改前改后与来源）；后续打标 SHALL 在读同一 owner 的近期 correction 后适配词表与判定，避免重写同样的判读；蒸馏产物可向下修正但禁止覆盖人类确认位未推翻的决定。

#### Scenario: 用户改 tag 后新知识生效

- **WHEN** 用户把 tag「合同」改为「章程」后同主题新 reference 打标
- **THEN** 新 tags 贴近用户词表（优先「章程」），原修正 note 仍可查
