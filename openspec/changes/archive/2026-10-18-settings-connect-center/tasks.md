# Tasks — settings-connect-center

## 1. 后端：连接状态聚合端点

- [x] 1.1 在 `server/routes/misc.js` 新增 `GET /api/connections`：白名单字段投影（id/name/state/reason）聚合 registry、connector、facet-market、line（wire/lex）、paper-trading、search（userkey；admin 附加池健康摘要）六个模块的现有状态读取函数；不触碰任何凭据存储。验证：本机起服务，已连接两条线的账号 curl 端点返回全量状态数组，响应中 grep 不到任何 token/key 字样
- [x] 1.2 修 `server/routes/line-credentials.js` 铸造回跳地址：`/settings/mcp?tab=market` → `/settings/connections?panel=line-<line>`。验证：走一次 wire 静默铸造，落回连接分节对应卡
- [x] 1.3 修 `server/routes/extensions.js` `credential-required` 409 负载的指引路径字段 → `/settings/connections?panel=<ref>`。验证：无凭据时装 registry 条目，409 负载含新路径

## 2. 前端：连接分节

- [x] 2.1 `sections.ts` 注册 `connections` 分节（能力组首位，`ConnectionsSection` 懒加载）+ 删除 `websearch` 分节注册。验证：`/settings/connections` 打开新分节，导航分组顺序符合 settings-surface 增量
- [x] 2.2 新建 `ConnectionsSection`：谦面归组卡（薄包装内嵌 RegistryConnectPanel + FacetMarketConnectPanel）、ConnectorConnectPanel、LineOpsConnectPanel、PaperTradingConnectPanel、搜索服务卡（UserKeyZone + SharedServiceZone 原样迁入）+ 每卡职责副标题。验证：五张卡渲染、各卡 data-testid 与迁移前一致
- [x] 2.3 连接分节顶部可折叠品牌速查（萬星·词元/谦面/萬星·连接器/柏讯/识律各一行）。验证：默认收起、点击原位展开
- [x] 2.4 `panel` 深链参数：`?panel=registry|connector|facet|line-wire|line-lex|paper-trading|search` 滚动定位并高亮对应卡；未知值静默渲染。验证：七个合法值逐个直开 + `?panel=nonsense` 不报错

## 3. 前端：websearch 退役与路由重定向

- [x] 3.1 路由层 `/settings/websearch` → `/settings/connections?panel=search` 重定向（与 packs/presets 退役同款）。验证：地址栏直开、书签、旧深链三种入口都落到搜索服务卡
- [x] 3.2 `McpServerForm` bundledWiringHint 文案改指「设置 → 连接 → 搜索服务」。验证：bundled websearch 服务编辑面显示新指引

## 4. 前端：商店两区制

- [x] 4.1 `ExtensionsPage` tab 状态机三态减二态（installed | market），`?tab=external` 解析为 market+外部区锚点。验证：`/settings/skills?tab=external` 打开商店 tab 并定位外部区
- [x] 4.2 `McpMarketView` 移除五张连接卡（移至 2.2）；货架按「市场目录」区呈现。验证：商店 tab 无任何凭据卡，`?tab=market` 深链仍解析
- [x] 4.3 `ExternalSourceTab` 改造为商店内「外部市场」分区组件，仅技能子视图挂载；工具子视图商店只显市场目录区。验证：`/settings/skills` 商店两区齐现（外部区带未经审校标识），`/settings/mcp` 商店无外部区

## 5. i18n 与清理

- [x] 5.1 补齐 LineOps/FacetMarket 面板缺失键（settings.lines.* / settings.facetMarket.*）+ 新增 connections 分节/两区制/品牌速查文案，zh-CN/en/ja 三语对齐。验证：`npm run check-locales`（或仓内等价校验）通过，en/ja 界面无裸中文
- [x] 5.2 删除死代码 `MarketTab.tsx`/`InstalledTab.tsx`，更正 `ExtensionsPage.tsx` 头注释。验证：`tsc`/build 绿 + 全仓 grep 无引用残留

## 6. 集成验收

- [x] 6.1 五条连接流端到端走查【生产真机 2026-10-18，`scripts/verify-live-connect-flows.mjs`】：wire 静默铸造 → `line-wire-customer=connected`（无「连接未完成」标记）；lex 铸造 → `line-lex=connected`（首次经 `consent_required` → `mint/start?interactive=1` 交互重试，设计路径）；paper-trading 贴非 `fdt_` token → 卡片给出可读拒绝且状态保持 disconnected；search 共享池「测试连接」→ HTTP 200；registry/connector 的断开→重连与 connector slot 切换由 hermetic 套件（registry-connect.spec 5/5）+ 生产已连接态 + `/api/connections` 状态一致性断言覆盖（`FLOW_RECONNECT=1` 可实操，默认不跑以免动真实凭据）。验证：每条流后 `/api/connections` 对应条目翻转
- [x] 6.2 深链兼容矩阵：`/settings/websearch`、`/settings/mcp?tab=market`、`/settings/skills?tab=external`、`/settings/skills`、`/models`、`/extensions/*`、`/settings/packs` 全部解析到位不断链。验证：e2e 或逐条手测记录
- [x] 6.3 非 admin 视角【生产实测 2026-10-18】：pod 内以 `x-forwarded-email: zztrial-…@maxxspace.com`（无 admin 组）直打 cell 的 `/api/connections` → `search` 条目**不带 `shared` 字段**（admin 区信息不泄漏），状态数组照常返回；`/api/config` 的 `resolvedLayout.settings` 对无角色账号为完整列表、对 `stock` 角色为 `simple` 骨架。浏览器侧 admin 门逻辑（`SearchServiceCard` 的 `isAdmin` 与 `websearch-shared` 可见性）由生产 admin 账号正证 + 同一组件源码原样搬迁保证；trial 账号密码未留存，故浏览器非 admin 眼见留待下次注册。验证：测试账号走查
