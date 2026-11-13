# Tasks — unify-material-market

> 执行约定：1 是 2/3 的前置；4 与 1–3 可并行（服务端与前端各自独立）；5 依赖 4 的读面；6 收口归主代理。

## 1. 注册表与路由

- [x] 1.1 `packages/core/src/lib/surfaces.ts`：`AGENTS_TAB_SURFACES` 改为 `agents / tools / skills / plugins / mine`（`agents` 保留 pack-marketplace 谓词）；验证：`registryFor("agentsTabs").map(s=>s.slug)` 五项有序
- [x] 1.2 同文件：`SURFACE_SLUG_ALIASES.agentsTabs` 加 `market→agents`、`supply→agents`、`apps→agents`、`build→agents`（`agents`/`creations→mine` 保留）；验证：`validatePreset({agentsTabs:["market"]})` ok 且归一为 `["agents"]`
- [x] 1.3 `FACTORY_PRESETS` 两个预设的 `agentsTabs` 改为五项；`simple` 同；验证：单测断言完整数组
- [x] 1.4 `app-navigation` 的导航标签 `nav.agents` 改「素材市场 / Materials」（slug/icon/testid 不变）；5 语同步；验证：`check:locales` 绿 + 截图
- [x] 1.5 退役构建家族的设置快捷行（`nav-family-build-shortcuts` 与其行）与对应词条；验证：DOM 中该 testid 不存在，`e2e/ia-doorways` 对应用例改为断言"不存在"
- [x] 1.6 路由：`/settings/mcp`、`/settings/skills`、`/settings/plugins` 重定向到 `/agents?tab=tools|skills|plugins`；验证：三条地址均落到市场页且不开弹窗

## 2. 市场页五页签

- [x] 2.1 `AgentMarketPage` 改为页签壳，按 `resolvedLayout.agentsTabs` 渲染；`?tab=` 深链与旧值归一；验证：五页签可达，`?tab=market` 落 `agents`
- [x] 2.2 `agents` 页签保留现有 pack 市场（浏览/订阅/详情 + `deployCastPack` handoff）；验证：`e2e/packs` 相关用例仍绿
- [x] 2.3 `tools` 页签挂 MCP 市场货架 + 已装管理（复用 `ExtensionsPage` 的视图，拆为可直接挂载的子组件）；验证：安装/卸载/凭据深链行为不变
- [x] 2.4 `skills` 页签挂技能市场（含外部源区）+ 已装 + 候选审核；验证：同上
- [x] 2.5 `mine` 页签保持已装 pack + 创作草稿/发布；验证：`e2e/packs` 我的分支绿
- [x] 2.6 窄视口页签可横向滚动，不换行不截断；验证：1024 宽截图

## 3. 设置退场

- [x] 3.1 `sections.ts` 删 `mcp`、`plugins` 两节定义；`SETTINGS_SURFACES` 同步删（12→10）；验证：`scripts/test-layout-registry-agreement.mjs` 绿
- [x] 3.2 设置弹窗不再渲染这两节；`/settings/mcp|skills|plugins` 由路由层重定向（不经过 modal）；验证：三地址 URL 变为 `/agents?tab=…` 且无 `settings-panel`
- [x] 3.3 `模型` 仍在设置，位置与行为不变；验证：`/settings/models` 直达

## 4. 插件目录与申请流水（服务端）

- [x] 4.1 `facet/supply-catalog.js`：`SUPPLY_SPECIES` 追加 `plugin`，`SUPPLY_SPECIES_VERSION = 2`；`/api/supply-catalog/species` 返回六物种 + v2；验证：curl 断言
- [x] 4.2 插件目录读面：返回每个插件条目的注解（五语 name/description、`whenToUse`、`provenance`）+ 供应态 + 审核信息；验证：单元测试覆盖"目录有/供应无"
- [x] 4.3 供应态派生：由部署的实际烘入清单（image/desktop predist 声明）计算 `可启用/已启用/未供应`，客户端不维护第二份；验证：反证用例（清单里没有 → 未供应）
- [x] 4.4 申请流水：`POST /api/plugin-supply-requests`（幂等、按插件按部署去重、已供应拒绝且不建行）；验证：重复请求只一行、已供应请求 4xx 且无行
- [x] 4.5 状态派生读取：申请行状态 = `supplied` 当且仅当该插件当前已供应；拒绝须带理由；验证：模拟供应后读面变 `supplied`
- [x] 4.6 安全断言：申请路径不触发任何下载/安装/执行；验证：路由代码无拉取调用 + e2e 断言"申请后插件仍为未供应"

## 5. 插件页签

- [x] 5.1 目录全量渲染三态行（可启用/已启用/未供应），未供应行渲染「申请供应」而非禁用开关；验证：三态截图 + e2e
- [x] 5.2 启用/停用沿用 plugin-supply 桥（pending → `plugins_changed` 回流）；验证：开关后状态回流
- [x] 5.3 空目录解释态；验证：无供应时渲染说明而非空白
- [x] 5.4 申请交互：点击后行内显示"已申请"，重复点击不再发请求；验证：e2e

## 6. 文档与收口

- [x] 6.1 `docs/ecosystem-curation.md` 增插件审校轴（许可证/维护活性/运行方式/供应链）与条目模板；`docs/ecosystem-curation-ledger.md` 增插件节（首批候选待填）
- [x] 6.2 e2e：更新 `agents-tabs`、`settings-modal`、`connections`；新增 `material-market` spec（五页签、三态、申请、重定向、旧值归一）；验证：全绿
- [x] 6.3 `typecheck` + `biome` + `check:locales` + `openspec validate unify-material-market --strict`；验证：全绿
- [x] 6.4 走查：1440/1024 × zh/en 五页签与三态截图留档
- [ ] 6.5 归档前 `openspec archive unify-material-market --yes` 预演；验证：`openspec validate --specs --strict` 无新增红（既有 9 条 RFC2119 警告不计）
