# 簇 H7-4 健康卡 — 平台账/内存观测/偏好/门面/发布线/资源库×2/定时任务×2/集群调度/中继凭据/设置/侧栏×2/社媒机器人（15 模块）

审计人：H7-4 体检员 · 日期 2026-11-06 · paas HEAD `48cd0fc3`（2026-11-06 06:58）
**实册核对**：15/15 全部在 `openspec/specs/` 在册（逐一 ls 核过），零跳过。

**③ 共同部署事实**（fd-infra-deploy/all-services/prod/，只读）：platform.yaml:57 与 facet.yaml:66 = `sha-1275719`，源 paas `94ec620f`（11-06 05:06，merge-base 实证 ⊆ HEAD 48cd0fc3）。`94ec620f..HEAD` 共 10 提交，逐路径 `git diff 94ec620f..HEAD --stat` 核对本簇 15 模块全部运行时文件（gateway/lib/server/web/electron/services/miniapp 关键路径 32 条）**均为 0 差异**——undeployed=0 全簇成立。窗口内仅 scripts/test-task-retry-policy.mjs（c2532cd6，纯测试）、agent-runner/manager.js（24e64f39，非本簇）、win-smoke workflow（6cee45eb，CI 文件不入镜像）。痛感口径：`git log --oneline --since=2026-09-05 -- <路径>`，n=总 f=fix。

---

### 1. platform-billing — 评级 B
**理由**：ADR-0011 四链（账号解析/key 绑定/余额闸/边界结算）全实证在产，唯核心单测 26 天未动而账务面仍在演进（fix 密度 34%）。
① 单门 `lib/sub2api-admin.js:65-67`（email 解析、不建号不持密码）+`:182-185`（余额内账）；绑键校验 `gateway/packs.js:2354`（outside-selection）/`:2403`（liveness 复检）/`:2433`（key-required）；402 闸 `:2314,2329`；市场结算 `gateway/market.js:3-45`（结算键=成交行 id、pending→settle 挂账如实）。
② `scripts/test-platform-billing.mjs`(10-11，26 天)、`test-agent-serving-billing-park.mjs`(10-21)、`test-empty-turn-billing.mjs`/`test-zhiyu-billing.mjs`。
③ undeployed=0。
④ n=32 f=11（agent-serving 为共享宿主，归因有噪声）。
⑤ spec 10-28 vs sub2api-admin 10-31，剪刀差 3 天。

### 2. platform-memory-observability — 评级 A
**理由**：三层读面/在途预约投影/fail-open/驱逐链逐条落位，spec 11-06 刚随 wake-budget 收敛同步，测试族三天内全刷新。
① 读面路由 `gateway/memory-face.js:64`（registerMemoryFaceRoute，/api/monitoring/memory）+`lib/proc-memory.js:78`（单遍 /proc 扫描）；闸 `gateway/index.js:100`（CELL_MEMORY_ADMISSION_FLOOR）+`gateway/spawner.js:518-652`（预约账本：先记账后物化、判定结束释放、own-footprint 含保守默认）。
② `scripts/test-memory-face.mjs`(11-02)、`test-proc-memory.mjs`(11-05)、`test-cell-memory-gate.mjs`(11-02)。
③ undeployed=0。
④ n=14 f=7——高密度但为 add-wake-budget-admission 特性收敛本身，非返工。
⑤ spec 11-06 vs proc-memory 11-05，剪刀差 1 天。

### 3. preferences-ui — 评级 B
**理由**：IPC 白名单/sandbox/原子写实现锚清晰、60 天零 fix，但本模块无任何专测命中，重启影响面场景不可测证。
① 窗口与白名单 `electron/preferences/window.js:58,72`（settings:get-visible / settings:set-field）+`electron/preferences/preload.js:8`（contextBridge 仅暴露白名单通道）。
② 无专测：scripts/ 与 e2e/ grep preference 零命中——唯一扣分实据。
③ undeployed=0（Electron 桌面面，随桌面出片，非 platform 镜像）。
④ n=11 f=0。
⑤ spec 10-16 vs window.js 11-01，代码反超 16 天（<30）。

