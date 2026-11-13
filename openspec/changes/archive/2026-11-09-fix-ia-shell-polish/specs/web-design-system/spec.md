## ADDED Requirements

### Requirement: Micro-labels are script-aware

外壳存在一类极小的「标签」文字：导航家族头（知识/构建/运行/接入）、设置分组头（常规/能力/管理）、项目切换器的当前项目标签、构建家族快捷行。此类角色 SHALL 收敛为单一语义微标签类 `micro-label`，MUST NOT 由各组件各自写字号/字距字面量。该类 SHALL 随文档语言分档，语言由 i18n 层已维护的 `<html lang>` 驱动：拉丁语种保持小体大写习语（≈11px、`uppercase`、轻微正字距）；`zh-CN` 与 `ja` SHALL 取更大字号（≈12px），MUST NOT 施加 `text-transform: uppercase`（对汉字无操作，只在他处增加噪声），MUST NOT 施加正字距。规则 SHALL 按角色生效而非按组件生效：同角色的未来标签自动继承，组件 MUST NOT 为这些角色重新引入字号字面量。中日文标签内混入拉丁缩写时，MUST NOT 以斜杠拼接成单一主标签（如 `工具 / MCP`），缩写 SHALL 退居次级位置（副标题/提示），或该标签只陈述单一语种的名称。本需求 MUST NOT 改变任何拉丁语种的渲染（英文 UI 为基准，不得位移）。

design-lint 棘轮 SHALL 承接该规则：在既有六类规则之外，对 `web/src/pages/**` 与 `web/src/components/**`（共享原语目录豁免）扫描微标签角色上的字号/字距/大小写字面量（`text-[10px]`、`text-[11px]`、`uppercase`、`tracking-wide` 直接写在标签元素上）。现存违规 SHALL 以「文件+规则→计数」的基线清单入账；变更集内文件出现基线之外的新违规 MUST 判红，基线内计数只允许随迁移下降（棘轮）。

#### Scenario: 中文家族头不加大小写与字距

- **WHEN** 文档语言为 `zh-CN`，侧栏渲染「知识/构建/运行/接入」家族头
- **THEN** 该标签以不超过 12px 的字号呈现，且计算样式无 `uppercase` 变换、无正字距

#### Scenario: 英文家族头维持小体大写习语

- **WHEN** 文档语言为 `en`，侧栏渲染同一家族头
- **THEN** 该标签维持约 11px、大写变换与轻微正字距，渲染结果与本需求落地前的英文 UI 逐项一致

#### Scenario: 运行时切语种即时重渲染

- **WHEN** 用户在应用内把语言从 `en` 切到 `zh-CN`（不刷新页面，`<html lang>` 随之更新）
- **THEN** 已挂载的微标签无需重载即按中文字档重渲染，字号变大且不再大写、不再加字距

#### Scenario: 硬编码字号即红

- **WHEN** 一个组件为微标签角色直接写 `text-[10px]` 或 `uppercase tracking-wide` 并跑 design-lint
- **THEN** 检查失败并指名文件与规则（未被基线覆盖的新违规判红）

#### Scenario: 混排标签不斜杠拼接

- **WHEN** 一枚标签同时承载中文词与拉丁缩写（如「工具」与「MCP」）
- **THEN** 该缩写不出现在以斜杠连接的主标签文本中，而是呈现于副标题或提示等次级位置，或主标签只显示单语种名称
