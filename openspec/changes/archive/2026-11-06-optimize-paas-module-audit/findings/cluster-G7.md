# 簇 G7 健康卡 — web / portal / official / desktop / mp / panel 全系（20 模块）

审计人：G7 体检员 · 日期 2026-11-06 · paas HEAD `39d95cce`（2026-11-06 04:16）
**实际在册清单**（`ls openspec/specs/ | grep -E '^(web|portal|official|desktop|mp|panel)'`）：`desktop-app-update / desktop-fleet-console / desktop-fleet-runner / desktop-supervisor / mp-bind-guide / mp-command-center / mp-demo-mode / mp-demo-sandbox / official-adoption / official-locale-coverage / official-pack-showcase / official-starter-agents-content / official-starter-teams / web-chat-server / web-chat-ui / web-design-system / web-list-surfaces / web-operate-states / web-search / web-shell-resilience` 共 20 条（portal\*、panel\* 命中 0 条）。
**③ 共同部署事实**：web/mp/official 服务端全部宿 `fd-infra-deploy/all-services/prod/platform.yaml:57` 镜像 `sha-a96731b`（源 paas `5e91d61b` 2026-11-06 03:55，`git merge-base --is-ancestor 5e91d61b HEAD`=是）；落后 3 提交经逐一核对全为 docs/test（`39d95cce` 测试隔离、`9f13fda8`/`8cf6d2f5` docs，`git log --oneline 5e91d61b..HEAD`）——**产品代码零滞后**。官方市场读面同镜像跑在 facet 角色 `facet.yaml:66` `sha-a96731b`。demo 环境 `platform-demo.yaml:71` 镜像 `sha-1c17030`（源 `1f3f15a4` 2026-11-05 12:15 ⊆ HEAD，落后 45 提交但时间差约 16h）。desktop 系与 miniapp 系为客户端分发，不在 k8s prod yaml（③记 N/A，desktop 更新走静态发布道 `scripts/desktop-lane-sync.sh`）。`search-relay.yaml:32` 用公共 `node:25-bookworm-slim` 基底、无 paas sha（web-search 上游旁路容器，非 paas 代码）。

---

## desktop-app-update — A
发布道/校验/降级三需求均有锚点，spec 与代码同日更新。
① 对齐：`electron/updater-core.js:1`（"Desktop update core (add-desktop-in-app-update)"——latest.yml 解析+哈希+macOS 无签名降级注释 ：7-18）；`electron/updater.js`（electron 壳绑定）。
② 测试：`scripts/test-desktop-update.mjs`（mtime 2026-11-02，与 spec 同日）。
③ 部署：N/A（客户端静态发布道；`scripts/gen-desktop-latest-yml.mjs` 供 yml）。
④ 痛感：updater-core.js since 9/5 共 2 提交 0 fix。
⑤ 陈旧度：spec 2026-11-02 vs 代码 2026-11-02——零剪刀差。

## desktop-fleet-console — A
托盘驻留+舰队页双源读面落齐，测试与 spec 同周。
① 对齐：`electron/main.js:60` `ensureTray()`（注释明引 add-desktop-fleet-console：关窗驻留、仅托盘 Quit 排空）；舰队页 web 侧 `web/src/pages/FleetsPage.tsx`；本机目录探针 `electron/local-cluster-probe.mjs`。
② 测试：`scripts/test-desktop-fleet-console.mjs`（10-28）、`scripts/probe-desktop-fleet-console.mjs`、e2e `fleets.spec.js`（10-30）/`fleet-hub.spec.js`（10-31）。
③ 部署：N/A（客户端）。
④ 痛感：electron/ 全目录 since 9/5 共 28 提交 7 fix（25%，desktop 系最高，含 console+supervisor 合计）。
⑤ 陈旧度：spec 2026-10-31 vs electron/main.js 近期 11 月初——不 stale。

