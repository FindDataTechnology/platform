## ADDED Requirements

### Requirement: reference 页型——大元物的薄索引名份

fd-memory SHALL 支持 `reference` 页型，面向不进本体的大元物（资料库文档、成果成品、URL 等）：每张 reference 页 MUST 携带 `title`、`summary`、≤5 个 `tags`、`tier`（draft|stable|canonical）与 `source_ref`（指向资料库存元行、成果项或外部 URL 的可解析指针）；MUST NOT 在页体内封存文件全部正文。reference 页与其它页同权参与 FTS 与向量索引，及 supersede/forgotten 语义。

#### Scenario: 成果文件在记忆里的呈现

- **WHEN** 一项成果经由 reference 页登记
- **THEN** 命中记忆查询时返回标题/摘要/tags/tier 与 source_ref，文件本体不进入结果

#### Scenario: reference 可被 supersede

- **WHEN** 同主题更高 tier 的 final 版 reference 登记
- **THEN** 草稿版本经 supersede 链被折收（链可查可撤销）

### Requirement: tier 三级分层语义（draft|stable|canonical）

fd-memory SHALL 为 reference 与产物类记忆条目提供三级分层：**draft**（草稿，默认自动捕获层）、**stable**（成果，用户开过/改过名/被对话引用过）、**canonical**（正典，钉住/被分享/被 prompt 召回引用/同题终审胜出）。晋级 SHALL 可由信号或手势触发；降级 SHALL 仅走 supersede 链并保留可下钻证据；任何 tier 变化都带来源（信号/人类手势/AI 提议）记录。digest 读缝与检索 SHALL 可按 tier 优先与过滤。

#### Scenario: 开过一次即晋级 stable

- **WHEN** 用户打开某 draft reference 的成果预览
- **THEN** 该页 tier 变为 stable，来源记为信号位

#### Scenario: 钉住上正典

- **WHEN** 用户执行「标为正典」手势
- **THEN** tier=canonical 带 human 用到来源；digest 召回正门优先呈现

### Requirement: digest 名份引用与 tier 优先

fd-memory 的 digest 读缝 SHALL 把 reference 类条目渲染为「名份+一句摘要」引用（如「见资料库《合同模板》」），不拖全文进 prompt；预算有限时 SHALL 优先 canonical，其次 stable，再 draft；tags SHALL 参与加权检索但不替罪主题词逾其作用；不可见与超时同既有降级纪律。

#### Scenario: 同题多版本下的 prompt 参考

- **WHEN** 同名题有 canonical 与多个 draft 版本
- **THEN** digest 注入青睐 canonical 名份一行，draft 默认不入
