## Why

团队（fleet）装了包之后，只有一份**主人视角、固定布局**的驾驶舱（`agent-fleet-cockpit`：组织画布为主位、KPI 卡墙、拍板横幅、日报流）。团队自己没有"我这张脸"：一个 ERP 团队该先看账本与履约，一个供应链团队该先看采购与仓储，一个法务团队该先看提案与复核——今天这些都得靠主人在通用画布里自己找。包被分享给客户、或团队被装到别人家的运行时时，更是完全没有门面。

同时，谦面（facet）作为分享面只卖包、不呈现团队，团队制品一旦离开主人账号就没有可看的界面。缺的不是数据（`/:id/cockpit`、`/:id/spend`、`/:id/runs` 都在），缺的是**"这个团队要看哪几块"这份声明**。

## What Changes

- pack manifest 新增可选 `console` 段：`headline` + `blocks[]`（`block` 引用闭集注册表、`params`、`surfaces`）。刷新规则与 `serving` / `rhythm` / `guide` / `facade` 同级——**声明"看什么"，不提供"怎么取"**：不带 URL、不带查询语言、不带凭据。不声明则逐字节不变。
- 服务端新增块注册表 `server/console-blocks/`（`id → builder(ctx)`）与单一读数端点 `GET /api/fleets/:id/console?surface=platform|share`。块数据一律复用既有派生（`memberView` / `deriveMemberStatus` / 拍板排序 / `/:id/spend`），**不新造排序或健康语义**。
- `surface=share` 在**服务端**裁块：分享面拿不到 `platform` 独有块（spend、decisions），不是前端隐藏。
- 缺数据一律 `state: "absent"` + 原因，渲染空态，**不编造行**（沿用 `supply-catalog` 的 `source_absent` 姿态）。
- 两个宿主共用一个渲染实现：新增 `packages/console-blocks`（React，照 `packages/core` 的 workspace 解析先例），`web/` 与 `facet/web/` 各引一次。Platform 新增 `/fleets/:id/console` 团队控制台页（从驾驶舱进入，**不改驾驶舱既有布局**）；谦面新增 `/t/:slug` 分享页。
- 五语标注沿用 pack locale 轨道（zh / en / ja / es / fr，缺语回落 en），复用 `lib/pack-locale.js` 的解析，不另造第二套。
- **不改**：驾驶舱既有组织画布/卡墙/拍板横幅/结构视图；`GET /api/fleets/overview` 的有界投影契约；包安装、计费、工具面、组闸；pack 的 `skills` / `mcpServers` 引用语义。

## Capabilities

### New Capabilities

- `pack-console`: 团队控制台的声明与渲染契约——manifest `console` 段形状与校验、块注册表与 `params` 白名单、`surface` 服务端裁剪、诚实空态、单一 view model、两宿主共用渲染、五语标注与缺省降级。

### Modified Capabilities

- `facet-platform`: 谦面新增团队分享页 `/t/:slug`，经平台单一公开读数端点取数（只读代理，不复制数据）；千座不可用时该页诚实降级为"控制台暂不可用"，**市场面与包浏览不受影响**（不破坏现有"千座全停仍可浏览"的独立性要求）。

## Impact

- **server**：新增 `server/console-blocks/index.js`（六个首批块的 builder：`team` / `stream` / `kpi` / `decisions` / `spend` / `orchestration`，只调既有派生）、`server/routes/fleets-console.js`（`GET /:id/console`，含 surface 裁剪与 `absent` 空态）；`server/routes/fleets.js` 不改既有端点，只共用派生函数。
- **lib**：新增 `lib/console-blocks-spec.js`（零依赖的块 id / 参数白名单 / surfaces 取值——校验器被网关进程 import，规格不能依赖 server 代码，同 `lib/generic-bot-types.js` 的做法）；`lib/pack-manifest.js` 增 `console` 段校验（发布面与安装面共用同一校验器，指名字段路径报错）；`lib/pack-locale.js` 的块标注解析复用。
- **web**：新增 `web/src/pages/FleetConsolePage.tsx`（渲染来自 `@platform/console-blocks`）；`web/src/pages/FleetsPage.tsx` 与 `FleetPage.tsx` 增控制台入口；既有驾驶舱布局零改动。
- **facet**：`facet/index.js` 增 `/t/:slug` 路由与 `t/:slug` 的 SPA 入口；`facet/web/src/` 新增 `ConsoleView.tsx`（同一渲染包）；`facet/platform-console-client.js` 负责只读代理与超时/降级。
- **packages**：新增 `packages/console-blocks`（`manifest.ts`：块 id 与 params 类型；`render.tsx`：块渲染器；无 DOM 依赖的纯数据层留在 `core`）。
- **i18n**：块名/摘要五语键进既有 locale 轨道；`npm run check:locales` 必须绿。
- **测试**：新增 `scripts/test-pack-console-manifest.mjs`（形状/上限/未知块/未知 params 拒绝）、`scripts/test-pack-console-surface.mjs`（share 面裁块、服务端断言）、`scripts/test-pack-console-absent.mjs`（缺数据空态不编造）；facet 侧 `scripts/test-facet-console-proxy.mjs`（只读 + 千座停机降级）。既有 fleet 套件零扰动。
- **兼容性**：`console` 缺省 = 无控制台入口，包行为字节一致；不新增必须每机配置的开关；不引入跨进程状态（view model 每次实时派生）。
