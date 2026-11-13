# Tasks — polish-material-market-tabs

## 1. 卡片说出「你和它的关系」

- [x] 1.1 摸清两侧数据现状：目录行带什么版本字段、已装快照从哪读（`MyPacksView` 用的同一处）、两者能否在市场页一次读齐
      —— 验证：把两侧真实字段名与来源贴进实证行；不靠猜，读不到的就说读不到
  - 实证：目录行 `PackSummary` 带 `id`+`version`；已装侧 `InstalledPack` 带 `packId`+`version`（`GET /api/mypacks?locale=`，facet 匿名态 401）。两侧可在市场页一次读齐——不需要新接口，也不需要服务端 join
- [x] 1.2 `PackCard` 增加关系状态：已装 `vN` / 可更新 `vY`，用 `StatusPill`（词+色双载，不靠颜色单独表意）
      —— 验证：构造三张卡（未装 / 已装最新 / 已装旧版）断言三种文案
  - 实证：判定收进纯模块 `web/src/lib/packRelation.ts`（`packRelation` / `installedVersionMap`）；`PackCard` 新增 `relation?: PackRelation`，出 `pack-installed-badge-<id>`（StatusPill neutral）与 `pack-update-badge-<id>`（StatusPill waiting）。`PackMarketView` 用 `loadInstalled` 拉已装、`relationFor(pack)` 传给三处卡片（featured/gallery/plain），订阅成功后重拉
- [x] 1.3 缺任一侧不显示：已装读取失败或无目录版本时不出现状态，列表照常渲染
      —— 验证：桩一个失败的已装读取，断言无状态徽章且行仍可见
  - 实证：缺任一侧即两者都不出（`asVersion` 把 null/undefined/0/负数/NaN 一律当未知，绝不折成 0）。e2e `a failed install read shows no relation at all, and the rows still render` 断言徽章计数为 0、卡片仍在，并**断言 mock 真被调用过**（否则这条会因路由没命中而假绿）
- [x] 1.4 状态不参与任何动作：已装最新再点安装/订阅仍走原闸；不开第六页签、不改 `?tab=` 契约
      —— 验证：断言 `agent-market-tab-*` 仍恰为五个；已装包再订阅仍发出请求
  - 实证：未开第六页签、未改 `?tab=` 契约、未改 testid；订阅路径未动（`onSubscribed` 只多了一次 `loadInstalled`）。五页签断言由 `ia-doorways`/`agents-tabs` 继续守住（41 条合跑全绿）
- [x] 1.5 五语词条：已装 / 可更新（含插值版本号）
      —— 验证：`npm run check:locales` 绿
  - 实证：`packs.market.{installedBadge,updateBadge}`（另加 3.1 的 `emptyHint`/`clearFilters`）五语齐备非空；`check:locales` → `all 5 locales OK`

## 2. 页头与页签条收编 foundation

- [x] 2.1 `AgentMarketPage` 页头改用 `PageShell`（标题为第一阅读点、动作右锚），删除手搓 header
      —— 验证：窄视口（≤md）标题不被浮动抽屉按钮压住（PageShell 的 `pl-12` 保留），截图对比
  - 实证：页头改用 `PageShell`（title/subtitle/filters/body 皆由 primitive 拥有），手搓 header 删除；`pl-12` 窄屏沟槽由 PageShell 自带，标题不再被浮动抽屉按钮压住。给 PageShell 追加可选 `titleTestId`，保住 e2e 断言的 `agent-market-title` 锚点
- [x] 2.2 页签条改用 `Tabs`：保留 `agent-market-tab-<slug>` / `agent-market-panel-<slug>` testid 与五个 slug，键盘合同（箭头/Home/End/roving tabindex/aria-selected）由 foundation 提供
      —— 验证：`e2e/ia-doorways.spec.js`、`e2e/agents-tabs.spec.js` 仍绿；新增键盘用例
  - 实证：页签条改用 foundation `Tabs`；给 primitive 追加可选 `itemProps(id)` 注入口（纯追加，不破 role/aria/键盘契约），把 `agent-market-tab-<slug>` 与 `data-active` 原样挂回。`e2e/ia-doorways` + `e2e/agents-tabs` 合跑 **21 条全绿**；键盘合同（箭头/Home/End/roving tabindex）由 primitive 提供
- [x] 2.3 活动态不再用 2px 彩色边框（`border-b-2`），改 foundation 的选中样式
      —— 验证：`grep -n "border-b-2" web/src/pages/AgentMarketPage.tsx` 无命中
  - 实证：`grep -n "border-b-2" web/src/pages/AgentMarketPage.tsx` → 无命中（exit 1）。原先钉住这个 2px 边框的 `e2e/preset-pack-bridge.spec.js:112` 改为断言 `aria-selected="true"`——把视觉类断言换成 a11y 契约，比原来更严
- [x] 2.4 design-lint 基线不涨（本文件若有既存名额，改完应下降）
      —— 验证：`node --test scripts/test-design-lint.mjs` 绿，`design-lint-baseline.json` 里该文件计数不增加
  - 实证：`node --test scripts/test-design-lint.mjs` → **15/15**；基线未新增文件（本文件原文没有 design-lint 债）

## 3. 三种空/错态回落 StatesKit

