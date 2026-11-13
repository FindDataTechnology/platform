# Tasks — app-center-unified-grid

## 1. 数据层：统一条目单源（`web/src/lib/appCatalog.ts`）

- [x] 1.1 新增 `AppGridEntry` 类型与 `APP_CONNECTIONS` 映射表（`yizuo-packs→[registry]`、`facet→[facet-market]`、`wanxing-token→[line-wanxing-caller]`、`wanxing-connector→[connector]`、`lex→[line-lex]`、`wire→[line-wire-customer, paper-trading]`），`APP_LINES` 原样保留。验证：`npm run typecheck` 绿；`node scripts/test-app-center.mjs` 既有 5 条仍绿
- [x] 1.2 实现 `brandOf(app)`（显式 `line` 字段优先，否则 `<brand>-` 前缀推断，未命中返回 `null`）与 `buildAppGrid(lines, catalogApps)`（品牌卡 + 归属产品卡，品牌序主序、产品紧随品牌、未归属排末尾；产品卡继承品牌图标或按产品 id 取专属图标）。验证：单测 2.1 绿
- [x] 1.3 实现 `aggregateConnectionState(ids, statesById)`（四态：全 connected→`connected`；任一 stale→`stale`；部分 connected 且无 stale→`partial`；其余→`disconnected`；空 ids→`null`）与 `connectTargetFor(ids, statesById)`（首个非 connected 的 id，全 connected 返回 `null`）。验证：单测 2.2 绿

## 2. 单测（`scripts/test-app-center.mjs` 扩展，`node --test`）

- [x] 2.1 归属与排序：三条打包产品归属正确（`yizuo-packs→yizuo`、`wanxing-*→wanxing`），显式 `line` 字段覆盖前缀，未知前缀排末尾；`buildAppGrid` 对打包三产品输出顺序恰为 `yizuo, yizuo-packs, facet, wanxing, wanxing-token, wanxing-connector, lex, wire`；空目录只出五张品牌卡。验证：`node scripts/test-app-center.mjs` 绿
- [x] 2.2 四态聚合与去连接目标：柏讯双连接的 `connected/partial/stale/disconnected` 四组输入各断言一次，`stale` 优先于 `partial`，`not-configured` 视为非 connected；`connectTargetFor` 在 partial 时返回缺的那条（`paper-trading`）、全连返回 `null`。验证：同上
- [x] 2.3 映射守门：`APP_CONNECTIONS` 的每个值都 ∈ 已知 id 集 `{registry, facet-market, connector, line-wire-customer, line-lex, line-wanxing-caller, paper-trading, search}`（与 `e2e/connections.spec.js` 列表同源），且 `search` 不被任何卡引用，`yizuo`/`wanxing` 不在表中。验证：同上
- [x] 2.4 五语键：既有 i18n 断言扩展到 `appCenter.connection.{connected,partial,stale,disconnected,connect}`，并断言 `appCenter.linesHeading`/`appsHeading` 在五语中都已不存在。验证：同上

## 3. 页面：单网格 + 统一卡（`web/src/pages/AppCenterPage.tsx`）

- [x] 3.1 重写为单一网格容器 `data-testid="app-center-grid"`，删除两个分区 `<section>` 与标题；并行发起 `/api/catalog` 与 `/api/connections` 两次 fetch，各自 `catch→null`，品牌卡不等待任何网络。验证：本地起服务打开 `/apps`，断网 devtools 下品牌五卡仍渲染
- [x] 3.2 统一 `AppCard`：图标、名称、一句职责、「建设早期」徽章（`app-card-{id}-early-badge`）、连接徽章（`app-card-{id}-connection-badge` + `data-state`）、动作区「打开」（三分支原样：self 无 / `external-service && embedded!==false`→`/external/:id` / 其余 `window.open`，testid `app-card-{id}-open`；self 渲染 `app-card-{id}-self`）与「去连接」（`app-card-{id}-connect`，仅非 connected 时渲染，`navigate('/settings/connections?panel=<target>')`）。验证：e2e 5.x 绿
- [x] 3.3 `states===null` 时整页无徽章无去连接；`apps===null` 时无产品卡。验证：e2e 5.4 绿

## 4. i18n 五语（`web/src/locales/{en,es,fr,ja,zh-CN}/common.json`）

