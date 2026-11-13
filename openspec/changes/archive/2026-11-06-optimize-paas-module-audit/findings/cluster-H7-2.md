# 簇 H7-2 健康卡 — 启动/覆盖层/快捷键/认证/适配器/分发/意图/国际化/布局/线看板/线凭据/活控/活测/LLM/启动器（15 模块）

审计人：H7-2 体检员 · 日期 2026-11-06 · paas HEAD `7f127d58`（release/cell-session-persona 分支）
**实册核对**：15/15 全部在 `openspec/specs/` 在册（逐一 ls 核过），零跳过。

**③ 共同部署事实**（fd-infra-deploy/all-services/prod/，只读）：`platform.yaml:57` = `sha-1275719`（源 94ec620f）；`facet.yaml:66` = `sha-7d935ac`（注记源 39d95cce ⊇ 94ec620f）。`git merge-base --is-ancestor 94ec620f HEAD` 实证 ⊆ HEAD；`94ec620f..HEAD` 9 提交仅触及 agent-runner/manager.js（NUL 转义卫生，零行为）+scripts 测试+docs+openspec。本簇关键文件最新提交逐一 is-ancestor 核过（overlay `748e51f7`、dsh-bridge `ff1e6bfe`、board-adapters `dac3b90d`、llm-providers `124bfb2f`、preset-bridge `a7079b94`、auth `535ee55a` 全 ⊆ 94ec620f）——**undeployed=0**。first-run-bootstrap/local-services-launcher 为桌面/dev 面，本就不进 prod yaml（无部署面，如实记）。痛感口径：`git log --oneline --since=2026-09-05 -- <路径>`，n=总 f=fix。

---

### 1. first-run-bootstrap — 评级 B-
**理由**：幂等/原子/合并/不阻塞四要件全实现，但 spec 落后代码 50 天（代码新增了 spec 未载的 runner-id/feed-token 铸造）且零专测。
① 单源实现 `bootstrap/first-run.js:29-82`（corrupt 保文件 `:51-55`、合并用户值优先 `:58`、temp+rename `:78`、WANXING_PLUGIN_RUNNER_ID/:63 与 WANXING_LOCAL_FEED_TOKEN/:72 铸造=spec 外增量）；Electron 入口 `electron/main.js:145` 经 `electron/bootstrap/first-run.js:5` re-export（shadow 形态：纯转发 shim）。
② **零专测**：`bootstrap/first-run`/`first-run` 关键词在 test/ e2e/ scripts/ 均无命中（仅 e2e/helpers.js:124 注记 onboarding tour）。
③ 无部署面（桌面/dev 专用），如实记。
④ n=3 f=0。
⑤ spec 09-08 vs 代码 10-28，剪刀差 **50 天 = stale**。

### 2. focus-overlay — 评级 B
**理由**：preference-diff 单源路由+微调面板+下拉宇宙全落位，测试族 10 月中旬后未随 11-05 的路由改动更新。
① `server/routes/overlay.js:95`（GET addable 宇宙）/`:168`（PUT 校验+存储，注释自证"rides the serialized runtime-mutation path"）；面板 `web/src/components/OverlayPanel.tsx:1-25`（per-item remove+add chips）；API `web/src/lib/overlay-api.ts:33-38`；会话侧交付 `server/agent-session.js:513,917`（同路重写即交付，非存快照）。
② `e2e/focus-overlay.spec.js`(10-22)、`scripts/test-focus-overlay.mjs`(10-14)。
③ undeployed=0（overlay.js `748e51f7` ⊆ 94ec620f）。
④ overlay.js n=4 f=1；OverlayPanel n=2 f=0。
⑤ spec 09-29 vs overlay.js 11-05，剪刀差 **37 天 = stale**（面板侧 10-01 无恙）；spec"流中拒绝"场景未逐条对到守卫行——未证实。

### 3. foldable-observation-shortcut — 评级 B
**理由**：快捷键+主折叠语义+默认展开全实现，混合态翻转语义比 spec 更精细（多数决），唯专测 26 天未动。
① 键位 `web/src/App.tsx:172-175`（ctrl/meta+o → toggleAllGroups）；实现单源 `packages/core/src/store/chat-store.ts:1426-1440`（"inner per-block collapse states are not touched"注释与 spec 逐字对应）；默认展开由同文件 group 状态承载。
② `e2e/thinking-blocks.spec.js`(10-11，26 天)。
③ undeployed=0。
④ App.tsx 共享宿主文件 n 高属归因噪声；chat-store n=1 f=0。
⑤ spec 09-25 vs chat-store 10-28，剪刀差 **33 天 = 边缘 stale**。

