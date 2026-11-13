## Purpose

壹座智能体构建器总门面：把已建成的三栏构建器、pack 市场、技能柜、MCP 柜、我的创作与调优面收拢为 sidebar 一级入口「智能体构建器」下的四个区，让「想构建智能体的人」有一个明确的正门；各区行为契约归既有能力（agent-studio / pack-marketplace / extension-management-ui / extension-marketplace / custom-presets / skill-self-evolution），本能力只管门面结构、定名、承接与可达性。

## ADDED Requirements

### Requirement: 一级门面入口与五语言定名

sidebar SHALL 以既有 Agents 入口（slug `agents`、路由 `/agents` 不变）承载一级门面，标签 SHALL 定名为「智能体构建器」，五语言词条 SHALL 为：zh-CN 智能体构建器（主轨）、en Agent Builder、ja エージェントビルダー、es Constructor de Agentes、fr Constructeur d'Agents。词条 SHALL 经 i18n bundle 解析并随 `docs/roadmap-agents-native-teams.md` 词表 v4 附录登记。标签更名 MUST NOT 改变入口的 slug、图标 testid、路由或布局解析身份（per `layout-configuration`）。

#### Scenario: locale 切换换标签不换身份

- **WHEN** 用户把 locale 从 zh-CN 切到 en
- **THEN** 该入口标签 SHALL 从「智能体构建器」变为「Agent Builder」
- **AND** slug、图标、testid、路由 SHALL 保持不变，布局解析与隐藏/排序行为不受影响

#### Scenario: 词表登记

- **WHEN** 本能力归档
- **THEN** 词表 v4 附录 SHALL 出现「智能体构建器」五语言行，与 i18n 词条逐语言一致

### Requirement: 总门面四区结构

`/agents` 面板 SHALL 渲染四个区：**构建**（三栏构建器的直达入口，指向 `/studio`）、**供给**、**我的创作**、**调优**。四区 SHALL 可在面板内切换，且 SHALL 支持深链（query 参数）直达任一区。四区 SHALL 只是既有面的重组承接：构建区、供给各柜、我的创作、调优区渲染的行为 SHALL 分别按既有能力契约执行，本能力 MUST NOT 引入新的数据形状、端点或校验器。

#### Scenario: 默认落区与切换

- **WHEN** 用户经 sidebar 进入 `/agents`
- **THEN** 面板 SHALL 呈现四区切换结构，默认落「构建」区
- **AND** 切换到任一区 SHALL 只换区面板，不离开 `/agents` 路由

#### Scenario: 深链直达

- **WHEN** 用户访问带区参数的 `/agents` 深链（如指向供给区）
- **THEN** 面板 SHALL 直接落对应区且该区内容完整可见

### Requirement: 供给区三柜合一

供给区 SHALL 在同一区内提供三柜切换：**pack 市场柜**（承接 `pack-marketplace` 的浏览/详情/安装行为）、**技能柜**（承接 `extension-marketplace` 与 `extension-management-ui` 的技能供给与管理行为）、**MCP 柜**（承接 MCP 目录与管理行为）。三柜 SHALL 复用既有组件与端点，MUST NOT 派生第二套数据读取。Settings 中的 MCP/技能区 SHALL 继续可用（别名入口，per `settings-surface`），与供给区渲染同一组件，两处呈现 MUST NOT 分叉行为。

#### Scenario: 三柜切换

- **WHEN** 用户在供给区依次切换三柜
- **THEN** pack 市场柜、技能柜、MCP 柜 SHALL 分别渲染对应既有面板
- **AND** 各柜的浏览、搜索、安装、管理行为与迁入前一致

#### Scenario: Settings 别名不分叉

- **WHEN** 用户分别从供给区 MCP 柜与 Settings 的 MCP 区查看同一台已安装 server
- **THEN** 两处 SHALL 渲染同一组件的同一状态（启用态、配置、删除入口一致）

### Requirement: 我的创作区聚合创作资产

我的创作区 SHALL 聚合：pack 草稿与 manifest 编辑器入口（承接既有「我的创作」面）、自建预设管理入口（承接 `custom-presets` 的管理行为）。两入口 SHALL 复用既有面，本区 MUST NOT 新增写路径。

#### Scenario: 草稿与预设可达

- **WHEN** 用户进入我的创作区
- **THEN** 既有 pack 草稿/manifest 编辑器与自建预设管理 SHALL 均可直达
- **AND** 草稿的新建、编辑、发布走既有端点不变

### Requirement: 调优区承载候选评审

调优区 SHALL 渲染技能候选评审面：候选列表、评测报告查看、接受、驳回（行为契约归 `skill-self-evolution`）；并为 persona 修订评审预留占位（`add-persona-self-evolution` 落位前 SHALL 呈现「暂无修订」空态而非隐藏本区）。调优区 MUST NOT 提供绕过人终审的晋升入口。

#### Scenario: 候选评审落位

- **WHEN** owner 名下存在技能候选
- **THEN** 调优区 SHALL 列出候选并可比对评测报告，接受/驳回动作与 `skill-self-evolution` 契约一致

#### Scenario: persona 修订占位

- **WHEN** persona 修订能力未上线
- **THEN** 调优区 SHALL 呈现修订分区的空态说明，MUST NOT 渲染可写的修订控件

### Requirement: 既有入口收编前不删

本门面 SHALL 保持六个既有构建入口与 `/studio` 直达路由全部可达；legacy 重定向（`/settings/packs` → `/agents` 市场、`/settings/presets` → `/agents`）SHALL 继续解析，目标 query 参数 SHALL 映射到门面重组后的对应区柜（市场 → 供给区 pack 市场柜）。面板重组 MUST NOT 造成任一既有入口 404 或行为丢失。

#### Scenario: legacy 重定向落对柜

- **WHEN** 用户访问 `/settings/packs`
- **THEN** 路由 SHALL 重定向到构建器门面并落在供给区的 pack 市场柜

#### Scenario: studio 直达保持

- **WHEN** 用户直接访问 `/studio`
- **THEN** 三栏构建器 SHALL 照常渲染，且门面构建区入口可达同一路由