### 4. principal-facade — 评级 A
**理由**：门面块发布门校验/委派清单界/目录 is_facade/预设一键挂块四链逐 file:line 实证，fix 密度全簇最低档（5%），测试 11-03 刷新。
① 校验 `lib/pack-manifest.js:1977-2011`（FACADE_KEYS :218，形状/包内引用/corpus 名单）；委派界 `server/routes/delegation.js:63-134`（facadeBoundFor，清单外 400 指名）；目录 `gateway/packs.js:624-629,1026`（is_facade）；一键挂块 `web/src/components/packs/PresetPublishFlow.tsx:54,124-129,256-269`（开关关=清单逐字节不变）。
② `scripts/test-principal-facade.mjs`(11-03)、`test-facade-matters.mjs`(10-26)、`verify-live-facade-visitor.mjs`、`facade-corpus-snapshot.mjs`。
③ undeployed=0。
④ n=38 f=2。
⑤ spec 10-25 vs pack-manifest 11-04，代码反超 10 天。**未证实**：入口"语料截至时间"渲染位（PackDetailDialog 未逐行核）——快照工具在册，风险低。

### 5. release-pipeline — 评级 C
**理由**：矩阵/verify-bundle 描述符门实证在册，但 windows 验收腿 60 天 23 修（56%，全簇最高）且 win-smoke 实弹验证至今挂账（tasks 4/5）。
① 矩阵 `.github/workflows/release.yml:46-56`（mac arm64+x64 via Rosetta+win）；打包覆盖门 `scripts/verify-bundle.js:139-147`（descriptor spawn 图必须入 file list）；bundled Node `scripts/build-node.js`（process.version 同版本不变式）。
② `verify-bundle.js`(10-21)、`scripts/test-release-sync.mjs`/`test-release-sync-cache.mjs`(10-11)。
③ 无部署面（CI/打包配置不入镜像）；但 6cee45eb（11-06，win-smoke Phase B+ runner 腿）在未部署窗——纯 CI 文件，而 04d543ce 明记 2.2 需等下一版桌面出片 dispatch，**验收挂账未收口**。
④ n=41 f=23：`6cee45eb`（windows 三修+新腿）、harden-windows-runner-smoke 连环（profile version 字段/0xc0000142 类秒死）。
⑤ spec 10-21 vs release.yml 11-02，代码反超 12 天。

### 6. resource-library — 评级 A
**理由**：捕获漏斗单源（chat-history.recordMessage）+内容哈希幂等+存储字节耐用复制全落位，spec 与代码同日零剪刀差。
① 捕获漏斗 `chat-history.js:191-231`（resources.captureFromMessage / captureFilesFromTurn，全部客户端与 scheduled-task 同路）；正本 `resources.js`(10-28)；API `server/routes/resources.js:273`（无捕获图表时诚实报错文案）。
② `scripts/test-resources-capture.mjs`(10-11)、`test-resources-api.mjs`(10-16)、`test-resources-store.mjs`(10-16)、`test-resource-memory-gestures.mjs`(10-28，随 tier/tags 扩展刷新)。
③ undeployed=0。
④ n=6 f=1（routes/resources.js）。
⑤ spec 10-28 vs resources.js 10-28，剪刀差 0。

### 7. resource-library-ui — 评级 A
**理由**：双 tab/组 chips 按时间窗计 count/零匹配禁用不隐藏/文件批量 zip 全实证，spec 11-02 与页面同日。
① 页面 `web/src/pages/ResourcesPage.tsx:36`（JSZip）+`:549-584`（仅文件可选中、charts 永不入集、client-side zip）；过滤默认入选=规格 all-tab 四组预勾。
② `e2e/resources-page.spec.js`(10-28)、`resources-save.spec.js`(10-11)、`resources-binding.spec.js`。
③ undeployed=0。
④ n=8 f=1。
⑤ spec 11-02 vs ResourcesPage 11-02，剪刀差 0。

### 8. scheduled-task-notifications — 评级 B
**理由**：unread 客户端推导+双端入口徽章实证、envelope"计划未实现"如实声明（miniapp/src grep requestSubscribeMessage=0），唯 spec 剪刀差 42 天为全簇最大（方向良性：align 批回写现实），小程序组徽章无专测。
① 推导 `web/src/lib/unread.ts:1-23`（last-updated vs last-viewed，storage 满降级）；web 消费 `web/src/components/Sidebar.tsx`（import @/lib/unread，即会话列表位）；小程序徽章 `miniapp/src/components/HistoryDrawer.tsx:26,43-63`（定时任务组头 badge+session-unread-dot）。
② `e2e/cron-ui.spec.js:73`（Session unread derivation）、`zhiyu-unread-badge.spec.js`；小程序面无专测。
③ undeployed=0。
④ miniapp 全目录 n=22 f=7（32%，多为车道随行）。
⑤ spec 11-06 vs unread.ts 09-25，spec 反超 42 天（align-yizuo 批，语义零改动；envelope 条款即"如实未实现"声明）。

