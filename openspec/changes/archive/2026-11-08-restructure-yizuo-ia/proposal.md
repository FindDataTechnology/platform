## Why

壹座的工作面在 supply-studio-migration（W2）之后没有跟着收口，导航停在"每个历史搬迁各留一个门"的状态：同一件事被切在导航与设置两个容器里，各切 3–5 份，其中还有 3 个面根本没有门。

实测（本次勘察，2026-11-08）：

- 导航平铺 11 项 + 桌面 1 项，其中只有 1 个家族（知识），另 7 项无分组；「智能体团队 / 机器 / 机群」三个近义名实为组织、设备、本机运行时三层。
- **无门面 3 个**：`/tuning`（技能候选审核 + 人格修订，全仓 0 链接）、`/packs`（包市场 + 我的包 + 创作草稿/发布，仅路由）、`/settings/delegation`（在 `sections.ts` 有、在 `surfaces.ts` 注册表没有 → 弹窗只渲染注册表解出的 slug，永久不可达）。
- 装能力 5 个门（`/agents` 我的包 · `/packs` · facet 外站 · 设置/`mcp` · 设置/`plugins`）；接外部账号与设备 5 个门（设置/`connections` · 设置/`devices` · 设置/`wechat-app` · `/machines` · 桌面 `/fleet`）；对外沟通 4 个门；运维读面 4 个门。
- 设置里 15 节只有 7 节是配置，另 8 节是工作面塞进模态；`connections` 一节 = 9 个模块纵向长滚，靠 `?panel=` 锚点定位。
- 死代码：`web/src/pages/AgentsPage.tsx`（669 行四区门面）0 引用；`/tuning` 的注释仍声称"侧边栏入口在 workspace 家族下"，该家族已不存在。

## What Changes

- **导航收口为 6 顶层 + 4 家族**：对话 / 知识〔资料库·成果·记忆〕/ 构建〔智能体市场·调优·能力〕/ 运行〔智能体团队·机器·本机运行时(桌面)〕/ 自动化〔任务〕/ 接入〔应用目录·产品线看板·智语·渠道〕。
- **`/agents` 与 `/packs` 合并为一个「智能体市场」双 tab 面**（市场 · 我的包/草稿/发布），外部 facet 市场保留为明确出口；`/packs` 旧 URL 落到同一面的对应 tab。
- **调优回门口**：`/tuning`（技能候选审核 + 人格修订）挂进构建家族，不再是只能靠 URL 到达。
- **三舰队同族并改名去歧义**：智能体团队（组织）/ 机器（配对设备）/ 本机运行时（桌面运行时，原「机群」）。
- **渠道从设置搬进「接入」家族**（社媒机器人是对外沟通面，不是配置），`/settings/channels` 保留重定向。
- **项目切换器**：项目（project）当前只是侧边栏会话的隐形分组键，升为会话区顶部可见切换器；会话分组语义不变。
- **设置 15 → 12 节**：`devices` + `wechat-app` 合并为「配对与绑定」（新 slug `pairing`，两旧 slug 走 aliases，同一码池三个 tab）；`delegation` 补进注册表并归位到管理组（顺带修掉分组标题的 `i-1.group` 交错渲染）；「状态」与「诊断」合并为一节两 tab。
- **设置内搜索** + `connections` 长滚改**卡片网格**、每卡独立深链（沿用现有 `?panel=` 机制，不新增协议）。
- **导航与设置双向互跳**：构建家族的「能力」跳到设置对应节，设置能力节回跳工作面。
- **清理**：删除 `AgentsPage.tsx` 死代码；`/settings/presets` 重定向归一。
- **不 BREAKING**：所有现有 route slug 与 `/settings/:section` slug 保留解析（新增 slug 走 aliases + 重定向）；`/studio`、`/blueprints` 仍出站 facet；三层布局解析链（factory→部署→角色→用户）语义不变。

## Capabilities

### Modified Capabilities

- `app-navigation`：canonical tab set 由 11 项平铺改为 6 顶层 + 4 家族（`tuning`、`channels` 新增入口），标签改「智能体市场 / 本机运行时」，会话区顶部增项目切换器，`/packs` 收进 `/agents`。
- `sidebar-nav-families`：家族由 2 个（知识、构建）扩为 4 个（知识、构建、运行、接入），并给构建家族加设置快捷行。
- `sidebar-workspaces`：项目从隐式分组键升为显式切换器（会话分组键与排序规则不变）。
- `settings-surface`：分组与成员重排（15→12 节）、`pairing` 合并与 aliases、`delegation` 归位、状态+诊断合并、节内搜索、分组标题按组边界渲染。
- `layout-configuration`：三个容器的注册表成员随搬迁更新（nav +`tuning`/`channels`；settings +`pairing`/`delegation`、−`channels`/`diagnostics`；agentsTabs 变为 `market`/`mine`），两个工厂预设同步；注册表与节定义的双向一致成为显式不变式。
- `connection-center`：`connections` 由单列长滚改为卡片网格 + 状态徽标 + 节内筛选，`?panel=` 深链语义不变。
- `social-bot-channels`：渠道面由「必须是设置节」改为一级导航面 `/channels`（`/settings/channels` 与 `/bots` 重定向过去）；面本身行为零改动。
- `pack-marketplace`：包市场面从 `/packs` 迁到 `/agents` 的市场 tab，`/packs` 深链连同 `deployCastPack=` 参数重定向；无市场部署时只隐藏市场 tab、保留「我的」。
- `agent-catalog`：`/agents` 子 tab 从退役的 Experts/Packs 四区改为 `market`/`mine` 两 tab，旧 slug 走 aliases；`tuning` 不再属于本面。

## Impact

- 注册表与解析：`packages/core/src/lib/surfaces.ts`（NAV_SURFACES / SETTINGS_SURFACES / NAV_FAMILIES / FACTORY_PRESETS）。
- 导航壳：`web/src/components/Sidebar.tsx`、`web/src/App.tsx`（路由与重定向）、`web/src/lib/gNav.ts`（g 前缀快捷键随 slug 集更新）。
- 设置：`web/src/components/settings/sections.ts`、`SettingsDialog.tsx`（分组/搜索）、`ConnectionsSection.tsx`（网格）、`DevicesSection.tsx` + `WeChatAppSection.tsx` → 合并为 `PairingSection.tsx`。
- 工作面：`web/src/pages/AgentMarketPage.tsx` + `PacksPage.tsx` 合并；`TuningPage.tsx` 挂门；删除 `AgentsPage.tsx`。
- i18n：6 语 `common.json`（nav 标签、家族名、设置节名与分组名）。
- 测试：`e2e/layout.spec.js`、`e2e/nav-persistence.spec.js`、`e2e/agents-tabs.spec.js`、`e2e/app.spec.js`、设置相关 spec 的 nav 断言需同步；注册表单测（`packages/core` surfaces 测试）补新成员。
- 不触碰：服务端路由与凭据模块行为、三层布局解析算法、桌面壳自身导航、小程序命令中心、ops-console。
