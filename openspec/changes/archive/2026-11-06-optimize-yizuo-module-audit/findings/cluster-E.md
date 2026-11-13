# 簇 E（web·多端·门户，28 条）spec 体检报告

审计日期：2026-11-06。方法：逐条 spec 读声明 → 在 web/（React19+Vite，路由权威 `web/src/App.tsx:303-428`）、app/（Expo）、miniapp/（Taro）、packages/core/、supervisor/（13 文件）、electron/、server/、gateway/、dsh harness 中找行为证据。每条 3 分钟时间盒，命中即过，未命中项在「A- 缘由」注明。

## 判定总表

| # | Spec | 判定 | 一句话依据 |
|---|------|------|-----------|
| 1 | app-center | A- | `web/src/pages/AppCenterPage.tsx:196,287`（board/grid testid）、`web/src/lib/appCatalog.ts:32`（yizuo self 锚点）、`packages/core/src/lib/surfaces.ts:48`（nav-apps）；看板凭据条件未逐项复核 |
| 2 | desktop-app-update | A | `electron/updater-core.js:8-29,95-124`（latest.yml+sha512+mac notify-only）、`electron/main.js:33-43`（日志落 userData） |
| 3 | desktop-fleet-console | A | `electron/main.js:54-92,310-311`（托盘驻留+drain 退出）、`server/routes/wanxing-fleet.js:331`（live/catalog 代理）、`web/src/pages/FleetPage.tsx:180-210`（IS_DESKTOP 门+桌面专属说明页）、`Sidebar.tsx:121`（desktopOnly 过滤） |
| 4 | desktop-fleet-runner | A- | `agent-runner/index.js:141,153`（seat 自报+信箱出站半）、`supervisor/descriptors.js:38,63,124-128`（预装禁用+回环注入）；配对/吊销未逐项复核 |
| 5 | desktop-supervisor | A | `supervisor/descriptors.js:107,124-128`（enabled 解析）、`supervisor/steward.js`（常驻形态）、`electron/main.js:355-361`+`smoke-selftest.js:14-25`（渲染自检 capturePage） |
| 6 | dsh-adapter-boundary | A | `scripts/lint-dsh-adapter.mjs`（名单外拒绝+陈旧条目检查）、`scripts/dsh-adapter-files.json` 24 文件与 spec 现存集合一致 |
| 7 | dsh-contracts | A | `scripts/lib/dsh-contracts/contracts.mjs:1609-1634` 合同①-⑱与 spec ①-⑰+⑨b advisory 逐条对齐；候选模式 runner `scripts/dsh-contracts.mjs`；dummy-llm/fake-acp-agent/probe 在场 |
| 8 | dsh-llm-providers | A | `dsh-profile.js:371-399`（ciyuan 逐 cell 覆写+解绑回种）、`scripts/probe-llm-retry.mjs`、`scripts/test-dsh-degrade.mjs` |
| 9 | dsh-plugin-supply | A- | 合同⑧ `contracts.mjs:1516-1583`（plugins/list + set_enabled 持久 toggle 断言）；服务端 inventory 路由未逐项复核 |
| 10 | dsh-runtime-bridge | A | `dsh-bridge.js:92-104`（preset/set 拒绝分类）、`:196`（platform/capabilities）、`:210,222`（model/set、session/cancel）、`:232-250`（hasLiveMethod 探针） |
| 11 | dsh-version-matrix | A | `dsh-matrix/package.json` 钉 0.2.0-rc.2 lockstep；根 `package.json` 恰为 spec 点名的九行；`dsh-matrix/prune.json` + `agent-runner/index.js` 启动校验 |
| 12 | external-skill-sources | A | `external-sources.js:30,33-41,396-432`（TTL 1h、包界限、skillhub 适配器）、`server/routes/extensions.js:546-605`（货架/preview/install）、`web/src/components/extensions/ExternalSourceTab.tsx`+`ExternalInstallDialog.tsx`、`lib/curated-sources.js`+`scripts/adopt-curated-skills.mjs` |
| 13 | mp-bind-guide | A | `miniapp/src/pages/bind-guide/index.tsx:14,25-26`（accountBaseUrl，永不出演示源）、四步+复制 `:137-139`+立即扫码 `:146` 与登录页同路径 `:42` |
| 14 | mp-command-center | A | `server/routes/mp.js:66-113` 与 spec 逐字段对齐（pendingQuestions/jobs 四桶计数/attention/recentDone、空态诚实 `:57-65`）；`miniapp/src/pages/command`+`cron` |
| 15 | mp-demo-mode | A- | `gateway/mp-auth.js:53-57,146-148`（确定性 demo 身份 @demo.invalid+demo 组）、`server/ws.js:50`（demo_limit 码）、`miniapp/src/components/DemoQuotaCard.tsx`；逐 cell 上限执行内部未复核 |
| 16 | mp-demo-sandbox | A- | `miniapp/src/lib/config.ts:31-63`+`runtime.ts:110-141`（配对演示源+一次性行程）、`server/sandbox.js`（流式中不 wipe）、`server/ws.js:56`（sandbox_limit）；pod 调度隔离是仓外基建事实 |
| 17 | official-adoption | A | `scripts/adopt-curated-skills.mjs`（--emit 必带 operator/reviewer、fail-closed 退出 1）、`lib/adoption.js`+`lib/curated-sources.js`、`scripts/test-official-adoption.mjs` |
| 18 | official-locale-coverage | A | `scripts/audit-official-locale-coverage.mjs`、`scripts/test-official-locale-gate.mjs`、`apply/plan-official-en-coverage.mjs` |
| 19 | official-pack-showcase | A | `gateway/packs.js:1774`（/api/packs/official）、`:1459-1613`（部署侧名册，自报不认）、`web/src/components/login/OfficialShowcaseStrip.tsx`（匿名读+登录引导，空集不渲染） |
| 20 | official-starter-agents-content | A- | 快照真值在 `openspec/changes/archive/2026-11-01-modernize-official-business-teams/staging/source-snapshot.json`+`registry-allowtools.json`；基线测试 `test-official-packs-lint.mjs` 在册 |
| 21 | official-starter-teams | A | `web/src/lib/packGuides.ts:75-110` 五支序列（preferred/secondary/advanced）与 spec 次序逐字一致，seedFile 同源 |
| 22 | web-chat-server | A | `server.js:167-168`（perMessageDeflate threshold 1024）、`server/ws.js:214-215`（totalTurns/hasMore）、`:1239-1260`（load_earlier/beforeSeq）、`:445`（pendingQuestionBySession）、`server/turn-dispatch.js` |
| 23 | web-chat-ui | A- | CopilotDock 根挂载（App.tsx）、`web/src/lib/file-preview.ts`、窗口化 store（packages/core/chat-store）；深场景未逐项复核 |
| 24 | web-design-system | A- | ui/ 16 原语全在场（`confirm-dialog.tsx:13-17` 焦点落安全侧、`tabs.tsx:30,55,57`）、`web/src/lib/statusTokens.ts`、`design-lint.mjs`+baseline 36 条；代码头注释「五条规则」实为六条（陈旧注释） |
| 25 | web-list-surfaces | A | `web/src/lib/listCache.ts`（有界 50、前缀失效、订阅重校验）、`hooks/useListCache.ts`、`/fleets/:fleetId` 路由在场 |
| 26 | web-operate-states | A | native-confirm 基线全量清零（design-lint-baseline.json 计 0）、`gNav.ts`（g 前缀+碰撞策略可测）、`App.tsx` ToastV2Host 根挂载 |
| 27 | web-search | A- | `lib/websearch-relay.js`（stored/env 三态+BYOK get/set/clear）、`server/websearch-mcp.js:131`（pool-after-user-failure 归因）、`lib/scoped-relay-token.js`（wsrc-）、`SearchServiceCard.tsx`（BYOK+管理员池健康双区）；「网络搜索」分区措辞已迁位（见 P1） |
| 28 | web-shell-resilience | A | `lib/spa-static-headers.js`（壳 no-cache/资产 immutable 单源、双服务器共享）、`server/routes/misc.js:899,910`、`web/src/lib/chunk-failure.ts`（按 URL 一次性重载+内存兜底）、`App.tsx:299-352`（ShellErrorBoundary 包 Routes） |

