# design — simplify-chat-and-agents-ia

> 2026-10-22 explore 定稿（用户授权代决）。四个方向性拍板 D1–D4 及落地形态见下；
> 动机与六症状三根因见 proposal.md，不重复。

## Context

现状机制（全部已实锤于代码）：

- **双 roster 双入口**：dsh 会话由 preset 组合而成，preset 固定于会话创建（产生过
  回合后不可重组）。功能集角色经 catalog pack source 物化为「本地 persona preset」
  （`pack-store.js:8`、`catalog.js:376`），于是同时进入 preset roster（欢迎态
  「模式」下拉，`AgentPresetPicker`）和 agent roster（⋯ 菜单「智能体」区，
  `ControlStrip.tsx:812+`）。在 ⋯ 菜单选本地包角色，底层就是 preset 切换并重启
  runtime（`ControlStrip.tsx:22` 注释自证）。
- **深链已建成但被门住**：`ChatPage.tsx:50` 支持 `?preset=<agentId>` 自动
  `set_agent` 并以 `configErrorSeq` 处理失败，但仅在 `embed=copilot` 下生效。
- **tabs 是配置**：智能体页 tabs 由 `resolvedLayout.agentsTabs`（服务端
  `layout-configuration`）控制，导航同理——收 tab 是配置级改动。
- **双应用页同源**：智能体页「应用」tab 与应用中心都读 `/api/catalog` 的 apps；
  应用中心另有 `/api/connections` 四态徽章、看板入口与嵌入代理路由。
- **dsh 约束不可绕**：persona/整组切换 = 重启 runtime，pending 语义沿用
  `pendingConfig`；组合模式切换在会话产生回合后本就不可用，本设计不试图改变。

## Goals / Non-Goals

**Goals:**

- 用户可见概念收敛为三个：**助手**（和谁说话）、**功能集**（它有什么本事）、
  **项目**（它在哪干活）——全部用既有词汇，不发明新概念。
- 安装→对话直通（原 Q6）作为首个任务，可独立上产、独立回滚。
- 改动尽量落在展示层与布局配置层，服务端通道零改动。

**Non-Goals:**

- 不改 dsh preset 组合机制；不合并 preset/agent 两条服务端 roster（只在 UI 层合并）。
- 不动集群 A2A 服务机制与动态集群 API（`/api/clusters/*` 原样复用）。
- 不做移动端适配（`add-mobile-app` 在途，另行对齐）。
- 不动谦面（facet）/工坊侧界面（名词统一可后续跨产品对齐）。

## Decisions

### D1 出厂组合模式：普通用户只留「标准助手」

「与谁对话」选人器中，出厂组合模式默认只出现「标准」；PTC/极简隐去，创造
（cordis）归入「我的专家」创作流入口。**展示层过滤**：picker 对 preset roster 中
`SHIPPED_PRESET_IDS − {standard}` 过滤，roster 数据与服务端不动。角色布局后续可
放行（layout 谓词），不在本 change 内。

否决备选：全保留（「和谁说话」的控件里混入「运行时怎么组装」正是 Q1 根因）；
按用户开关配置（多一个设置项 = 又一个要解释的概念）。

### D2 集群：消费在对话，管理在专家页

「与谁对话」列表给集群一个**整组条目**：选中 = `POST /api/clusters/dynamic`
（`bindToSession`，现 ⋯ 菜单「载入人群」同一路径）+ 切 lead 角色。智能体页
「专家」tab 保留集群管理区（创建/详情/解散，现状不动）。集群成为选人列表里的
一等公民，而不是藏在 ⋯ 溢出菜单的次级按钮。

否决备选：智能体页独立「集群」一级 tab（多一个一级概念，且用户的消费动作——
「和这一组对话」——发生在对话侧，页面只应是它的管理处）。

### D3 「我的功能集」+「我的创作」合并为「我的」

功能集子 tab 收为 **市场 | 我的**；「我的」内部分「已安装」「我的创作」两段。
创作者流程（草稿→发布→报告）在「我的创作」段内完整保留，preset 转换 handoff
（`hasBridgeHandoff`）落点从 drafts tab 改为 我的·创作段锚点。

否决备选：保持三 tab（对只装不创的用户，「我的创作」是永久空 tab 的认知税；
对既写又装的创作者，同一包出现两份记录；且两个命名不对称——一个按物、一个按行为）。

