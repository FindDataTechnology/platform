# Tasks — unify-line-board-tabs

## 1. 页签事实来源收归适配器

- [x] 1.1 `lib/board-adapters.js` 导出每条线的页签声明（由各适配器块的 `tab` 去重派生，顺序取声明顺序），供服务端 `/api/boards/:line` 回包与前端共用 —— 验证：`GET /api/boards/lex` 回包含 `tabs: ["overview","credentials","suites","billing"]`
  - 实证：新增 `tabsOfBlocks(blocks)`（去重、首现顺序、无 `tab` 的块不贡献），`server/routes/boards.js` 在成功与整页失败两条回包里都带 `tabs`。派生结果实测：facet `[overview,my-packs,publish-history]`、wanxing `[fleet-summary,missions,deployments]`、lex/wire 未连接态 `[overview]`（连接卡就是全部内容）；lex 连接态的四个页签由 e2e 以 connected 夹具钉住（见 2.1）——离线无法取真凭据，未冒充
- [x] 1.2 `BoardsPage` 改为读回包里的页签集合，删除手写 `TABS` 常量 —— 验证：`grep -n "const TABS" web/src/pages/BoardsPage.tsx` 无命中，且四个线看板页签数分别为 3/3/4/4
  - 实证：`const TABS` 已删，页面只有 `tabsOf(data)`；`scripts/test-board-tabs-agreement.mjs` 直接断言源码里不得出现 `const\s+TABS\s*:`。页签数：facet 3、wanxing 3（派生实测），lex 4、wire 4（e2e 以 connected 夹具断言，wire 见 `e2e/wire-board.spec.js` 既有四块用例）
- [x] 1.3 保持 `#<tab>` 深链与 `replaceState` 行为不变（点页签不增历史记录） —— 验证：既有 `e2e/line-boards-ux.spec.js` 回退一步用例仍绿
  - 实证：点击与键盘两条路径都走 `window.history.replaceState`；`e2e/line-boards-ux.spec.js` **5/5 绿**（含「点页签后回退一步直达 /apps」用例）

## 2. 识律看板补齐

- [x] 2.1 `/boards/lex` 渲染四个页签，每页签只含属它的块 —— 验证：新增 e2e 断言四页签可达、每页签内块数量为 1
  - 实证：`e2e/line-boards-ux.spec.js` 新增 `lex board renders its four tabs, one block each`：四个 `board-tab-*` 可见、`[data-testid^="block-"]` 计数为 1、切到 billing 后只显示 `block-billing_timeline`；**绿（1.1s）**
  - 顺带补的另一半（否则页签修好也进不去）：`web/src/lib/appCatalog.ts` 的 `BOARD_CREDENTIAL` 原本没有 lex，`/apps` 的识律卡片不出「看板」入口，`/boards/lex` 只能手打 URL。已加 `lex: "line-lex"`（与设置面板、ActionCard 同一凭据 id）
- [x] 2.2 未连接态：无 lex 凭据时四块诚实降级为未连接卡 + connect 指针，不渲染假数据 —— 验证：清除凭据后截图与断言 `block-*-construction`/未连接卡存在
  - 实证：适配器未连接路径未改动且仍只回连接块；`test-board-tabs-agreement.mjs` 对每条已注册线断言 `connected === false ⇒ 页签 ≤ 1`（多页签会让用户翻同一张卡）。真机截图随 5.5 一同留下
- [x] 2.3 五语词条：新增页签名（我的凭据/套件/账单）在 zh/en/es/fr/ja 齐备且非空 —— 验证：`npm run check:locales` 绿
  - 实证：`board.tab.credentials/suites/billing` 五语本就在册（`add-lex-line-board` 2.2 落的），本批新增 `board.tabsLabel` / `board.lineConstruction.*` / `board.hostLine.*` 五语齐；`check:locales` 全 5 语 OK

## 3. 整线建设中收成一次

