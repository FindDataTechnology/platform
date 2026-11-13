## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: 总门面四区结构

**Reason**: W2 四区解体（roadmap §4）：构建/我的创作/供给三区迁供给域，调优升壹座原生面；`/agents` 不再承载四区门面。
**Migration**: 构建区→供给域 Studio 深链；供给区→供给域市场深链；我的创作→供给域控制台深链；调优→壹座原生调优面（本 change MODIFIED「调优区承载候选评审」）。`/agents` 深链 query 到旧区的映射由重定向表承接，MUST NOT 404。

### Requirement: 供给区三柜合一

**Reason**: 三柜的供给呈现由供给域市场（门厅/橱窗，W1 统一目录投影）承接；壹座内不再复刻第二份供给目录面。
**Migration**: pack 市场柜→市场深链；技能柜/MCP 柜的**管理**行为由 Settings 原生区继续承载（`settings-surface` 别名入口保留不动，`extension-management-ui` 契约不变）；装机动作面板承接「装进我的工作台」。

### Requirement: 我的创作区聚合创作资产

**Reason**: 创作资产（pack 草稿与 manifest 编辑器）随创作面迁供给域；自建预设管理归调优/运行语境。
**Migration**: pack 草稿与 manifest 编辑器→供给域控制台（`supply-studio` 发布链）；自建预设管理入口由 Settings 原生区继续承载（`custom-presets` 契约不变）。

### Requirement: 既有入口收编前不删

**Reason**: 收编已完成（本能力自 2026-10-30 上线以来的守卫条款兑现完毕），W2 四区解体后其前提（四区门面存在）不再成立。
**Migration**: `/settings/packs`、`/settings/presets` legacy 重定向改指 Settings 原生面或市场深链，MUST NOT 404（回归钉进 e2e）；`/studio` 直达退役为供给域重定向（`agent-builder-workspace` REMOVED 项迁移条目）。