## desktop-fleet-runner — A
机位分片/配对/预装禁用三点全有实现与测试。
① 对齐：`supervisor/descriptors.js:33`（"Wanxing fleet plugin (openspec: desktop-fleet-runner)"：失败降级 status、云默认 runner-1 桌面不接 untagged ：36-41）；端口单源 `AGENT_RUNNER_PORT` :43-47。
② 测试：`scripts/test-desktop-fleet-runner.mjs`（10-29，分片+端口单源用例 ：9/:36）；探针 4 件 `probe-desktop-fleet-{runner,pairing,mailbox,uplink}.mjs`；e2e `fleet-local-cluster.spec.js`（10-29）。
③ 部署：N/A（客户端）。
④ 痛感：descriptors.js since 9/5，无 fix 主导。
⑤ 陈旧度：spec 2026-10-28 vs descriptors.js 2026-10-29——不 stale。

## desktop-supervisor — B
359 行全簇最大 spec（10-28 加码），但行为回归网停在 9 月中。
① 对齐：`supervisor/lifecycle.js`（启动健康等待/依赖序）、`supervisor/health.js`（per-transport 探活）、`supervisor/descriptors.js:14`（禁用插件跳过）。
② 测试：`scripts/test-supervisor-ports.mjs`（mtime **2026-09-13**——早于 spec 末次更新 45 天）；electron 冒烟 `electron/smoke-selftest.js` 存在但端口/健康语义专用测试未见更新。
③ 部署：N/A（客户端）。
④ 痛感：supervisor/ since 9/5 共 18 提交 6 fix（33%）。
⑤ 陈旧度：spec 2026-10-28 vs lifecycle.js 2026-10-15——13 天不 stale；**测试件相对 spec 老化 45 天**是扣分点。

## mp-bind-guide — A
四步引导+真实 origin 双侧齐备，小而完整。
① 对齐：`miniapp/src/pages/bind-guide/index.tsx`（引导页）；`server/routes/mp.js:26` `GET /api/mp/bindcode`（六位码+刷新 ：41）。
② 测试：`scripts/test-bind-qr.mjs`（09-28，与页面同日）。
③ 部署：platform `sha-a96731b`（routes/mp.js 10-14 内容已含）；小程序端为客户端分发 N/A。
④ 痛感：bind-guide/index.tsx since 9/5 共 1 提交 0 fix。
⑤ 陈旧度：spec 2026-09-29 vs 页面 2026-09-28——不 stale。

## mp-command-center — A
聚合端点+小程序三区页+测试三点闭环。
① 对齐：`server/routes/mp.js:66` `GET /api/mp/command-summary`（实例内聚合/内存快照）；`miniapp/src/pages/command/index.tsx:1-3`（明引 add-mp-command-center，空态注释诚实）。
② 测试：`scripts/test-mp-command-summary.mjs`（10-13，明引 spec 1.2）。
③ 部署：platform `sha-a96731b`。
④ 痛感：routes/mp.js since 9/5 共 3 提交 1 fix；command 页 0 fix。
⑤ 陈旧度：spec 2026-10-21 vs 代码 2026-10-13/14——spec 领先代码 7 天（补文档向），不 stale。

## mp-demo-mode — A
网关专属 demo 身份/隔离 cell 池全锚定。
① 对齐：`server.js:258-262`（"Demo mode stays gateway-only"：MP_DEMO_MODE 泄漏也强制 false）；`server/ws.js:20-27` `createDemoBudget()`（cell 学 demo、openid 不入存储路径）；live 探针 `scripts/probe-demo-live.mjs:1-10`。
② 测试：`scripts/test-mp-demo.mjs`（10-14）、`test-demo-quota.mjs`（09-26）。
③ 部署：demo 环境 `platform-demo.yaml:71` `sha-1c17030`（源 `1f3f15a4` ⊆ HEAD，落后 45 提交/约 16h）——spec 面无 10 月后行为变更，未证实有漏。
④ 痛感：test-mp-demo.mjs 5 提交 2 fix（demo 计费/配额是打磨区）。
⑤ 陈旧度：spec 2026-09-26 vs ws.js 2026-10-31——代码更新，不 stale。