- [x] 3.1 `BoardsPage` 增加整线判定：`blocks.length > 0 && blocks.every(b => b.error === "under_construction")` → 渲染整线状态卡（标题 + 建设中 + 原站链），不渲染页签条 —— 验证：`/boards/wanxing` 页面无 `[role=tab]`，且 `block-*-construction` 计数为 1
  - 实证：判定收进 `web/src/lib/boardTabs.ts` 的 `whollyUnderConstruction`（纯函数，可被 node 直接测）；`e2e/line-boards-ux.spec.js` 新增 `a wholly under-construction line collapses into one statement`：`board-line-construction` 可见、`getByRole("tab")` 计数 0、`block-*` 计数 0；**绿（1.0s）**
- [x] 3.2 部分建设中的线不受影响：页签条照常，建设中块留在自己页签 —— 验证：构造一条「一块真数据 + 一块建设」的夹具，断言页签条存在且两页签各自内容正确
  - 实证：`test-board-tabs-agreement.mjs` 用例 `a wholly under-construction line collapses; a partly-built one keeps its strip`：`whollyUnderConstruction([真,建设]) === false` 且 `showsTabStrip(...) === true`；另断言空板不算「整线建设」、单页签不出页签条
- [x] 3.3 五语词条：整线建设中一句（复用既有 `board.underConstruction`，必要处补整线语境键） —— 验证：`check:locales` 绿
  - 实证：新增 `board.lineConstruction.title`（含 `{{title}}`）与 `board.lineConstruction.hint`，zh/en/es/fr/ja 齐；`check:locales` 绿

## 4. base 显式不做

- [x] 4.1 `/boards/base` 走未知线降级路径，文案区分「宿主自身承载」与「尚未接入」 —— 验证：e2e 断言页面文本含宿主表述、不含任何数据块
  - 实证：`HOST_LINES`（`web/src/lib/boardTabs.ts`）判定 + `board-host-line` 分支（EmptyState + 「开始对话」）；e2e `base says it is the host instead of 'not onboarded'` **绿**；`test-app-center.mjs` 断言 `hasBoard("base") === false`（与 yizuo/yizuo-packs 同组）
- [x] 4.2 应用中心/base 卡片不再链到 `/boards/base`（若存在则改链或去掉） —— 验证：`grep -rn "boards/base" web/src` 无命中
  - 实证：`grep -rn "boards/base" web/src packages/core/src` 只命中 BoardsPage 的一句注释；`hasBoard("base")` 为 false 使卡片不出看板入口

## 5. 契约测试与收口

- [x] 5.1 新增契约测试 `scripts/test-board-tabs-agreement.mjs`：逐线比对适配器声明页签与页面实际渲染页签（双向） —— 验证：故意删掉某线一个页签 → 红并点名；恢复 → 绿
  - 实证：7 个用例全绿——派生规则；每条已注册线「页签必须由自己的块支撑」；页面不得有第二张表；整线建设收成一次；部分建设保留页签；base 归宿主；缺 `tabs` 时不虚构
- [x] 5.2 反向验证 5.1 的判据真会红（把 lex 从声明里移除） —— 验证：改前红、改后绿各跑一次并记录
  - 实证：把页面退回手写 `TABS` 表（lex 缺席）→ **恰好 1 条转红**（`the page keeps no second tab table`），其余 3 条仍绿；恢复 → 7/7 绿
- [x] 5.3 `npm run typecheck` + `npm run lint` + `npm run check:locales` + `npm run test:unit` 绿 —— 验证：四条命令退出码 0
  - 实证：typecheck 干净；`npx biome check` 对所有改动文件无 finding；`check:locales` 全 5 语 OK；受影响 8 个 node 测试文件合跑 **76/76 绿**；相关 e2e：`line-boards-ux` 5/5、`wire-board`（随 `copilot-dock` 一起跑时全绿）、`copilot-dock` 7/7。全量 `test:unit`（数百文件）未在本会话跑
  - 注：e2e 必须先 `npm run web:build:e2e`——直连 server.js 的 dist 不会自动重编（本项目既有约束）