### 4. forward-auth — 评级 B-
**理由**：三模式门/信任头/云模式网关密钥/可选 SSO 全实现且 trust-boundary 注释强，但 auth.js 是全仓 fix 密度最高的宿主文件且 spec 落后 49 天。
① `server/auth.js:234`（userFromHeaders+trust）/`:208`（GATEWAY_SECRET_HEADER）/`:311-389`（HTTP 门 forward_auth/logto 分流）/`:43-63`（AUTH_EXEMPT_PREFIXES 豁免清单）；`/api/auth/me` `server/routes/misc.js:184-205`（全字段含 sso*）。
② `scripts/test-auth-mode.mjs`(10-16)、`e2e/auth-catalog.spec.js`。
③ undeployed=0（auth `535ee55a` ⊆ 94ec620f）。
④ auth.js **n=29 f=9（31%）**——多为 roles/logto/mp/pairing 等共栖增量，forward-auth 本体条文近月零返工（归因噪声偏高）。
⑤ spec 09-16 vs auth.js 11-04，剪刀差 **49 天 = stale**。

### 5. harness-adapter — 评级 A-
**理由**：契约/注册表/ACP 适配/物化/部署闸五件全实证，测试族最密（适配器同构断言 397 行+ACP 专测当日更新），spec 当日刷新。
① 契约 `agent-runner/harness/adapter.js:78-86`（start/turn/stop/pid/capabilities 五必需）；注册表 `agent-runner/harness/registry.js:21-30`（dsh 内置+ACP 白名单，"commands are runner-side config, NEVER descriptor data"）；ACP `agent-runner/harness/acp.js:87`。
② `scripts/test-harness-adapter.mjs`(10-15，397 行)、`test-acp-adapter.mjs`(**11-06 当日**)、`test-deploy-harness-gate.mjs`(10-15)、`test-harness-materialize.mjs`(11-06)。
③ undeployed=0。
④ harness/ n=11 f=6——即 ACP 落地特性流本身，非病灶返工。
⑤ spec 11-06 vs 代码 10-22/11-06，**剪刀差 0（spec 反超）**。

### 6. installer-distribution — 评级 B
**理由**：NSIS 顶层/matrix 单源/闭包 afterPack/bundle 烘焙/readiness 门全有实现锚，但打包链是本簇 fix 密度第二高的面且 matrix/闭包侧无专测。
① `electron-builder.js:226`（nsis 顶层键，注释自证 oneClick 陷阱）+`:50-91`（afterPack 整树同步）；`scripts/lib/packaged-tree.mjs`+`scripts/verify-bundle.js`（收集器覆盖门）；`scripts/install-dsh-matrix.mjs:25`（幂等 predist）+`scripts/bake-bundles.mjs:2-72`（resources/bundles 烘焙）；release-sync `scripts/release-sync.mjs`；readiness `server/routes/misc.js:266-271`（dshInitError 曝出）；profile 链接 `dsh-profile.js:463,672`。
② `scripts/test-release-sync.mjs`(10-11)、`test-release-sync-cache.mjs`(10-29)；**install-dsh-matrix/packaged-tree/verify-bundle/bake-bundles 无专测**。
③ 无部署面（桌面分发链），如实记。
④ electron-builder.js **n=13 f=8（62%）**——打包痛感真实且集中。
⑤ spec 10-28 vs 代码 10-29，剪刀差 1 天。

### 7. intent-onboarding — 评级 A-
**理由**：问卷/画像存储/recipe 单源/加法幂等/改选重跑全链落位，spec 与代码同日、测试族齐。
① 画像与计划 `server/onboarding.js:28,57,78,101-120`（EMPTY_PROFILE/stored-wins/isAnswered/recipeFor→plan）；路由 `server/routes/onboarding.js`（243 行）；面板 `web/src/components/IntentOnboarding.tsx`；recipe 数据 `packages/core/src/lib/recipes.ts`。
② `scripts/test-intent-onboarding.mjs`(10-17)、`e2e/intent-onboarding.spec.js`(10-19)、`e2e/onboarding.spec.js`(10-11)。
③ undeployed=0。
④ n=2 f=1（onboarding.js），痛感低。
⑤ spec 10-17 vs 代码 10-17，**剪刀差 0**。

### 8. internationalization — 评级 A
**理由**：五语运行时/解析序/持久化/端onym切换器/守卫全实证，代码近 3 个月零改动=完全稳定，spec 反超代码。
① `web/src/i18n/config.ts:11-17`（SUPPORTED_LOCALES/STORAGE_KEY/端onym表）+`:50-77`（resolveLocale 三级解析）；守卫 `package.json:23`（`check:locales`）+`:27-28`（web:build 前置强制）；语言选择器 data-testid 见 e2e。
② `e2e/i18n.spec.js`(10-11)、`scripts/check-locales.js`、`audit-official-locale-coverage.mjs`。
③ undeployed=0（web 产物随 platform 镜像）。
④ i18n 目录 **n=0 f=0**——全簇最低痛感。
⑤ spec 10-21 vs config.ts 07-26，剪刀差 87 天但方向=spec 新于代码（稳定非漂移），判 fresh。