**结论：28/28 落在 A/A-；无 B+/C/D。** 产品面 11-06 摸底（25 页面零占位、路由收口干净）与本次 spec↔行为一致性核查互相印证：本簇没有发现能力悬空、归属错位或与代码矛盾的说法；次级三端（app/、miniapp/、supervisor/）的 spec 均能指到同名实现文件与关键行为行。

## B+/C/D 展开节

无。

## 本簇 P0/P1/P2 候选

**P0**：无。

**P1（诚实漂移或审计盲区）**
1. **web-search 设置面措辞漂移**：spec 四处写「设置分区『网络搜索』」，实现已按 `settings-connect-center` 把该面迁为 connections 分节内的 search-service 卡（`web/src/components/settings/ConnectionsSection.tsx:25,172`），仅靠 `App.tsx` 的 `/settings/websearch → /settings/connections?panel=search` 稳定重定向保语义。建议 spec 增补归位说明（指向 connections 卡与重定向）。
2. **mp-demo-sandbox 的 pod 基建要求不可仓内审计**：「demo pod 不落账号节点/专用 hostname/独立数据卷」是部署编排层事实，仓内无 manifest 证据。建议 spec 注明该要求由哪份部署资产承载。
3. **design-lint 头注释陈旧**：`scripts/design-lint.mjs` 头部写 "Five rules" 而实装六条。廉价修复。

**P2（卫生，随手带走）**
4. **dsh-contracts 套件索引不闭合**：代码另有合同⑱（plugin-supply，`contracts.mjs:1516`，归属 dsh-plugin-supply spec）。建议 dsh-plugin-supply spec 补一行「本能力由合同⑧...⑱ 钉住」或 dsh-contracts 补索引行。
5. **starter 种子 5 vs 6**：`docs/fleet-templates/` 现有 6 份 seed（多出 `product-intro-fleet.seed.json`），序列钉 5 支（`packGuides.ts:75`）。建议注一句「第六支为官方模板、不入序列」。
6. **official-starter-agents-content 的溯源真值住在归档 change 目录**：建议复制到 `docs/` 或长期 staging 位置，防归档清理断链。
