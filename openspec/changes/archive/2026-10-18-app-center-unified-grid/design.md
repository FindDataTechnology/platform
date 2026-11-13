# Design — app-center-unified-grid

## Context

动机见 proposal.md「Why」。与方案有关的现状约束：

- `AppCenterPage.tsx` 两段 JSX 各自成网格：`LineCard`（吃 `APP_LINES`）与内联产品卡（吃 `/api/catalog` 过滤 `kind ∈ {external-service, link}`）；产品卡的「打开」已有内嵌/外链分支（`external-service && embedded !== false` → `/external/:id`），这段分支逻辑必须原样保留。
- `appCatalog.ts` 是品牌事实单源（五条，`status: live|early`，`self` 标平台自身），`scripts/test-app-center.mjs` 以 `node --test` 直接 `import` 这个 `.ts`（Node 26 原生剥类型），所以**放在这里的纯函数天然可单测**；web 工程本身没有 vitest。
- `/api/connections`（L1 落地）返回 `{connections:[{id,name,state,reason}]}`，state ∈ `connected|stale|disconnected|not-configured`，id 集固定为 `registry / facet-market / connector / line-wire-customer / line-lex / line-wanxing-caller / paper-trading / search`；admin 请求会对搜索 relay 做一次 ≤3s 的有界探测，端点整体延迟上限由它决定。
- 连接分节深链 `?panel=<id>` 的高亮落在 `CardAnchor`：`data-panel={ids[0]}`、`data-panel-active="true"`；三条线（wire/lex/wanxing-caller）共用一张卡，`ids[0]="line-wire-customer"`。
- `agents.json` 产品条目只有 `id/kind/name/url/description`，无品牌归属字段；它是 GitOps 数据，本 change 不改它。
- 现有 e2e `app-center.spec.js` 4 条断言分区 testid（`app-center-lines`/`app-center-platform-apps`）与分区标题 locale 键；除此之外全仓无人引用这两个 testid 与 `linesHeading/appsHeading`。
- 词汇：CONTEXT.md「生态产品」词条已把「产品线」「平台应用」「应用」列为 Avoid；「萬星 Caller」是「词元账号」旧称（同一把钥匙）。

## Goals / Non-Goals

**Goals:**

- 一份可单测的纯数据层：`APP_LINES` + 目录条目 + 连接状态 → 有序统一卡列表（归属、排序、徽章聚合、去连接目标全在纯函数里），页面只做渲染。
- 徽章永远「有则准、无则缺」：任何一路数据失败都不能让另一路消失，也不能让卡片动作失效。
- 零后端改动、零数据迁移、零 GitOps 数据改动；可直接走公开快照线出片。

**Non-Goals:**

- 不为产品引入新的后端目录字段或端点；品牌归属的显式字段只是**读侧预留**（有则用，无则推断）。
- 不做徽章轮询/实时刷新：发现面一次读取即可，状态变更由用户从连接分节回来时的重新挂载自然刷新。
- 不改智能体页「应用」tab 的 `AppCard`（那是工作面的卡，带 connect/连接中状态，职责不同），两处不强行共用组件。

## Decisions

### D1 统一条目模型放在 `appCatalog.ts`，页面无业务逻辑

新增类型 `AppGridEntry { id, brand, kind: "brand"|"product", nameKey|name, taglineKey|description, icon, status, self, url, embedded, connections: string[] }` 与三个纯函数：`buildAppGrid(lines, catalogApps)`（归属 + 排序）、`aggregateConnectionState(ids, statesById)`（四态聚合）、`connectTargetFor(ids, statesById)`（首个非 connected 的 id）。页面把两次 fetch 的结果喂进去渲染。

- 理由：`scripts/test-app-center.mjs` 已经能直接 import 这个文件；把排序/归属/聚合写进 React 组件就没法在没有 vitest 的 web 工程里单测，而这三件事恰恰是最容易出错也最该被断言的。
- 备选：在页面内 `useMemo` 完成——放弃，不可单测；新建 `web/src/lib/appGrid.ts`——可以，但品牌事实、连接映射、聚合规则是同一份「应用中心单源」，拆文件反而让「单源」变两源。

