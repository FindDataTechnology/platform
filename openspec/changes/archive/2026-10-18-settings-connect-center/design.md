# Design — settings-connect-center

## Context

设置弹窗的分节注册在 `web/src/components/settings/sections.ts`（路由化 modal，`/settings/:section`）；「技能与工具」由 `ExtensionsPage` 渲染，三 tab 状态机在 `ExtensionsPage.tsx`，商店 tab 的连接卡与货架混排在 `McpMarketView.tsx`；网络搜索分节是 `WebSearchSection.tsx`（用户 BYOK 区 + admin 共享服务区）。五类凭据各有独立的状态读取面（`registry-credentials.js`、`connector-credentials.js`、`facet-market-credentials.js`、`line-credentials.js`、`paper-trading-credentials.js` + websearch userkey/pool 路由），但彼此形状不一，且没有任何聚合视图。动机见 proposal.md。

## Goals / Non-Goals

**Goals:**

- 连接卡与搜索接线的容器迁移零行为变化（各凭据模块的铸造/存储/注入/401 处理一行不动）
- 全部既有深链（`/settings/websearch`、`?tab=market`、`?tab=external`、`/settings/skills` 别名、legacy 路由表）保持可解析
- `/api/connections` 聚合端点为 L1b（应用中心徽章）与 L3（对话内引导）提供只读地基

**Non-Goals:**

- 不新增/迁移任何凭据存储（词元账号线是 L2a）
- 不动 search-relay 本体与 `retire-search-relay-direct` 在途 change 的边界
- 不动「模型」分节、专家 tab、应用中心（L1b/L2）

## Decisions

**D1 连接卡整体搬组件，不重写。** 新建 `ConnectionsSection`，按「谦面归组卡（薄包装内嵌 RegistryConnectPanel + FacetMarketConnectPanel 两行）/ ConnectorConnectPanel / LineOpsConnectPanel / PaperTradingConnectPanel / 搜索服务卡（UserKeyZone + SharedServiceZone 原样搬）」组装；五张卡与两个 Zone 的内部逻辑、`data-testid`、REST 调用保持不变。备选「重写成统一连接卡框架」被否：会同时回归五条凭据链路的验证面，收益只是审美。

**D2 websearch 退役走「slug 稳定重定向」而非删 slug。** `settings-surface` 规格钉死 slug SHALL NOT change，故 `/settings/websearch` 在路由层 redirect 到 `/settings/connections?panel=search`（与 packs/presets 退役同款手法），slug 保持可寻址。`WebSearchSection` 不再作为分节注册。

**D3 商店 tab 三态减二态，外部源降级为分区。** `ExtensionsPage` 的 tab 状态机从 `installed | market | external` 减为 `installed | market`；`?tab=external` 解析为 market tab + 外部区锚点。`ExternalSourceTab` 从 tab 级组件改为 `McpMarketView`/`SkillsMarketView` 内的分区组件（仅技能子视图挂载，修复 type=mcp 下挂纯技能市场页的错位）；五张连接卡从 `McpMarketView` 顶部移除。

**D4 `/api/connections` 白名单投影，不新建存储。** 后端聚合各凭据模块现有的状态读取函数，输出 `{id, name, state: connected|stale|disconnected|not-configured, reason?}` 数组；search 条目对 admin 附加池健康摘要（复用现有 pool 路由逻辑）。安全实现取**白名单字段投影**（只序列化 id/name/state/reason 四字段）而非黑名单剔除——从形状上杜绝 token 意外入载荷。ownerKey 语义与各凭据模块一致（auth off = machine-owner）。

**D5 铸造回跳与门禁指路同步改址。** `line-credentials.js` 铸造回跳从 `/settings/mcp?tab=market` 改为 `/settings/connections?panel=line-<wire|lex>`；`extensions.js` 的 `credential-required` 409 负载中前端可消费的指引路径字段同步指向连接分节对应 panel。`McpServerForm` 的 `bundledWiringHint` 文案改指「设置 → 连接」。

**D6 i18n 补齐而非新增兜底。** LineOps/FacetMarket 面板现存 `t(key, 硬编码中文默认值)` 的键全部补进 zh-CN/en/ja 三份 bundle（含新增 connections 分节、两区制商店、品牌速查文案），消灭英日文面下的裸中文。

**D7 死代码随刀清理。** 删除无引用的 `MarketTab.tsx`/`InstalledTab.tsx`；更正 `ExtensionsPage.tsx` 头注释（外部源已具安装路径）。

## Risks / Trade-offs

- [老用户肌肉记忆：商店 tab 顶部连接卡消失] → 门禁与回跳改址后，`credential-required` 直接引到连接分节对应卡，动线反而更短；发布说明提示新位置。
- [布局预设藏了 `websearch` 或 `connections` 的部署] → 重定向目标被 deployment-hiding 时按既有深链回落规则处理（回落 General），无 404；`connections` 与其它分节同规则接受布局收窄。
- [五卡搬迁的回归面广] → 卡组件零改动 + 只搬挂载点；验收按「五条连接流各走一遍 + 深链矩阵」清单执行（见 tasks）。
- [与 `retire-search-relay-direct` 在途 change 平行] → 本 change 只搬 WebSearchSection 的 UI 容器、不触碰 relay 配置读写与端点；两 change 无文件级交叠（misc.js 仅新增聚合路由，不改既有 websearch 路由）。

## Migration Plan

单镜像发布，无数据迁移。回滚 = 回退镜像版本：路由 redirect 与 UI 挂载点随镜像回退，凭据数据与 API 均未变形，回滚零善后。

## Open Questions

无——面板视觉规格（分区标题样式、速查条折叠形态）属实现细节，按现有 Settings 设计语言取齐即可。