### 9. layout-configuration — 评级 A
**理由**：统一注册表/四层解析/部署终局隐藏/管理员豁免/工作面定制全落位，测试族 3 天内新，spec 当日刷新。
① 注册表 `packages/core/src/lib/surfaces.ts:40,70,90,106`（NAV/SETTINGS/AGENTS_TAB/SURFACE_REGISTRY，11-03 仍在演进）；解析 `server/layout.js:147-172`（resolveLayout 服务端单次计算）+`:82-98`（recipe layoutPreset/env 注入）；网关层 `server/layout.js:37`（x-forwarded-layout 头）。
② `scripts/test-layout-resolution.mjs`(11-03)、`test-layout-storage.mjs`(11-03)、`e2e/layout.spec.js`(11-02)。
③ undeployed=0（surfaces.ts 11-03 ⊆ 94ec620f 11-06）。
④ layout.js n=1 f=0。
⑤ spec 11-06 vs surfaces.ts 11-03，剪刀差 3 天。

### 10. line-boards — 评级 A-
**理由**：wire/facet 双适配器直读+诚实降级+按形状解析聚焦助手+页签 replace 语义全实现，"占位假数据清零"条文在代码注释与测试双落位。
① 适配器 `lib/board-adapters.js:86`（FacetBoardAdapter，用户自有凭据 `:53-55,92-93`）+`:336`（WireBoardAdapter）；路由 `server/routes/boards.js:19,38-70`（未知线 404 诚实降级）；聚焦助手按形状 `lib/copilot-presets.js:4`（"never by pack id or name: the shape IS the gate"）；动作注册表 `lib/action-registry.js` 经 `server/actions-mcp.js:28`；页面 `web/src/pages/BoardsPage.tsx`+`web/src/App.tsx:356`（/boards/:line）。
② `e2e/wire-board.spec.js`(10-21)、`e2e/line-boards-ux.spec.js`(11-02)、`scripts/test-facet-line-board.mjs`(11-02)。
③ undeployed=0（board-adapters `dac3b90d` ⊆ 94ec620f）。
④ board-adapters n=5 f=0；BoardsPage n=4 f=1。
⑤ spec 11-02 vs 代码 11-02，**剪刀差 0**。

### 11. line-credentials — 评级 B-
**理由**：三 ref+refresh 续期+单飞+401 自愈实现完整、测试 77 用例在册，但窗口内两起生产级事故（安装闸 P0、refresh TTL 误判）暴露无人值守链的真实风险面。
① 投影/store/stale `line-credentials.js:72-73,87-102,127-147`（投影无密钥、refreshToken 同级只写、有链翻 stale 不清行）；铸币回调 `server/routes/line-token-renewal.js:36`（ROTATION_MAX_AGE 15min 锚 last rotation）+`:115-123`（单飞 inflight）+`server/routes/line-credentials.js:252-260`（rotation 原子落库）。
② `scripts/test-line-credentials.mjs`(10-25，474 行)、`test-line-token-renewal.mjs`(10-25，237 行)、`m53-mint-key.mjs`。
③ undeployed=0。
④ line-credentials.js n=4 f=1 + renewal n=2 f=1 + routes n=5 f=1；`b4b2a12e`（P0：安装闸 fall-through registry 使无 registry 凭据客户装不了 wire/lex pack）+`2b423e53`（生产数据点钉死租户 TTL 仅 ~31-33min，原 30min exp 阈值踩边）——**两起真实病灶**。
⑤ spec 11-02 vs 代码 10-25，剪刀差 8 天（spec 新，fresh）。

### 12. live-runtime-control — 评级 B+
**理由**：三 RPC+能力握手降级双侧（子进程声明/宿主探测）完整对齐，降级路径在宿主侧逐处显式分支；测试 24 天未动而 preset-bridge 11-01 仍有演进。
① 宿主侧 `dsh-bridge.js:196`（platform/capabilities 一次/spawn）+`:210,222,229`（model/set、session/cancel、tools/set）；桥插件 `dsh-profile-template/platform-preset-bridge.js:89`（LIVE_METHODS 四元声明）；降级分支 `server/agent-session.js:121,236,253,305`（无方法回落 restart/假停/回合边界）。
② `e2e/live-runtime-control.spec.js`(10-13，24 天)。
③ undeployed=0（bridge `ff1e6bfe`、preset-bridge `a7079b94` ⊆ 94ec620f）。
④ dsh-bridge.js n=15 f=4（共享宿主）；preset-bridge n=10 f=2。
⑤ spec 10-20 vs preset-bridge 11-01，剪刀差 12 天。