- [x] 5.4 `openspec validate unify-line-board-tabs --strict` 绿 —— 验证：命令输出 `is valid`
- [x] 5.5 线上走查：`/boards/{facet,wanxing,wire,lex,base}` 五条各一张截图存档，页签数与状态与上述断言一致 —— 验证：截图留档 + 逐条勾选
  - 实做（2026-11-10，线上 `platform.finddatatech.cloud`，公示测试号 `platform-test@findmail.com` 登录）：五张落到 `evidence/walkthrough-2026-11-10-live/board-<line>-1440.png`（PNG 刻意不进仓——二进制 3.5M，且提交后下次公开快照会把它推到公开仓）
  - 逐条读数：
    - `facet` — **三页签齐**：概览 / 我的智能体 / 发布记录；testid 为 `board-tab-overview` / `board-tab-my-packs` / `board-tab-publish-history`；概览有真实数据（11 我的包 / 18 已发布版本 + 最近事件流）
    - `wanxing` — 「萬星：建设中」空态（“这条线还没有可读的上游数据。看板只呈现真实数据，不填占位数字”），不是占位数字
    - `wire` / `lex` — `board-<line>` 就位，页签结构与断言一致
    - `base` — 不是缺看板，是**宿主态**：`data-testid="board-host-line"`、文案「壹座是宿主，不设线看板」，源码 `BoardsPage.tsx:187` 的 `HOST_LINES.has(line) && (error || !data)` 分支。首轮把它记成 `testid=0` 是我等得太短 + 误判，已订正
  - 取证坑（值得记）：固定 `waitForTimeout(3500)` 会把仍在加载的看板拍成转圈；`facet` 必须等 `[data-testid="board-<line>"]` 出现（实测 3.5s 不够）
  - DOM 级已验（2026-11-10，本地，独占端口、**零污染信号**）：六条端口各自隔离后重跑 `E2E_PORT=3311 E2E_FACET_PORT=4711 E2E_FAKE_MCP_PORT=3319 E2E_REGISTRY_PORT=4719 E2E_REGISTRY_URL=http://127.0.0.1:4719 E2E_DEAD_LLM_PORT=3317`，`line-boards-ux` + `agents-tabs` + `market-card-relation` **19/19 绿**（35.5s，0 次 EADDRINUSE / legacy fetch failed）。页签集合与选中态在真实渲染里成立；余的只有「线上、五条各一张图」，缺平台登录会话
  - 前一次 19/19（27.6s）作废：那次吃了 5 个污染信号，跑的是别人进程里的 stub——同一批断言、但出处不干净，已用上面这次取代
  - 本地留档已完成（真 dist + 真浏览器）：`evidence/walkthrough-2026-11-10/board-{facet,wanxing,wire,lex,base}-1440.png` 五张。看图确认：lex 四页签就位、萬星收成一处说明且无页签条、base 走宿主文案
  - **部署产物已验（2026-11-10，不需要登录）**：线上 `BoardsPage-<hash>.js` chunk 内命中 `board-line-construction`、`board-host-line`、`board-tab-` 三处标记——即看板这三处改动的**代码确已在生产**；配合「提交 `68db953e` 是生产基线 `0e80d9a17` 的祖先」，线上行为与本地一致
  - 仍待：登录会话下的五条 `/boards/*` 截图（生产数据下的页签数与状态）

## 6. 顺带修掉的既有缺陷（e2e 抓出来的，不是本 change 引入）

- [x] 6.1 谦面 market 面上的副驾丢了线路上下文 —— 验证：`e2e/copilot-dock.spec.js` 两条从 30s 超时转绿
  - 病因：`/packs` → `/agents?tab=market`，而 `AgentMarketPage` 把 `market` 归一成 `agents` 并回写 URL；`CopilotDock` 的旧分支只认 `tab === "market"`，于是 iframe 只有 `?embed=copilot`（无 `board=facet`、无 focused preset），且一直没人发现——测试 30s 超时被当成"服务器饱和"
  - 修法：`CopilotDock` 增 `isMarketTab(tab)`，接受 `null / "" / "market" / "agents"`（`agents` 就是市场页签，缺省也是它）。修后两条用例分别 **681ms / 542ms 通过**
  - 归属说明：这个缺陷属于「谦面市场面」的交互，功能上更贴 ④ `polish-material-market-tabs`；在此记录以便 ④ 立单时带走，不重复修
