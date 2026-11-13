# simplify-chat-and-agents-ia — 对话与智能体信息架构收敛

> 2026-10-22 explore 定稿（用户授权代决）。源起：用户真机走查提出六处困惑，
> 归因为三个根因——一物多名、dsh 机制概念裸露、页面按数据源而非用户任务组织。

## Why

用户无法回答六个基本问题：「模式」与右下角「智能体」的区别、为什么要选「工作目录」、
专家与行业方案的区别、智能体页「应用」与应用中心的区别、「我的功能集」与「我的创作」
的区别、以及安装功能集后为什么要自己再去对话里手动选人。实锤：功能集角色被物化为
persona preset 后**同时**进入 preset roster（欢迎态「模式」下拉）和 agent roster
（⋯ 菜单「智能体」区）——同一实体、两条通路、两套词汇（`pack-store.js:8`、
`ControlStrip.tsx:22` 注释自证「a vertical pack is a persona preset」）；工作目录
（dsh workspace）在侧边栏叫「项目」、在 ⋯ 菜单裸露绝对路径；智能体页「应用」tab
与应用中心读同一个 `/api/catalog` 却是两张页面；安装报告的「打开对话」CTA 是裸
`navigate("/chat")`（`PackMarketView.tsx:325`），而 `?preset=` 深链自动选人机制
已存在却被 `embed=copilot` 门住（`ChatPage.tsx:50`）。

## What Changes

- **合并选人入口**：欢迎态「模式」下拉与会话中 ⋯ 菜单「智能体」区合并为一个
  「与谁对话」选择器；出厂组合模式（PTC/极简/创造）默认隐去（展示层过滤，roster
  不动），cordis 归入自建专家创作流；集群以「整组载入」条目升入选人主列表。
- **名词统一（项目）**：⋯ 菜单「工作目录」改为「会话项目」语义——默认显示项目名
  而非路径，绝对路径输入与浏览降为高级展开；权限 chip 文案改口语（仅对话 / 可读写
  项目文件 / 完全访问）。
- **安装→对话直通**：安装报告 CTA 带 `?preset=<agentId>` 跳转并自动选中（放宽
  现有 embed 门至普通导航，复用已建成的 configErrorSeq 失败处理）；多角色功能集
  的 CTA 变为「去对话并载入整组」（走既有动态集群 bind 路径）。
- **智能体页收敛为 2 个 tab**：「功能集」（市场 + 我的）与「专家与集群」（集群
  管理区 + 远端专家 + 我的专家）；「应用」tab 从默认布局移除。
- **应用合一**：智能体页「应用」tab 的三类卡（nango 连接 / 外部服务嵌入 / 外链）
  并入应用中心统一网格（数据同源 `/api/catalog`，应用中心已有连接四态徽章）。
- **功能集子 tab 收敛**：市场 | 我的 两 tab；「我的」内部分「已安装」「我的创作」
  两段（原「我的功能集」「我的创作」合并，创作者草稿→发布流程完整保留）。

## Capabilities

### New Capabilities

（无——全部为既有能力的 Requirement 修订）

### Modified Capabilities

- `agent-preset-selection`: 选人器从「preset roster（欢迎态）+ agent roster（⋯ 菜单）」
  双入口合并为单一「与谁对话」选择器（agent roster 为主源、pack 角色去重、集群
  整组条目）；出厂组合模式默认隐去（仅「标准」，layout 谓词可放行）。
- `chat-composer-controls`: ⋯ 溢出菜单收窄（agent 区退役进统一选人器；工作目录区
  改项目语义）；「选人唯一面」条款改指统一选人器。
- `workspace-selection`: 新增「工作目录控件以项目语义呈现」——默认显示项目名、
  路径输入降为高级展开；权限 chip 文案口语化（仅对话/可读写项目文件/完全访问）。
- `agent-catalog`: `/agents` 页三子 tab（专家/行业方案/应用）收敛为二（专家/功能集）；
  apps 深链回落；功能集内 tab 收为 市场|我的（我的=已安装+我的创作）。
- `layout-configuration`: 工厂预设 `standard-snapshot` 的 `agentsTabs` 收为
  agents|market；apps slug 保留注册表兼容、退出全部工厂预设。
- `app-center`: 承接原智能体页「应用」tab 全部条目——网格条目 kind 扩至
  `nango-connect`（连接为主行动），应用中心成为这些条目的唯一页面。
- `pack-marketplace`: 安装报告 next-steps 由「提示用户去对话手动选人」改为带参
  直通（`?preset=` 自动选中；多角色集群包走整组载入引导；纯技能包保持普通导航）。
- `web-chat-ui`: 新增「非 embed 导航的预设深链」——`?preset=` 门从副驾 iframe
  放宽到普通导航，语义与 embed 深链一致（可见、诚实失败、一次消费）。

## Impact

- 前端组件：`AgentPresetPicker.tsx`、`ControlStrip.tsx`、`ChatWelcome.tsx`、
  `ChatPage.tsx`（`?preset` 门）、`ChatHeader.tsx`、`AgentsPage.tsx`、
  `PacksPage.tsx`、`PackMarketView.tsx`、`AppCenterPage.tsx`。
- 注册表与布局：`packages/core` 的 `AGENTS_TAB_SURFACES`、`server/layout.js`
  的 resolvedLayout 默认序列。
- i18n：全部名词统一改动走 locale bundle（zh-CN 先行，其余语种随改）。
- e2e：`agent-preset-picker`、composer strip、agents page、packs 页相关断言更新。
- **排序风险**：在途 change `copilot-dock-focused-preset` 触碰同一 preset 选人面；
  本 change 的 spec delta 与 apply 需在其归档后进行，或 delta 采用错峰 MODIFIED。
- 出片：纯 web 面，走常规 web 镜像出片线（`paas-release`）。