### 9. scheduled-tasks-ui — 评级 B
**理由**：任务中心/模板预填/NL 解析落位，但 10-31 上车的 templates+自然语言两条场景在 e2e 零覆盖（cron-ui.spec 无 template/natural 命中），任务页专测 26 天未动。
① 页面 `web/src/pages/TasksPage.tsx:16`（import parseSchedule）+`:37,344-345,566-572`（模板预填，cron-template-* testid）；解析 `web/src/lib/scheduleParse.ts`（10-11）；小程序页 `miniapp/src/pages/cron/`。
② `e2e/cron-ui.spec.js`(10-11，0 处 template/natural——新交互未入测)、`task-lifecycle.spec.js`(10-11，26 天)、`cron-binding.spec.js`/`cron-tools.spec.js`。
③ undeployed=0。
④ n=6 f=1。
⑤ spec 10-31 vs TasksPage 11-02，剪刀差 2 天。

### 10. scheduling-cluster-aware — 评级 B
**理由**：扇出/聚合/summary 单落/allowParallel 顺序劣化如实注记全实证，但所在 cron 面痛感全簇第二（38%）且 task 重试链 11-06 再收第三处 CI-only flaky。
① 扇出 `server/cron-runner.js:939-1169`（成员解析→子会话 `<bound>--<agentId>`→all/first/summary；summary :1166-1169 单落；顺序劣化注记 :1008,1121）；共享记忆钩 `server/cluster-memory.js`（degrade-open）。
② `scripts/test-cluster-tasks.mjs`(10-22)、`test-task-engine.mjs`(10-31)、`test-cron-*.mjs` 族。
③ undeployed=0（cron-runner 11-06 03:54 ⊆ 94ec620f 05:06，已随当日镜像）。
④ n=47 f=18；`c2532cd6`（11-06，重试定时器赛跑第三例，测试侧在未部署窗）。
⑤ spec 10-22 vs cron-runner 11-06，代码反超 15 天（<30；wake/interval 语义演进在 cron-module 归属）。

### 11. scoped-relay-credentials — 评级 A
**理由**：HMAC 无状态派生/scope 吊销 denylist/裸奔拒启/BYOK 覆盖不落盘全逐行实证，60 天低痛感，spec 与实现 9 天温和剪刀差。
① 派生 `services/search-relay/scoped-token.js:9,25,59-64`（wsrc-<scope>-<hex>、revoked denylist 即时 401）+`:76-79`（静态/派生双通道并存）；BYOK `services/search-relay/index.js:25-27`（X-Serpapi-Key 请求级覆盖、x-search-source user/pool/pool-after-user-failure）；宿主注入 `lib/scoped-relay-token.js`（per-cell 派生值落 MCP patch）。
② `scripts/test-search-relay-scoped.mjs`(10-22)、`test-scoped-relay-host.mjs`(10-13)、`test-search-relay-lane.mjs`、`embed-search-relay-configmap.mjs`。
③ undeployed=0（services/search-relay 对 94ec620f 零差异）。
④ n=7 f=1。
⑤ spec 10-13 vs relay 10-22，剪刀差 9 天。

### 12. settings-surface — 评级 B
**理由**：三组 13 slug/深链/退役重定向/未知 slug 兜底全实证，但 22% fix 密度里有一处真"勾了没到位"（委托假旋钮），e2e 主 spec 26 天未动。
① 路由 `web/src/App.tsx:420-428`（/settings/websearch→connections?panel=search 重定向+/settings/:section）；节表 `web/src/components/settings/sections.ts:108-291`（SETTINGS_SECTIONS+DEFAULT_SECTION general+aliases）；弹层 `SettingsDialog.tsx`（backgroundPath 保底 /chat）。
② `e2e/settings-modal.spec.js`(10-11，26 天)、`settings-devices.spec.js`、`settings-wechat-app.spec.js`、`scripts/test-settings-keys.mjs`、`test-websearch-settings.mjs`。
③ undeployed=0。
④ n=32 f=7：`eeadf232`（委托两假旋钮接线+裁决模型改服务端取——设置面真实返工）、lint 批三件（e74f2330/39f31eb4/9c82d14e）。
⑤ spec 10-18 vs sections.ts 10-29，代码反超 11 天。