- [x] 4.1 新增 `appCenter.connection.{connected,partial,stale,disconnected,connect}`（zh-CN：已连接/部分连接/需重连/未连接/去连接；其余四语沿用连接分节同义词条译法），改写 `appCenter.subtitle` 为生态产品口径，删除 `appCenter.linesHeading`/`appCenter.appsHeading`。验证：`npm run check:locales` 绿；单测 2.4 绿

## 5. e2e（`e2e/app-center.spec.js` 改写）

- [x] 5.1 统一网格：`app-center-grid` 可见，`app-center-lines`/`app-center-platform-apps` count 0，8 张 `app-card-*` 可见且 DOM 顺序为品牌序；`app-card-yizuo-self` 可见、`app-card-yizuo-open` count 0；lex/wire 早期徽章可见、facet 无。验证：`npx playwright test e2e/app-center.spec.js --project=fast` 绿
- [x] 5.2 直达：facet/wanxing/lex/wire 的 `-open` href 为自有域名；`wanxing-token` 的「打开」路由到 `/external/wanxing-token`（断言 URL）。验证：同上
- [x] 5.3 全新环境徽章：六卡 `connection-badge[data-state="disconnected"]` + `-connect` 可见；`yizuo`/`wanxing` 两卡两者 count 0；点 `wanxing-token` 的「去连接」→ URL `/settings/connections?panel=line-wanxing-caller` 且 `[data-panel-active='true']` count 1。验证：同上
- [x] 5.4 `page.route("**/api/connections")` 注入四种响应：`partial`（wire connected + paper disconnected → `wire` 为 partial，`-connect` 点击落 `panel=paper-trading`）、`stale`（connector stale → `wanxing-connector` 为 stale）、`connected`（facet-market connected → `facet` 为 connected 且无 `-connect`）、`500`（无任何 `connection-badge`/`-connect`，8 卡与「打开」照常）。验证：同上

## 6. 本地验证门

- [x] 6.1 `npm run test:unit`、`npm run typecheck`、`npm run lint`、`npm run check:locales` 全绿。验证：四命令退出码 0
- [x] 6.2 `npm run web:build:e2e` 后跑 `npx playwright test e2e/app-center.spec.js e2e/connections.spec.js --project=fast` 全绿（连接分节不受影响）。验证：两 spec 全绿；全量 fast 若有红，stash 本改动复跑确认为既有 flaky 再放行

## 7. 发布与真机验收

- [x] 7.1 提交只 `git add` 本变更文件（`web/src/pages/AppCenterPage.tsx`、`web/src/lib/appCatalog.ts`、五语 locale、`scripts/test-app-center.mjs`、`e2e/app-center.spec.js`、`openspec/changes/app-center-unified-grid/**`、`openspec/specs/app-center/spec.md` Purpose），勿 `-A`。验证：`git show --stat HEAD` 只含上述文件
- [x] 7.2 `fd-build-channel` 判路 → 公开快照线出片（出片前 `gh api` 核 image.yml 在位）→ relay `OK yizuo/platform:sha-<snap>` 日志行 → ccr skopeo digest → `fd-infra-deploy` 双清单滚 tag → ArgoCD refresh → platform + platform-demo 双 rollout 绿 → pod imageID 与 digest 全等。验证：台账证据链逐项有值
- [x] 7.3 生产真机走查脚本 `scripts/verify-live-app-center.mjs`（仿 `verify-live-connections.mjs`，真实 Logto 账号）：`/apps` 8 卡与顺序、无分区标题、每张有映射卡的 `data-state` 与同一会话 `/api/connections` 的聚合结果逐卡相等、点一张「去连接」落位并高亮、`wanxing-token`「打开」进内嵌页；再用角色账号（simple 预设）复跑确认网格不受布局预设影响。验证：脚本 ALL PASS
- [x] 7.4 台账 `docs/registry-maintenance.md` 新增 §12.15（出片线/门/生产实证/教训/状态，状态行更新后续刀：L2a、L2b、L3）；核销本 tasks；`openspec validate app-center-unified-grid --strict` 绿后归档并同步 spec。验证：归档目录 `openspec/changes/archive/<date>-app-center-unified-grid/` 存在，主 spec 含「统一网格」「连接徽章与去连接」两要求且不含「五线产品线卡片」