### D4 切法：一个 change，Q6 直通为首任务

全部收敛由本 change 承载；任务序：**① 安装→对话带参直通**（放宽 `?preset` 门
至普通导航 + CTA 带参 + 多角色包 CTA 变「去对话并载入整组」）→ ② 选人器合并 →
③ 项目名词统一 → ④ agentsTabs 收敛 → ⑤ 应用合并 → ⑥ 功能集子 tab 合并。
①可独立上产独立回滚。

否决备选：Q6 单开小 change 先行（它与 ② 同写 `agent-preset-selection` 的 spec
delta，拆开 = 两份姊妹 delta 排序风险，本仓已有教训）。

### D5 名词统一（全部走 i18n）

| 退役词 | 统一为 | 主要 key |
|---|---|---|
| 模式 / 智能体（选人语境） | **与谁对话**·条目称助手 | `chat.preset.*` → `chat.assistant.*` |
| 工作目录 | **会话项目**（默认显示项目名） | `composer.strip.workspace*` |
| 项目写入（权限 chip） | 仅对话 / 可读写项目文件 / 完全访问 | `composer.strip.permission*` |
| 行业方案（tab 名） | **功能集** | `agentsPage.market` |
| 我的功能集 / 我的创作 | 我的（内含已安装 / 我的创作） | `packs.tabs.*` |

### D6 合并选人器：数据源与去重

列表主源 = **agent roster**（自带 `packId`/`customPreset`/`clusterId` 元数据与
聚焦徽章）；preset roster 仅贡献组合模式条目（经 D1 过滤后通常只剩「标准」）。
pack 角色条目以 agent roster 为准，preset roster 中的物化同名条目不重复渲染。
**映射已核对（apply 1.1）**：`dsh-profile.rosterPresetId(catalogId)` =
`catalogId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")`——去重键 = 把两侧 id
都过同一变换后比对（pack 角色多为小写杠 id，两侧恒等；含大写/下划线的 id
靠变换归一）。欢迎态与会话中渲染同一组件；会话产生过回合后组合
模式不可换（dsh 约束，现行为），助手/整组切换走 `set_agent`（重启 runtime，
`pendingConfig` 语义沿用）。ChatHeader 只读标签同步改名。

### D7 应用合一方向：删 tab、进应用中心

`agentsTabs` 默认序列移除 `apps`；nango 连接 / 外部服务嵌入 / 外链三类卡并入
应用中心统一网格（`connectPathFor`、`/external/:id`、nango connect 代理均已
存在）。apps slug 保留注册表兼容，旧深链 `?tab=apps` 由 layout-configuration
既有回落行为兜底；角色布局若显式含 apps，由管理员决定去留。

## Risks / Trade-offs

- [在途 `copilot-dock-focused-preset` 同面冲突] → spec delta 与 apply 排在其归档
  之后；delta 写作错峰（ADDED 优先、MODIFIED 精确引用归档后的主 spec 版本）。
- [合并选人器破坏既有验收面] → `agent-preset-picker` testid 保留语义或映射更新；
  选人器合并任务必须带突变测试（本仓纪律：模块绿 ≠ 活体绿）。
- [preset↔agent id 映射不确定] → apply 首任务核对写入路径（见 Open Questions），
  只影响去重实现细节，不影响设计方向。
- [移除 apps tab 后旧深链/角色布局引用] → slug 保留 + 回落行为既有；管理员侧
  文档提示。
- [五语种 i18n] → zh-CN 先行全量，其余语种键回退，随后补齐（本仓既有惯例）。

## Migration Plan

纯 web 面 + 布局配置：随 web 镜像常规出片（`paas-release`）。回滚 = 镜像回滚 +
`resolvedLayout` 默认序列恢复（服务端配置回滚即恢复三 tab），D1 过滤与 D6 合并
互不依赖可分车。真机验收以 aloadtree 账号走「安装→直通→选人→整组」全链。

## Open Questions

- 物化 persona preset 的 id 与 agent id 的确切映射规则（D6 去重细节）——apply
  首任务核对 catalog pack source 写入路径即可定，不改方向。
- 开发者角色布局是否放行 PTC/极简/创造（D1 的 layout 谓词路径）——可后补，
  不影响本 change。
