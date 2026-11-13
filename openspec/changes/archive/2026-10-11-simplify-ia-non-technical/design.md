# Design: simplify-ia-non-technical

## Context

壹座 web 端（浏览器与桌面同 UI）现状：`Sidebar.tsx` 的 `NAV_BASE` 钉死 7 个一级 tab；`settings/sections.ts` 是设置分节注册表（slug 即公开 API，注释明令不改名）；`/agents` 页两 tab（Agents/Apps，`?tab=` 深链）；自建预设与功能集市场两块管理面住在设置弹窗；`/bots`、`/trace` 是一级路由整页。动机见 proposal.md —— 本设计只管怎么搬。

全部改动收敛在 `web/` 展示层：**零 server.js 契约改动、零数据迁移**。唯一例外是模型只读视图需要客户端已有的 admin 判定（下述 D5）。

## Goals / Non-Goals

**Goals:**

- 五 tab 导航 + 三组设置 + 三 tab 智能体页，纯 locale/组件重排落地
- 每一条旧深链（`/bots`、`/trace`、`/trace/:id`、`/settings/presets`、`/settings/packs`、`/agents?tab=*`、`/settings/mcp|skills`）继续解析到正确面
- e2e 迁移有明确的 grep 清单可执行

**Non-Goals:**

- 不动任何 WS/REST 契约、SQLite 存储、catalog 合并逻辑（specs 已声明 schema 不变）
- 不改 locale 键名（只改五语言值 + 新增键），`check:locales` 门照常
- 工作区去路径化、自动化模板、教程内容（R2/R3，proposal 展望节）
- 小程序与桌面专属适配（桌面=web 自动继承；MP 无此导航，命名同步留 R4）

## Decisions

### D1 slug 全保留 + 别名，不做物理改名
路由与 slug 是公开 API（书签、旧重定向、e2e 全依赖）。方案：新分节用新 slug（`channels`、`diagnostics`）；合并后的「技能与工具」**双 slug 别名**——`mcp` 与 `skills` 都路由到同一分节，各自预选子视图，注册表一条目、两地址；退役的 `presets`/`packs` 分节 slug 由 `/settings/presets → /agents?tab=agents`、`/settings/packs → /agents?tab=market` 重定向接走；`/agents?tab=` 的 `agents`（=专家）与 `apps` 值保持解析。备选「全部换新 slug + 重定向表」被否：改动面大三倍，收益为零。

### D2 智能体页三 tab = 三个既有组件原地复用
- **专家 tab**：现有 catalog 列表**天然已含**自建预设条目（catalog 五源合并早把 custom presets 编进 `GET /api/catalog`，带 `customPreset` 标记）——列表本身零改动即得统一名册。管理面：`customPreset` 标记行加 编辑/删除/转草稿 行内按钮，页头加「新建专家」入口，编辑器直接复用 `CustomPresetsPage.tsx` 现成表单组件（含 streamBusy 保护），不重写。
- **行业方案 tab**：`PacksPage.tsx`（63 行薄壳，自带 market/mine/drafts 内部 tab）整体作为 tab 内容挂入；`requiresPackMarketplace` 门从设置注册表**随迁**到 tab 级——无市场部署不渲染该 tab，`?tab=market` 回落专家 tab。
- **应用 tab**：原 Apps 列表不动，slug `apps` 不变。

### D3 bots/trace 降级沿用「整页组件进设置分节」的既有模式
Models/MCP/Skills/Status 走过的路：`BotsPage`、`TracePage`（列表）组件不改内部（testid、REST、QR 面全保），在 `sections.ts` 注册为分节即可。`/trace/:turnId` 详情保持顶级路由（时间线在弹窗里会挤死，且聊天内逐轮深链要求直达全页）。

### D4 设置三组是注册表的新元数据，不是新容器
`SettingsSection` 增加 `group: "basics" | "capabilities" | "management"` 字段；`SettingsDialog` 按 group 分节渲染分组标题。分节组件、懒加载、路由行为全部不变。

### D5 模型只读视图复用 branding 的 adminOnly 机制
客户端已有 admin 判定（`adminOnly: true` 的 branding 分节靠它显隐）。Models 分节不隐藏而是分叉渲染：admin/开放部署 → 现有管理面原样；非 admin → 只读名册视图（provider 列表 + 各自 roster + 已知 serving 状态），无任何增删改/测试/sync 控件。数据来自现有 `GET /api/llm/providers`（本就不回密钥）。

### D6 文案五语言一次走齐，zh-CN 主导定稿
新 zh 值先定（对话/资料库/成果/智能体/自动化/技能与工具/渠道接入/诊断/行业方案/我的专家），en 定 对话→Chat 已有、资料库→Materials、成果→Outputs、自动化→Automation、行业方案→Industry Packs、渠道接入→Channels、诊断→Diagnostics；es/fr/ja 按既有风格同步。用户可见文案不出 MCP/cron/Base URL 词汇；分节内高级说明允许出现一次术语解释（"外部工具（MCP）"式括注）。

## Risks / Trade-offs

- [双 slug 别名让注册表与路由各多一条映射] → 实现收敛在 `sections.ts` 单处（slug→section 解析函数），App.tsx 重定向表加两行；e2e 补 `/settings/skills` 命中技能子视图断言。
- [e2e 大面积引用 nav-bots/nav-trace、settings-section-presets/packs、两 tab 结构] → 实施首步先 grep 全清单（预计集中在 nav.spec、settings、agents、bots、trace 各 spec），迁移作为独立任务核销，不与实现混提交。
- [非 admin 只读视图在无 sync 数据的部署上状态列全空] → 视图对未知状态显示中性占位（不显示"不可用"），spec 措辞已是 "where known"。
- [CustomPresetsPage 编辑器内嵌后与 catalog 列表的状态互扰] → 编辑器作为受控弹层挂载、保存后走既有 `catalog_changed` 刷新链（侧栏已订阅），不引入第二数据通路。
- [旧 `/bots` 整页书签用户发现入口变了] → 重定向 + Management 组图标（Bot 图标沿用）保证可发现性；发布说明一句话。

## Migration Plan

单镜像滚动（标准 paas-release 线：源码 push → CI 绿 → 镜像 → GitOps tag → ArgoCD）。无数据迁移、无 env 变更。回滚 = revert 镜像 tag；因零后端改动，回滚无数据面风险。

## Open Questions

- ~~专家 tab 内自建预设管理面的具体布局~~ **已定案（实施期）**：不走向 catalog 行内按钮，而是把 `CustomPresetsPage` 管理面（含其自有标题/新建按钮/完整行操作）整体嵌入专家 tab 名册下方——零新增管理代码，全部既有 testid 保留；catalog 网格过滤掉 `customPreset` 条目避免双行显示。
- ~~channels 分节是否加 adminOnly~~ **已定案（实施期）**：不加。`/api/bots` REST 既有路由本就无 admin 门，UI 门与 server 门保持一致（诊断同理）。