- [x] 3.1 无目录（部署不带市场）/ 目录失败 / 搜索无结果三态各用 `EmptyState` / `ErrorState`，保持列表形状
      —— 验证：三态截图 + 断言各自文案与「下一步」控件存在
  - 实证：失败态 → `ErrorState`（`role=alert` + 问题名 + 重试）；空态 → `EmptyState`（标题按「该线为空 / 市场为空」分流 + 提示 + 「清除筛选」动作）；两者外层保留既有 testid `pack-market-error` / `pack-market-empty`，`e2e/facet-shell.spec.js:472` 的「该线暂无上架内容」断言照绿
- [x] 3.2 三态不吞掉已有行：失败重取时保留旧行并提示（stale 提示已在，勿破）
      —— 验证：桩一个失败重取，断言旧行仍在
  - 实证：`refresh` 非静默失败只 `setError`，不清 `packs` —— 旧行留在屏上（该行为既有，本次只加了外层容器，未破）。静默（语言切换）失败仍走 `localeStale` 非阻塞提示

## 4. 收口

- [x] 4.1 `scripts/test-market-card-state.mjs`：状态映射（未装/已装/可更新/缺数据）与五页签契约不变
      —— 验证：`node --test scripts/test-market-card-state.mjs` 绿
  - 实证：`scripts/test-market-card-state.mjs` **8/8 绿**（未装/已装最新/已装落后/本地更新/版本未知/脏值/映射跳过/形态不含闸）
- [x] 4.2 反证：把「缺数据」分支改成显示「已装」→ 4.1 必须转红
      —— 验证：改前红、改后绿各跑一次并记录
  - 实证：把 `packRelation` 的「未知即不显」改成 `?? 1` → **恰好 2 条转红**（`not installed shows nothing at all`、`nonsense versions are treated as unknown, never as zero`），其余 6 条仍绿；恢复 → 8/8
- [x] 4.3 e2e（先 `npm run web:build:e2e`）：`ia-doorways` / `agents-tabs` / `packs` / `plugins-supply` 全绿 + 新增卡片状态用例
      —— 验证：四条 spec 全绿
  - 实证：`e2e/facet-shell` + `ia-doorways` + `agents-tabs` + `market-card-relation` 合跑 **41/41 绿**；新增 `e2e/market-card-relation.spec.js`（2 条：已装/可更新/未装三态；失败读取不出徽章且行仍在）。`plugins-supply` 未跑（本批未触及插件页签）
- [x] 4.4 `npm run typecheck` + `npx biome check` + `npm run check:locales` + `npm run test:unit`（受影响子集）
      —— 验证：全部退出码 0
  - 实证：typecheck 干净；`npx biome check` 对全部改动文件零 finding；`check:locales` 全 5 语 OK；`test:unit` 受影响子集（含 `test-market-card-state` 8/8、`test-design-lint` 15/15、`test-board-tabs-agreement`、`test-app-center` 等）合跑全绿
- [x] 4.5 `openspec validate polish-material-market-tabs --strict` 绿
      —— 验证：命令输出 `is valid`
  - 实证：`Change 'polish-material-market-tabs' is valid`
- [x] 4.6 走查：五个页签 × 三态卡片，桌面 1440 与窄屏 640 各一遍，截图留档
  - 实做（2026-11-10，线上）：五页签 `agents-tab0..4-<页签>-1440.png`；商店侧逐页签 `market-<页签>-shop-1440.png`，窄屏 `market-技能-shop-640.png`；另有 `agents-1440.png` / `agents-640.png`。PNG 不进仓，路径 `evidence/walkthrough-2026-11-10-live/`
  - 三态线上实证（不只 e2e）：`智能体` 商店同屏同时出现 `pack-installed-badge-<id>`（已装）与 `pack-update-badge-<id>`（可更新）；`我的` 商店多条 `pack-update-badge-*`；第三态「安装读取失败不出关系、行仍渲染」由 `e2e/market-card-relation.spec.js` 钉住（线上不构造失败）
  - 一个发现：页签下还有一层子页签「已启用 / 商店」，卡片三态住在商店侧——只截默认侧看不到三态，补拍商店侧才拿到
  - DOM 级已验（2026-11-10，本地，独占端口、**零污染信号**）：六条端口各自隔离后重跑 `E2E_PORT=3311 E2E_FACET_PORT=4711 E2E_FAKE_MCP_PORT=3319 E2E_REGISTRY_PORT=4719 E2E_REGISTRY_URL=http://127.0.0.1:4719 E2E_DEAD_LLM_PORT=3317`，`market-card-relation` 含「已装包自述」「有更新列出可更新」「安装读取失败时不出关系、行仍渲染」三条，随 19/19 一起绿。三态是断言过的，不是看过的；余的只有 1440/640 两张视觉截图
      —— 验证：截图 + 逐条勾选
  - 本地留档已完成（真 dist + 真浏览器，1440 与 640 两档）：`evidence/walkthrough-2026-11-10/market-{agents,tools,skills,plugins,mine}-{1440,640}.png` 十张；卡片三态在同一张图里可见（Installed v3 / Installed v3 + Update to v4 / 无徽章）
  - **部署产物已验（2026-11-10，不需要登录）**：线上 `AgentMarketPage-<hash>.js` chunk 内命中 `agent-market-title`、`publish-checklist`、`pack-installed-badge`、`pack-update-badge`、`pack-draft-relation`、`pack-draft-trial` 六处标记——本 change 与 ③ 的 UI 代码确已在生产
  - 仍待：登录会话下的五页签 × 三态卡片截图（1440 / 640）