## mp-demo-sandbox — A
全连接配额+禁上传+周期擦除三点全实现。
① 对齐：`server.js:186-191`（"Accountless demo sandbox (openspec: mp-demo-sandbox)"：DEMO_SANDBOX 开关+WIPE_SECS 默认 7200）；周期擦除 `server.js:526-543` → `server/sandbox.js:11` `wipeSandboxSessions`；每连接独立预算 `server/ws.js:82-85,369`（`sandboxBudget.take(null)`，quota-end 机器可读码 ws.js:46）。
② 测试：`scripts/test-mp-demo-sandbox.mjs`（10-14）。
③ 部署：demo 环境 `platform-demo.yaml:71`（见上，源 11-05）。
④ 痛感：sandbox.js since 9/5 共 1 提交 0 fix；ws.js 6/24 fix 集中在配额 echo（配额链是活跃修复区）。
⑤ 陈旧度：spec 2026-09-29 vs sandbox.js 2026-09-25/ws.js 10-31——不 stale。

## official-adoption — A
许可门/钉版快照/可归属转正三需求锚点齐。
① 对齐：`lib/adoption.js:23-24`（`assertLicenseAdmissible`+upstream 许可证据采集——"货架 licenseState 不参与判定" ：294）；`scripts/adopt-curated-skills.mjs:9-13,43`（--operator/--reviewer 可归属强制）。
② 测试：`scripts/test-adoption.mjs`（10-31）、`test-official-adoption.mjs`、`test-adoption-display.mjs`。
③ 部署：facet 角色 `facet.yaml:66` `sha-a96731b`（lib/adoption 11-03 改动**晚于镜像源 5e91d61b**，未证实已上产——属领先≤2 天的常规窗口）。
④ 痛感：lib/adoption.js 3 提交 1 fix。
⑤ 陈旧度：spec 2026-11-04 vs 代码 2026-11-03——不 stale。

## official-locale-coverage — A
en 副轨覆盖门+在架审计门同模块无再推导。
① 对齐：`lib/pack-locale-coverage.js`（唯一分母）；`scripts/audit-official-locale-coverage.mjs:1-28`（在架审计：LIVE 读面算 en 覆盖，gap 即非零退出）；发布门 `PACK_OFFICIAL_EN_GATE=1`。
② 测试：`scripts/test-official-locale-gate.mjs`（10-30）；`audit/apply/plan-official-en-coverage` 三件套在册。
③ 部署：lib/pack-locale-coverage.js 11-04 晚于镜像源——同上常规窗口。
④ 痛感：pack-locale-coverage.js 2 提交 0 fix。
⑤ 陈旧度：spec 2026-11-04 vs 代码 2026-11-04——零剪刀差。

## official-pack-showcase — A
名单判定/匿名读/登录墙前三段全落 facet+web。
① 对齐：`facet/marketplace-json.js:55-94`（roster 判定 official、adopted provenance 同投影 ：71-94）；`facet/index.js:168,223-229`（OFFICIAL_AUTHOR_EMAILS 注入 registerMarketplaceJson）；web 过滤器 `web/src/components/packs/PackMarketView.tsx:138-147`（URL 持久 official=1）。
② 测试：`scripts/test-official-showcase.mjs`（11-03）、e2e `official-showcase.spec.js`（11-03）、`test-facet-marketplace-json.mjs`。
③ 部署：facet `sha-a96731b`（marketplace-json 10-31 已在内）。
④ 痛感：facet/ 全目录 70 提交 16 fix（23%，全簇偏高——市场读面是活跃修复区，watch）。
⑤ 陈旧度：spec 2026-11-01 vs 代码 2026-10-31——不 stale。

## official-starter-agents-content — A
persona 结构化门+skills/mcp 桶如实门有基线测试。
① 对齐：`scripts/test-starter-content-baseline.mjs:51-56`（persona ≥380 字、【职责边界】【输出契约】槽位逐字）；桶门同文件（空桶/不在册工具拒绝）。
② 测试：同上（11-02）+`test-persona-*.mjs` 五件（compose-roots/evolution/park-lane/scope）。
③ 部署：内容数据随 platform 镜像；基线 11-02 晚于镜像源 2 天，常规窗口。
④ 痛感：未证实（内容为数据资产，fix 密度无意义）。
⑤ 陈旧度：spec 2026-11-04 vs 基线 2026-11-02——不 stale。

