## ADDED Requirements

### Requirement: 成果页三层 tier 收纳

成果页 SHALL 在类型组筛选之外提供 tier 视图：默认按「草稿（draft）/ 成果（stable）/ 正典（canonical）」三层收纳或按 tier 徽章列表展示，各层带计数；tier 视图与现有类型/时间筛选可叠加；未配置记忆服务的部署 SHALL 灰态隐层不报错；i18n 走既有 bundle。

#### Scenario: 一进页面看见风格区分

- **WHEN** 用户进成果页且多 tier 混合
- **THEN** 三层层头与计数清晰，草稿视觉权重低于正典

### Requirement: tags 列与筛选

成果页条目 SHALL 显示 tags（为多测）；筛选栏 SHALL 提供 tag 筛选（可多选），与 tier/类型/时间互筛选；AI 提议的 tag 徽标与人类确认的未标区分；无 tag 的条目不得消失，以一个「未打标」组显系。

#### Scenario: 按 tag「章程」筛选

- **WHEN** 用户勾选 tag=章程
- **THEN** 只显示已标「章程」的条目（人类确认与 AI 提议各异色）

### Requirement: 三手势（记住 / 标为正典 / 改 tag）

成果页每条目 SHALL 提供「记住」、「标为正典」、「改 tag（增/删/改）」三手势；手势 SHALL 经服务端写面生效（直接改真源并同步镜像），AI 发发与人工位在 UI 明示；改 tag 的弹窗 SHALL 支撑 AI 建议接受/修改/删除；手势失败 SHALL 走降语反馈而不置乱态。

#### Scenario: 弹窗接受一个 AI 提议 tag 并删另一个

- **WHEN** 用户在改 tag 弹窗一键接受「章程」并删「备ಿ」
- **THEN** 页面即时反映新 tags，并各自记人/AI 来源
