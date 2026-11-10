# agent-builder-hub Specification

## Purpose
壹座智能体构建器总门面：把已建成的三栏构建器、pack 市场、技能柜、MCP 柜、我的创作与调优面收拢为 sidebar 一级入口「智能体构建器」下的四个区，让「想构建智能体的人」有一个明确的正门；各区行为契约归既有能力（agent-studio / pack-marketplace / extension-management-ui / extension-marketplace / custom-presets / skill-self-evolution），本能力只管门面结构、定名、承接与可达性。

## Requirements

### Requirement: 一级门面入口与五语言定名

sidebar SHALL 以既有 Agents 入口（slug `agents`、路由 `/agents` 不变）承载供给域市场一级入口，标签 SHALL 定名为「智能体市场」，五语言词条 SHALL 为：zh-CN 智能体市场（主轨）、en Agent Market、ja エージェントマーケット、es Mercado de Agentes、fr Marché d'Agents。词条 SHALL 经 i18n bundle 解析并随词表登记。点击入口 SHALL 跳转供给域市场门厅（外部深链）并在面板内提供装机动作面板（本机已装包/可装机列表，行为按 `pack-installation` 契约）；标签更名 MUST NOT 改变入口的 slug、图标 testid、路由或布局解析身份（per `layout-configuration`）。

#### Scenario: locale 切换换标签不换身份

- **WHEN** 用户把 locale 从 zh-CN 切到 en
- **THEN** 该入口标签 SHALL 从「智能体市场」变为「Agent Market」
- **AND** slug、图标、testid、路由 SHALL 保持不变，布局解析与隐藏/排序行为不受影响

#### Scenario: 词表登记

- **WHEN** 本能力归档
- **THEN** 词表 SHALL 出现「智能体市场」五语言行，与 i18n 词条逐语言一致

### Requirement: 调优区承载候选评审

调优 SHALL 成为壹座原生面（独立路由与入口，脱离已解体的 `/agents` 四区门面，入口挂 workspace 语境可发现）；调优面 SHALL 渲染技能候选评审：候选列表、评测报告查看、接受、驳回（行为契约归 `skill-self-evolution`）；并为 persona 修订评审预留占位（`add-persona-self-evolution` 落位前 SHALL 呈现「暂无修订」空态而非隐藏本区）。调优面 MUST NOT 提供绕过人终审的晋升入口。

#### Scenario: 候选评审落位

- **WHEN** owner 名下存在技能候选并从原生调优面进入
- **THEN** 调优面 SHALL 列出候选并可比对评测报告，接受/驳回动作与 `skill-self-evolution` 契约一致

#### Scenario: persona 修订占位

- **WHEN** persona 修订能力未上线
- **THEN** 调优面 SHALL 呈现修订分区的空态说明，MUST NOT 渲染可写的修订控件