## official-starter-teams — A
序列呈现层+结构卡+同词表三需求全落。
① 对齐：`web/src/lib/packGuides.ts:50`（"Official starter teams (add-official-starter-teams)" STARTER_TEAMS）；卡片渲染 `web/src/components/packs/PackMarketView.tsx:450-455`（starter Badge+角色词表）。
② 测试：`scripts/test-official-starter-teams.mjs`（10-31，序列形状：5 支/preferred×1 :49）；e2e `starter-teams-sequence.spec.js`（11-04）。
③ 部署：platform `sha-a96731b`（packGuides 在内）。
④ 痛感：packGuides.ts/PackMarketView 近期 0 fix 主导。
⑤ 陈旧度：spec 2026-10-30 vs 代码 10 月底——不 stale。

## web-chat-server — B
会话主链实现厚实，但**验证面显著老化 + fix 密度全簇最高**。
① 对齐：`server/agent-session.js:1-3`（dsh agent session：prompt dispatch/models/agents/skills/cron/sessions，1196 行）；WS 收发 `server/ws.js:129-130`（busy/排队语义）；model/agent 切换 `server.js:514`。
② 测试：`scripts/test-ws-reconnect.mjs`（**09-18**）；e2e `chat-turn.spec.js`（**08-28**）、`chat-history.spec.js`（**07-22**）——均早于 spec 末次更新（10-28）40-98 天；chat-history 三个 mjs 测试 10-14 尚新。
③ 部署：platform `sha-a96731b`（agent-session 11-06 改动是镜像源之后 1 提交——`39d95cce` 为测试隔离非产品码，实际零滞后）。
④ 痛感：agent-session.js since 9/5 共 31 提交 **13 fix（42%，全簇最高）**；ws.js 24 提交 6 fix。
⑤ 陈旧度：spec 2026-10-28 vs agent-session.js 2026-11-06——不 stale；扣分在②的 e2e 老化。

## web-chat-ui — B
会话视图/工具状态/流式输入/WS 生命周期实现齐，e2e 同样老化。
① 对齐：`web/src/pages/ChatPage.tsx`（会话主页面，最近 10-24）；WS 生命周期 `web/src/hooks/useWebSocket.ts`。
② 测试：e2e `chat-layout.spec.js`（**08-29**）、`chat-polish.spec.js`（**09-08**）、`chat-outline/chat-deeplink/chat-chart-rendering` 等在册——核心交互件早于 spec（10-28）50-90 天。
③ 部署：随 platform 镜像（web 构建产物）。
④ 痛感：ChatPage.tsx 12 提交 1 fix（UI 修复面可控）。
⑤ 陈旧度：spec 2026-10-28 vs ChatPage 2026-10-24——不 stale；同②扣分。

## web-design-system — A
token 纪律+键盘契约+零硬编码文案门全齐且同日更新。
① 对齐：`web/src/styles/globals.css:4-12`（Tailwind v4 token，light-dark 对）；Tabs 键盘契约 `web/src/components/ui/tabs.tsx:28-30,45,55`（ArrowLeft/Right/Home/End+role="tab"）；零硬编码文案门 `scripts/design-lint.mjs`+基线 `design-lint-baseline.json`。
② 测试：`scripts/test-design-lint.mjs`（11-02，lint 测试 11-03 亦有更新）。
③ 部署：随 platform 镜像。
④ 痛感：globals.css 5 提交 1 fix；design-lint 0 fix。
⑤ 陈旧度：spec 2026-11-02 vs 代码 2026-11-02——零剪刀差。

## web-list-surfaces — A
首帧空态纪律+客户端缓存+记住选择三点全落且测试新鲜。
① 对齐：`web/src/hooks/useListCache.ts`+`web/src/lib/listCache.ts`（列表缓存/失效）；骨架态 `web/src/components/ui/states-kit.tsx`（SkeletonList/ErrorState，被 BotsPage:13、AppCenterPage:30 等消费）。
② 测试：`scripts/test-list-cache.mjs`（**11-02**）；e2e `app-center-load-recovery.spec.js`（11-02，首帧恢复场景）。
③ 部署：随 platform 镜像（useListCache 11-02 晚于镜像源 1 天，常规窗口）。
④ 痛感：listCache.ts 1 提交 1 fix（10-28 修缓存一致性）。
⑤ 陈旧度：spec 2026-10-28 vs 代码 2026-11-02——不 stale。