### D2 产品归属：显式 `line` 字段优先，`<brand>-` 前缀推断兜底

`brandOf(app) = app.line ?? APP_LINES.find(l => app.id.startsWith(l.id + "-"))?.id ?? null`；`null` 排末尾。

- 理由：现有三条产品 id（`yizuo-packs`/`wanxing-token`/`wanxing-connector`）前缀即品牌，推断零成本且今天就正确；显式字段为 GitOps 侧将来加非前缀命名的产品留口子，不必现在就改 `agents.json`。
- 备选：在 `appCatalog.ts` 里硬编码 `productId → brand` 表——产品是部署数据、随 GitOps 变，前端硬编码表会在新增产品时静默漏归属；只认显式字段——现在就得改 GitOps 数据并滚一轮，没必要。

### D3 连接映射按**宿主**归属，键是卡 id，单源一张表

`APP_CONNECTIONS: Record<string, string[]>`：`yizuo-packs→[registry]`、`facet→[facet-market]`、`wanxing-token→[line-wanxing-caller]`、`wanxing-connector→[connector]`、`lex→[line-lex]`、`wire→[line-wire-customer, paper-trading]`。`yizuo`/`wanxing` 不在表中即无徽章；`search` 不是产品，不入表。

- 争议点是 `registry`：L1 把它放在连接分节的「谦面」归组卡里（行名「工具市场登录」，`/api/connections` 名「谦面·工具市场」），而它弹窗铸造的宿主 `MARKET_REGISTRY_URL` 正是 `mcp.finddatatech.cloud`——也就是「壹座·Packs」卡的 `url`。徽章回答的问题是「我打开这张卡的产品时登没登上」，所以按宿主挂到 `yizuo-packs`，而不是按 L1 的品牌归组挂到 `facet`。
- 代价：用户在 `yizuo-packs` 点「去连接」会落到连接分节里标着「谦面」的归组卡——这是 L1 已知的「谦面双胞胎」命名遗留，本 change 不改名（见 proposal 非目标），但在 design 里记下：若后续重命名，改的是 `/api/connections` 的 `name` 与连接分节卡名，本表不动。
- 备选：挂到 `facet`——与 L1 分组一致但宿主不符（谦面卡的 `url` 是 `facet.finddatatech.cloud`，与 registry 宿主无关，徽章会答非所问）；两张卡都挂——一个连接两处亮灯，用户会以为是两个账号。
- 单测守门：表中每个 id 必须 ∈ `/api/connections` 的已知 id 集（硬编码在测试里，与 `e2e/connections.spec.js` 的列表同源），防手滑。

### D4 四态聚合，`partial` 独立成态

规则：全部 `connected`→`connected`；任一 `stale`→`stale`；部分 `connected` 且无 `stale`→`partial`；否则→`disconnected`。`not-configured` 按非 connected 处理（当前只有 `search` 会出这个值，不在表中）。

- 理由：柏讯一张卡挂两条连接（wire 操作 + 模拟交易），真实用户常见「只连了其一」。把它报成「未连接」是说谎，报成「已连接」也是说谎；`stale` 优先于 `partial` 是因为「需重连」是用户要立刻动手的事。
- 备选：三态把 partial 并入 disconnected——会让已经连上 wire 的用户看到「未连接」然后去重复铸造。

### D5 去连接目标 = 首个非 connected 的 id；外链/内嵌分支原样保留

`connectTargetFor` 按表中声明顺序取首个非 `connected` 的 id，拼 `/settings/connections?panel=<id>`。「打开」沿用现有三分支（self 无 / embedded → `/external/:id` / 其余 `window.open`）。

- 理由：柏讯 partial 时精确落到缺的那条（`paper-trading`），而不是落到卡顶部让用户自己找。深链语义由 L1 的 `?panel=` 承接，三条线共卡的高亮由 `CardAnchor` 的 `ids[0]` 处理，本侧不需要知道卡的分组。

