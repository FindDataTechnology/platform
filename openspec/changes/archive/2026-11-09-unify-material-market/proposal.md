## Why

用户实测后的判断（2026-11-09）：智能体、MCP、技能、插件的**市场是日常要用的能力**，现在却分三个门、两个藏在设置齿轮后——`/agents` 只卖 pack，MCP+技能在「设置 → 技能与工具」，dsh 插件在「设置 → 插件」且只读。主流的 agent 产品把这类市场放在前场，把**模型**放设置。这与用户的心智一致，与现状不一致。

而系统其实已经为"一个市场"准备好了地基，只是没接上前场：

- `supply-catalog`：**统一素材目录**，五物种 `pack / skill / mcp / facade / data-anchor`，枚举带版本号，「新增物种必须升版本」是明文约定；
- `agent-materials-plaza`：素材广场的公开面（五语静态站 + 机器面）；
- `docs/ecosystem-curation.md` + `ecosystem-curation-ledger.md`：**审校 runbook 与台账已存在**（S1–S7 入库轴、Q1–Q5 决议、首批 12 个 MCP server + ~40 技能白名单），连"anthropics 文档技能族 source-available 不收""firecrawl AGPL 不收"这类硬结论都已落纸。

插件这一支缺的是同一条流水：**官方 harness 市场的好插件 → 审核 + 多语言 → 进我们的可用插件清单 → 用户自己看见并启用**。

## What Changes

- **一个素材市场，五个页签**：`/agents` 这个 slug 不动（公开契约），标签改为**素材市场**，页签为 智能体 · 工具 · 技能 · 插件 · 我的。旧 `?tab=market` 归一为 `agents`，`?tab=mine` 不变。
- **设置退场两节**：`mcp`（技能与工具）与 `plugins` 从设置成员中移除，旧地址重定向到素材市场对应页签；**模型留在设置**（配置而非市场）。
- **构建家族的设置快捷行退役**：那三条"看起来像导航、点了跳弹窗"的行正是这次的错位来源，页签化之后没有存在必要。
- **插件成为第六个素材物种**：`SUPPLY_SPECIES` 追加 `plugin` 并升版本（v1 → v2），条目沿用既有注解形状（`canonical.brief`、五语 `human`、`whenToUse`、`provenance`）。
- **插件页签的三种状态**：`可启用`（随镜像/桌面预置，一个开关，沿用现有 plugin-supply 桥）/ `未供应`（在目录里看得见，标"申请供应"）/ `已启用`。
- **申请供应流水（A+B 方案）**：用户在目录里对未供应项点「申请供应」→ 落一行申请记录 → 运维/CI 把它烤进下一次出片 → 回来后该项自动变"可启用"。**运行时不下载、不安装、不执行第三方代码**这条不破。

## Capabilities

### Modified Capabilities

- `app-navigation`：「智能体市场」改为「素材市场」并承载四物种页签；构建家族不再有设置快捷行。
- `settings-surface`：`mcp` 与 `plugins` 两节退场（slug 走重定向到市场页签）；模型保留。
- `extension-management-ui`：MCP / 技能的**市场半场**迁到素材市场页签，已启用管理仍由市场页签内的"已装"子区承担；深链契约不变。
- `layout-configuration`：`agentsTabs` 容器改为 `agents / tools / skills / plugins / mine` 五项；`agents` slug 标签与页签集合随之更新，旧 tab 值走 aliases。
- `agent-catalog`：页面子页签由两项扩为五项，`?tab=` 契约与旧值归一规则更新。
- `dsh-plugin-supply`：插件从"设置里的只读白名单"变为"素材市场页签里的目录 + 启用开关 + 申请供应"；构建期供应与"运行时不装代码"的硬约束不变。
- `supply-catalog`：物种枚举 `plugin` 加入，`SUPPLY_SPECIES_VERSION` 升到 2。

### New Capabilities

- `plugin-supply-request`：申请供应流水（申请 → 排队 → 出片带入 → 状态回流），含幂等、去重、与目录条目的状态映射。

## Impact

- `packages/core/src/lib/surfaces.ts`（`agentsTabs` 五项、aliases、预设置）
- `web/src/pages/AgentMarketPage.tsx`（四物种 + 我的 五页签壳）
- `web/src/components/extensions/*`（MCP/技能市场视图以页签形态复用）
- `web/src/components/settings/sections.ts`、`SettingsDialog.tsx`（两节退场与重定向）
- `web/src/components/Sidebar.tsx`（快捷行退役、家族成员变化）
- `server/` 与 `facet/supply-catalog.js`（物种 v2；插件目录读面）
- `docs/ecosystem-curation.md`（插件审校轴与条目模板）
- e2e：`agents-tabs`、`connections`（panel 深链）、`settings-modal`（重定向）、新增市场五页签与申请流水

不触碰：模型设置、凭据/连接行为、插件运行时的加载方式。