## web-operate-states — B
三态/危险确认/双通道反馈实现齐，但**确认对话框与 states-kit 无专项测试**。
① 对齐：`web/src/components/ui/confirm-dialog.tsx:17,29,59`（danger→destructive variant，"paints the confirm button with the destructive"）；消费面 ResourcesPage/ZhiyuRoomPage/DocumentsPage/AgentStudioPage/CustomPresetsPage 五页；三态 states-kit（同上）。
② 测试：无 confirm-dialog/states-kit 专用单测（未证实）；覆盖靠 `scripts/test-design-lint.mjs`（11-03）+ e2e `app-center-load-recovery.spec.js`（11-02，懒载/缓存失败不清屏）散点。
③ 部署：随 platform 镜像。
④ 痛感：confirm-dialog.tsx 1 提交 0 fix。
⑤ 陈旧度：spec 2026-11-02 vs confirm-dialog 2026-11-02——零剪刀差；扣分在②。

## web-search — A
归一化工具+本地阅读+SSRF 边界全实现，测试覆盖在册。
① 对齐：`server/websearch-mcp.js:68`（工具描述：截断+私网拒绝语义）；`server/web-fetch.js:25`（"Block loopback, private, link-local, .local hosts to prevent SSRF"）、:73（refuse 抛错）。
② 测试：`scripts/test-websearch-settings.mjs`（10-13）；e2e `websearch.spec.js`（09-26，早于 spec 末次更新 10-22 共 26 天——30 天线内）。
③ 部署：platform `sha-a96731b`；上游旁路容器 `search-relay.yaml:32` 为公共 node:25 基底（无 paas 码）。
④ 痛感：websearch-mcp.js 2 提交 0 fix；web-fetch.js 1 提交 0 fix。
⑤ 陈旧度：spec 2026-10-22 vs 代码 2026-10-13——9 天，不 stale。

## web-shell-resilience — A
壳新鲜/渲染降级/chunk 自愈三点实现+e2e 同日。
① 对齐：`web/src/main.tsx:7,38-42`（ShellErrorBoundary 包根）；`web/src/App.tsx:300-302,376`（"route-level crash or a stale-shell chunk failure degrades"，路由级懒加载+边界）；`web/src/components/ShellErrorBoundary.tsx`。
② 测试：e2e `shell-resilience.spec.js`（**11-02**，与 spec 同日）。
③ 部署：随 platform 镜像（壳/哈希资产策略在 vite 构建内）。
④ 痛感：ShellErrorBoundary/App.tsx 近期 1 提交 0 fix。
⑤ 陈旧度：spec 2026-11-02 vs 代码 2026-11-02——零剪刀差。

---

## 簇摘要

**三件最严重的事**：
1. **旗舰聊天面验证面老化（web-chat-server + web-chat-ui，双 B）**：spec 于 10-28 重写，但核心 e2e 停在 7-8 月（`e2e/chat-history.spec.js` 07-22、`chat-turn.spec.js` 08-28、`chat-layout.spec.js` 08-29，落后 spec 60-98 天），叠加 `server/agent-session.js` fix 密度 13/31（42%）全簇最高——最热的代码配最旧的回归网。
2. **desktop-supervisor 测试件滞后 45 天**：spec 10-28 扩到 359 行（全簇最大），行为锚点齐（supervisor/lifecycle.js、health.js），但唯一端口/健康专用测试 `scripts/test-supervisor-ports.mjs` 停在 09-13；supervisor/ fix 密度 6/18（33%）说明改动活跃、回归网没跟上。
3. **web-operate-states 危险确认无专项测试**：`confirm-dialog.tsx` danger variant（11-02 刚随 spec 加严）+ states-kit 三态原语被五页消费，却无任何专用单测/e2e（未证实有），仅 design-lint 与散点 e2e 兜底。

**评级分布**：A×16 · B×4 · C×0 · D×0（20 模块；B = desktop-supervisor / web-chat-server / web-chat-ui / web-operate-states）。全簇无 stale spec（⑤剪刀差均 <30 天）；部署面产品代码零滞后（落后 3 提交全为 docs/test，逐一核对）；watch 项：facet/ 修复密度 23% 为市场读面活跃区。