### 13. sidebar-nav-families — 评级 B
**理由**：家族单源在 registry 同文件、隐藏成员不入族、活跃面强制展开全实证；唯家族三件专测 26 天未动而 Sidebar 处于活跃演进带（23% fix 密度，含 d5f28cc8 真路由 bug）。
① 家族定义 `packages/core/src/lib/surfaces.ts:127-134`（knowledge=[knowledge,resources,memory]、build=[agents,fleets]、blueprints 注记退役）；渲染与折叠 `web/src/components/Sidebar.tsx:140-177`（NAV_FAMILY_COLLAPSED_KEY、单员族摊平）。
② `e2e/sidebar-collapse.spec.js`(10-11，26 天)、`nav-persistence.spec.js`/`nav-routes.spec.js`(10-11)、`fleet-nav-gating.spec.js`。
③ undeployed=0。
④ Sidebar.tsx n=26 f=6（`d5f28cc8` 原生选路漏传 path 真 bug——typecheck 门显形；与 H7-1 对 app-navigation 的判定同源）。
⑤ spec 11-04 vs surfaces.ts 11-03，spec 反超 1 天。

### 14. sidebar-workspaces — 评级 A
**理由**：web 按项目归属分组/桌面按路径分组双轨如实、绝对路径不上面、show-more 分组独立于折叠全实证，专测随批刷新。
① 分组键 `web/src/components/Sidebar.tsx:284-330`（projectId→display name，无归属落默认项目 fallback；组成员钉在首回合镜像）+`:237`（Show N more 独立态）+`:629-669`（Workspaces 头节）。
② `e2e/sidebar-workspaces.spec.js`(10-31，6 天)。
③ undeployed=0。
④ 与 nav-families 同文件同 n=26 f=6（共享宿主归因）。
⑤ spec 10-31 vs Sidebar.tsx 11-02，剪刀差 2 天。

### 15. social-bot-channels — 评级 B
**理由**：功能面全落位且 11-04 刚同步 21 条需求，但 60 天 13 修（46%）由真实生产事故链驱动（boot latch 丢消息→durable 收理），机器人面是全簇生产痛感最重资产；e2e 面板测试 26 天未动。
① 串行队列 `server/bots.js:67,599-606`（sessionId tail promise）；pending ask `:74,293,420-446`（编号选项文本+下一条入站应答）；boot latch `:163-168`（listen 先于 initBots 的 fd-prod 事故补丁）；身份注入 `:694-695`（identity 块在首）；网关 webhook `gateway/index.js:914-932`（/api/bots/webhook/:botId/:secret，无身份头豁免）；企微群聊 `server/bots/wecom-bot.js:1-12`（chattype single|group+群 chatid）；收理先于 ack=scripts/test-bot-webhook-durability.mjs:1-5（同消息 id 重放不二跑、跨进程接管如实）。
② `scripts/test-bots.mjs`/`test-bot-webhook-durability.mjs`/`test-bot-webhook-boot-latch.mjs`(均 11-01)、`test-wecom-bot-pipeline.mjs`(10-31)、`test-gateway-bot-webhooks.mjs`(11-01)、`e2e/bots-surface.spec.js`(10-11，26 天)。
③ undeployed=0。
④ n=28 f=13：`1c5e92a1`(11-03) 前的冷启动/幂等/durability 连环。
⑤ spec 11-04 vs bots.js 11-03，剪刀差 1 天。

---

## 簇摘要

**三件最严重的事**：
1. **release-pipeline（C）windows 验收腿连环失血且收口挂账**：60 天 23 修（56%）集中于 win-smoke（profile version 三修/0xc0000142 秒死/Phase B+ 新腿），hard change 的实弹验证仍在等下一版桌面出片（04d543ce tasks 4/5）——全仓最不稳定的验收轨之一，建议腿基建固化（runner 快照+最小 serving pack 夹具仓库化）。
2. **social-bot-channels（B）生产事故链后的韧性补丁堆积**：46% fix 密度由真实 fd-prod 事故驱动（listen 先于 initBots 丢消息→boot latch→durable 收理先于 ack→幂等重放），当前实现已收敛且测试 11-01 全刷新，但 e2e 面板（bots-surface 10-11）未随企微群聊/挂账重放演进——建议把 durability/幂等场景上提 e2e。
3. **scheduled-tasks-ui（B）新交互零测试上车**：10-31 的模板预填+自然语言解析两条 spec 场景在 e2e 零命中（cron-ui.spec 无 template/natural），scheduleParse.ts 为纯函数最易补测；同域 task 重试链 11-06 又收第三处 CI-only flaky（c2532cd6），cron 面痛感 n=47 f=18 全簇第二。

**评级分布**：A×6（platform-memory-observability、principal-facade、resource-library、resource-library-ui、scoped-relay-credentials、sidebar-workspaces）· B×8（platform-billing、preferences-ui、scheduled-task-notifications、scheduled-tasks-ui、scheduling-cluster-aware、settings-surface、sidebar-nav-families、social-bot-channels）· C×1（release-pipeline）· D×0