### D6 两路 fetch 并行、互不阻塞；任一失败只缺自己那部分

`/api/catalog` 与 `/api/connections` 同时发起，各自 `catch → null`。`apps === null` → 无产品卡；`states === null` → 无徽章无去连接。品牌卡永远先渲染（静态）。

- 理由：`/api/connections` 对 admin 有 ≤3s 探测，串行会让整页等它；而徽章缺席是「诚实降级」，卡片缺席才是故障。两个 `null` 哨兵各管各的，页面不出现中间态文案。
- 备选：一个 loading 状态挡全页——把一个只读徽章的延迟放大成整页白屏；用 React Query——工程里没有，不为此引入。

### D7 spec 用 REMOVED + ADDED 而非 MODIFIED

旧要求名「五线产品线卡片」本身是 Avoid 用词，MODIFIED 必须保留原标题；且新要求的主语从「五线」变成「全部生态产品」，是替换不是修改。REMOVED 写明 Migration（行为与 testid 全部由新要求承接），归档后主 spec 不留旧词。同时直接把主 spec 的 `TBD` Purpose 补上（instructions 明示此操作在主 spec 原地做）。

### D8 testid 契约：卡级不变、区级收敛、新增两枚

保留 `app-card-{id}` / `-open` / `-self` / `-early-badge`（既有 e2e 与潜在外部脚本依赖）；`app-center-lines`/`app-center-platform-apps` → 单一 `app-center-grid`；新增 `app-card-{id}-connection-badge[data-state]` 与 `app-card-{id}-connect`。e2e 对 `partial/stale/connected/失败` 四种响应用 `page.route("**/api/connections", …)` 注入——hermetic 环境只有「全未连接」一种真实态，其余态必须 mock 才测得到。

## Risks / Trade-offs

- [角色过滤让目录产品缺卡，品牌序里出现「品牌卡后面没有产品」的空档] → 这是正确行为（用户确实无权看那条产品），不补占位；e2e 的 8 卡断言只在 hermetic（无角色过滤）下成立，spec 场景已注明前提。
- [`registry` 按宿主挂到壹座·Packs，与连接分节的「谦面」归组在用户眼里对不上] → 已在 D3 记录为 L1 命名遗留；徽章深链仍能落到正确的行（`?panel=registry`），功能不受影响；重命名另立 change。
- [`/api/connections` admin 探测 3s 让徽章晚到] → D6 并行 + 徽章独立哨兵，卡片零等待；不加 loading 文案避免闪烁。
- [删掉两个分区标题后，网格第一眼少了「这是什么」的分组提示] → 品牌序 + 产品名自带品牌前缀（萬星·词元）承担分组语义；副标题改为生态产品口径补足上下文。实机走查若仍觉得平，再议是否加极轻的品牌分隔，不在本 change 预设。
- [五语新增键靠机器翻译，es/fr/ja 质量] → 四态文案都是两三字短语（已连接/部分连接/需重连/未连接/去连接），沿用 L1 连接分节同义词条的既有译法，`check:locales` 守键集一致。
- [e2e mock `/api/connections` 后与真实端点形状漂移] → mock 负载只用 `{id,state}` 两字段，与 `connections.spec.js` 对真实端点的白名单断言同源；真实形状若变，先红的是那条 spec。

## Migration Plan

纯前端改动，随常规镜像出片：`fd-build-channel` 判路 → 公开快照线出片 → relay → `fd-infra-deploy` 双清单滚 tag → ArgoCD → 生产真机走查（用 `scripts/verify-live-*.mjs` 同款方式写一条 `/apps` 走查：8 卡、顺序、徽章与 `/api/connections` 一致、去连接落位）。无数据迁移、无 GitOps 数据改动。回滚 = 双清单回上一 tag（`sha-bed11a5`）。

## Open Questions

（无——归属规则、映射、四态、testid 契约均已定；「谦面双胞胎」改名明确延后，不影响本 change 的 spec/任务。）