### 13. live-service-testing — 评级 B
**理由**：live 项目/只读默认/烟测 opt-in/双命令入口/DEPLOY 文档全按 spec 落位，模块本身即测试，但全族 26 天未动。
① `playwright.config.js:30`（LIVE_SERVICE_URL 默认 NodePort）+`:81`（live 项目无 webServer 注记）；命令 `package.json:19-20`+`Makefile:30,104,109`（test-live/test-live-smoke）；用例 `e2e/live.spec.js`+`live-functional.spec.js`+`live-zhiyu-embed.spec.js`。
② 即本模块本体：`e2e/live*.spec.js`(均 10-11，26 天)。
③ undeployed=0；探针目标=已部署 prod（本次审计未执行实弹）。
④ e2e/live.spec.js n=低（10-11 后未动）。
⑤ spec 10-21 vs live.spec.js 10-11，剪刀差 10 天（spec 新，fresh）。

### 14. llm-model-management — 评级 A-
**理由**：CRUD/探活/sync 分类器/保留路由 override/keyless auth 全实现，spec 与代码同日；唯测试族 10-11 后未随 10-29 的 keyless/本地车道更新。
① 路由族 `server/routes/llm.js:44,79,98,118,140,161,182,203,217`（list/add/edit/delete/clear-override/test/sync/default GET+PUT 全在）；单源 `llm-providers.js`（843 行，write-lock+hot-reload）；本地车道入 fleet 子进程由 dsh profile 路由承载（`dsh-profile.js` 既有机制）。
② `e2e/llm-models.spec.js`+`llm-model-sync.spec.js`+`llm-route-override.spec.js`+`llm-retry.spec.js`(均 10-11)、`scripts/test-llm-providers.mjs`+`test-llm-guard.mjs`+`test-llm-model-discovery.mjs`(10-11)。
③ undeployed=0（llm-providers `124bfb2f` ⊆ 94ec620f）。
④ llm-providers n=5 f=0、routes n=4 f=0——特性后零返工。
⑤ spec 10-29 vs llm-providers.js 10-29，**剪刀差 0**；测试比代码旧 18 天（可接受）。

### 15. local-services-launcher — 评级 C+
**理由**：headless 启动器共享 supervisor 原语+首种幂等复用 bootstrap 单源全落位，但 spec 落后 51 天、零专测、start.js 自 09-08 未动——本簇唯一 C。
① 入口 `scripts/start.js:1-12`（npm start → local-services.main）；seeding `local-services.js:17,49`（复用 bootstrap/first-run.js，与 Electron 同实现=spec 义务）；有序关停 `:85-97`（SIGINT/SIGTERM 不触发 restart-on-crash）；健康门 `:107-110`（不健康即退出带因）。
② **零专测**：`local-services`/`first-run` 在 test/ e2e/ scripts/ 无专测命中（`scripts/test-supervisor-ports.mjs` 只测端口原语）。
③ 无部署面（dev 专用），如实记。
④ local-services.js n=4 f=0；start.js n=1 f=0。
⑤ spec 09-08 vs local-services.js 10-29，剪刀差 **51 天 = stale**。

---

## 簇摘要

**三件最严重的事**：
1. **line-credentials 无人值守链两起生产级病灶**（窗口内 `b4b2a12e` 安装闸 P0 fall-through + `2b423e53` 租户 refresh TTL 实测 ~31-33min 迫使续期节奏重设计）——机制条文已全修并有 711 行专测，但该模块是全簇唯一出现"生产数据打脸设计假设"的面，舰队 7 天真机验收（`fleet_1792786329045_jchvsd`）仍挂账，评级 B-。
2. **first-run-bootstrap 与 local-services-launcher 同源共生却双双失守**：spec 均停 09-08（剪刀差 50/51 天 stale），代码 10 月新增的 WANXING_PLUGIN_RUNNER_ID/WANXING_LOCAL_FEED_TOKEN 铸造未入 spec，且两模块合计零专测——bootstrap 是"写坏一次全盘不可启动"的关键路径。
3. **forward-auth fix 密度全簇第一**（auth.js n=29 f=9，31%）且 spec 落后 49 天：auth.js 已成 roles/logto/miniapp/device-pairing 多轨共栖宿主，forward-auth 本体条文虽零返工，但豁免清单（AUTH_EXEMPT_PREFIXES）每扩一条都是新信任边界，spec 的"Documented trust boundary"要求与实现增速失配。

**评级分布**：A/A- ×6（internationalization、layout-configuration、harness-adapter、intent-onboarding、line-boards、llm-model-management）｜B/B+ ×5（live-runtime-control、live-service-testing、focus-overlay、foldable-observation-shortcut、installer-distribution）｜B- ×3（forward-auth、line-credentials、first-run-bootstrap）｜C+ ×1（local-services-launcher）。
