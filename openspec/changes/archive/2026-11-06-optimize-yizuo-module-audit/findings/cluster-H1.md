# Cluster H1 审计报告（长尾前半，49 条）

审计日期：2026-11-06 ｜ 方式：快筛（读 spec → grep 实现锚点 → 五项检查）｜ 评级分布：A×18 / A-×21 / B×8 / C×1 / D×1

## 一、49 条判定总表

| # | Spec | 评级 | 一句话 | 证据 |
|---|------|------|--------|------|
| 1 | action-gate | A | 16 条 reqs 与注册表/执行器/preflight/过期实现逐条对得上，风险分档与 stdio 执行器齐备 | `lib/action-registry.js`、`lib/action-executor.js`、`lib/action-preflight.js`、`lib/action-expiry.js`、`server/actions-mcp.js`、`server/routes/actions.js` |
| 2 | app-navigation | A- | 主体对齐，但 Purpose 行仍写「including the Bots entry」与自身 reqs 矛盾（Bots 已降 Settings），且规范 tab 集漏了代码里 web 可见的 `fleets`（智语）nav 面 | 矛盾：spec.md:275 vs :281；代码 `packages/core/src/lib/surfaces.ts:53`（`fleets` web nav）与 `:63`（`fleet` desktop-only） |
| 3 | artifact-contract | A- | 产物契约文本确实注入每个 persona 的 system message（echarts 围栏/相对路径/禁 data: URI）；「同回合调 library save 工具」条款未在注入文本中 sighted | `server/agent-session.js`（平台产物契约注入段） |
| 4 | blueprint-trial-bounded-fire | A- | 单 req 小册；fireRound 与试跑锁实现在场，超时竞速窗未逐行 sighted 但注释语义一致 | `server/blueprint-trial.js:213,246` |
| 5 | bot-relay | A | 实现与 spec 近乎逐条对应：constant-time token、无 token 即 404 inert、先鉴权后解析、429/长度/禁内容落日志 | `server/routes/bot-relay.js:1-90` |
| 6 | browser-use | A | 三形态 supply gate（local/remote/absent）与 bundled lock 实现及专测俱在 | `server/browser-mcp.js`、`scripts/test-browser-lane-gate.mjs` |
| 7 | builder-team-templates | A- | 蓝图构造师三工具与 pack 草稿链在场；四员官方种子与 locale 门的齐套性未逐包 sighted | `server/blueprint-author-mcp.js`、`lib/pack-locale-coverage.js` |
| 8 | bundle-manifest | A | `platform.bundle.json` 在仓根，server/scripts 均消费 | `platform.bundle.json`、`server/websearch-mcp.js` |
| 9 | caller-preferences | **C** | **能力悬空**：偏好读写面（回调 URL/签名密钥/收割窗）在 paas 仓内零实现锚点——server/ gateway/ lib/ services/ agent-runner/ 全无 callback/harvest-window 代码；仅 context_id 直通语义在 A2A 客户端侧在场 | `gateway/wanxing/a2a.js:25-31`（caller-supplied context_id passthrough）；门面实现在外部 sub2api fork，本仓无归属说明 |
| 10 | chart-data-binding | A | binding CRUD + candidates + 每工具 replay allowlist（数据形态、非前缀匹配）齐备 | `chart-bindings.js:35`、`chart-replay-allowlist.json`、`server/routes/resources.js:141-183` |
| 11 | chart-observation-history | A | 五分类（appended/revised/resourced/unchanged/missing）与 resourced-先于-revised 的 spec 区分在实现注释中逐字落地；as-of 重建在场 | `chart-refresh.js:74-85`、`lnOption(row, atIso)`、`server/routes/resources.js`（timeline/as-of 路由） |
| 12 | ci-pipeline | A | 六门顺序、Node 25、ubuntu-only、PLATFORM_SKIP 与 chromium 安装与 ci.yml 一致；app/miniapp 门禁工作流在场 | `.github/workflows/ci.yml:20-137`、`app-build.yml`、`miniapp-ci.yml`、`app-e2e.yml` |
| 13 | ciyuan-account | A- | 绑定/测试/断开三路由与按身份只写凭据库、connection-center 投影齐备；铸造链在外部词元侧不可验 | `server/routes/ciyuan-account.js:122-254`、`ciyuan-account-credentials.js`、`server/routes/misc.js:700-702` |
| 14 | ciyuan-embedding-lane | B | 外部 fork 契约 spec，内部自洽（维度拒收/无价 fail-closed/provider 钉扎互相引用正确）；本仓无 embeddings 消费锚点可对拍 | 全文内部一致 |
| 15 | ciyuan-fork-lineage | B | 纯治理流程 spec（tag 编码/月度窗/缝点/降级），内部一致；台账在外部仓不可验 | 全文内部一致 |
| 16 | ciyuan-gateway-identity | B | 外部网关登录闭环 spec；白名单派生回调与 discovery 跳过语义内部自洽 | 全文内部一致 |
| 17 | ciyuan-gateway-lanes | B | 外部车道契约 spec；跨协议上游/失败分级/BYOK 三态标注自洽，且对错误体 engine 的「已知边界」如实登记（好范例）；卫生：TTS scenario「调者」漏字 | spec.md TTS scenario |
| 18 | ciyuan-partner-intro | B | 介绍材料口径受控 spec，内部一致；材料本体在外部交付链不可验 | 全文内部一致 |
| 19 | ciyuan-product-surface | B | 仓内单一事实源确实存在（含改版前基线副本），灌入/回滚场景可支撑；其余为外部面板行为 | `docs/ciyuan/home-content.html` + 基线副本 |
| 20 | ciyuan-trial-account | B | 试用账号供给 spec；硬顶语义沿既有口径自洽；凭据交付材料在运维台账侧不可验 | 全文内部一致 |
| 21 | connection-center | A | `/api/connections` 聚合端点在场且 id 集含 `ciyuan-account`、`facet-market`，退役 `line-wanxing-caller` 已替换；chatwoot 面板组件在场 | `server/routes/misc.js:668,684,700-702`、`web/src/components/extensions/ChatwootConnectPanel.tsx` |
| 22 | crm-desk-bridge | A- | 接待技能稿在场、chatwoot 凭据路由在场、`crm.message.send` 与 action-gate 互相引用一致；fork 专属工具剔除未逐名 sighted | `skills/crm-desk-reception/SKILL.md`、`server/routes/chatwoot-credentials.js` |
| 23 | crm-desk-embed | A- | desk-embed SSO 路由在场；permissibles/懒映射细节未逐行 sighted | `server/routes/desk-embed.js` |
| 24 | crm-desk-pack | A- | pack 组装 lib 在场；BYOK 清除不回落共享凭据的分支未 sighted（与 action-gate preflight 语义互证） | `lib/crm-desk-pack.js`、`scripts/test-crm-desk-pack-embed.mjs` |
| 25 | custom-presets | A | `mcpTools` 校验/收窄、`user.` 前缀、发布闸读取 per-role 名单全部在场 | `server/routes/custom-presets.js:111-121`、`lib/publish-tool-gate.js`、`server.js:433` |
| 26 | dependency-security | B | 流程 spec 内部一致（manifest 归属/override/豁免/越界登记四场景闭环）；轮次台账本仓不可验 | 全文内部一致 |
| 27 | deployment-branding | A | `PUT /api/config/branding`、loginHero 结构校验、e2e branding.spec 在场 | `server/routes/misc.js:460`、`e2e/branding.spec.js` |
| 28 | device-pairing-auth | A- | pair/challenge/login 三门在 gateway 与单进程形态双实现，Ed25519 挑战与 facet 侧 pairing 在场；steward 双门授权细节属 cell-lifecycle 未深查 | `gateway/index.js:406`、`gateway/app-auth.js:143`、`server/routes/app.js:28`、`facet/pairing.js` |
| 29 | doc-studio | A- | 功能集 README（pack id `fd-doc-studio`、单技能 v1）在场；执行层随镜像与 postcheck 未逐项 sighted | `docs/vertical-packs/skills/doc-studio/README.md` |
| 30 | document-collections | A | 「用它造 agent」deep-link 到蓝图工坊、Save/Start conversation 与 locale 文案全部在场 | `web/src/pages/DocumentsPage.tsx`、`web/src/locales/zh-CN/common.json:557-558` |
| 31 | document-library-tools | A- | in-process library MCP server 与四工具在场；guest lane 不挂载未逐路 sighted | `server/library-mcp.js`、`server/library-fetch.js`、`server/skills.js` |
| 32 | document-management | A- | documents 路由与 throwaway store env 在场；重启 re-extract 分支未逐行 sighted | `server/routes/documents.js`、`playwright.config.js:35` |
| 33 | document-management-ui | A | `/knowledge` 路由 + `/documents` 重定向 + DocumentsPage 与 e2e nav-knowledge 断言一致，无 Q&A 面 | `web/src/pages/DocumentsPage.tsx`、`e2e/app.spec.js:26` |
| 34 | document-search-index | A- | chunk/FTS 检索与 library 工具同源实现；backfill 幂等未逐行 sighted | `server/routes/documents.js`、`server/library-mcp.js` |
| 35 | drag-drop-upload | A- | Composer 拖拽/粘贴链路在场（attachment-preview e2e 佐证）；415 服务端分支未 sighted | `web/src/components/Composer.tsx`、`e2e/attachment-preview.spec.js` |
| 36 | dynamic-cluster-composer | A | 集群路由含 lastUsedAt/totalExecutions 跟踪与 `cluster_expiring` 广播，Web 三页在场 | `server/routes/clusters.js:130,200,444`、`web/src/pages/AgentsPage.tsx`、`ChatPage.tsx` |
| 37 | e2e-testing | **D** | **spec 与其描述的测试套自相矛盾**：app-shell 条款断言侧栏为「Chat, Knowledge, Agents, Bots, Trace」，而真实 e2e 断言恰相反（nav-bots/nav-trace 必须不存在、出现 nav-resources/nav-tasks）；RAG 条款要求覆盖「Ask the collection」输入框，该 Q&A 面已按 document-management-ui 删除——照 spec 重写会做错 | 矛盾点：spec.md「app shell navigation」「document chat (RAG)」两条 vs `e2e/app.spec.js:24-31`、`playwright.config.js` |
| 38 | ecosystem-access | A- | registry 投影（server.json schema 2025-12-11）、publish-gate 拒绝凭证形状、专测在场 | `facet/mcp-registry-json.js`、`facet/publish-gate.js`、`scripts/publish-mcp-registry.mjs` |
| 39 | ecosystem-curation | A- | curation/provenance/vendor 三面组件在场；三 provenance 标记的渲染未逐面 sighted | `facet/publish-gate.js`、`lib/curated-sources.js`、`lib/pack-provenance.js`、`gateway/vendor-onboarding.js` |
| 40 | file-persistence | A | 共享持久层逐条在场：temp+rename+fsync、原子 JSON/文本写、目录 fsync | `lib/persistence.js:6-84` |
| 41 | file-preview | A- | files 路由与 attachment-preview e2e 在场；produced-files 的 shell 命令分段/引号/heredoc 规则未逐条 sighted | `server/routes/files.js`、`e2e/attachment-preview.spec.js` |
| 42 | first-run-bootstrap | A | Electron main 在 supervisor 前调 `runFirstRun`（bootstrap/first-run.js） | `electron/main.js:20,145` |
| 43 | focus-overlay | A- | overlay 语义在 agent-session（重启即交付）与 custom-presets 路由（存储 diff）双重在场 | `server/agent-session.js:513,914`、`server/routes/custom-presets.js` |
| 44 | foldable-observation-shortcut | A | e2e 以 `Control+O` 实测 toggle 行为 | `e2e/thinking-blocks.spec.js:203-259` |
| 45 | forward-auth | A | X-Forwarded-* 三模式（none/forward_auth/logto）、hosted-cell gateway secret、可选 SSO 语义与 auth.js 实现一致 | `server/auth.js:2` 起 |
| 46 | installer-distribution | A- | release-sync、packaged-tree 不动点、dsh-matrix 校验、预置 bundle 烘焙各组件在场；池通道/快照 manifest 在外部仓不可验 | `scripts/release-sync.mjs`、`scripts/lib/packaged-tree.mjs`、`lib/dsh-matrix-verify.js` |
| 47 | intent-onboarding | A- | onboarding 服务/路由/前端组件三件套在场；recipe-ready 三角色清单未逐项 sighted | `server/onboarding.js`、`server/routes/onboarding.js`、`web/src/components/IntentOnboarding.tsx` |
| 48 | internationalization | A | 五 locale（en/zh-CN/es/fr/ja）、en 兜底、`check:locales` 门、locale 目录齐备 | `web/src/i18n/config.ts:8`、`package.json:23` |
| 49 | layout-configuration | A- | 统一注册表/三层解析/部署隐藏终局在 server/gateway/web 三侧实现；spec 的 nav slug 枚举漏了 `fleets`（智语）等在场面 | `packages/core/src/lib/surfaces.ts:41-95`、`server/layout.js`、`gateway/layout.js`、`web/src/components/settings/LayoutSection.tsx` |

## 二、C/D 展开与 ciyuan 家族合并勘察

### D — e2e-testing（唯一 D）
- **矛盾 1（app-shell）**：spec 要求套件验证侧栏为 `Chat, Knowledge, Agents, Bots, Trace` 且「demoted configuration entries absent」；但真实套件 `e2e/app.spec.js:24-31` 断言 `nav-chat/nav-knowledge/nav-resources/nav-agents/nav-tasks` 存在、`nav-mcp/nav-skills/nav-models/nav-bots/nav-trace` **不存在**。spec 描述的是 simplify-chat-and-agents-ia 之前的旧 tab 集。
- **矛盾 2（RAG flow）**：spec 要求 `@smoke` 覆盖「Ask the collection」输入框问答；document-management-ui 与 app-navigation 均规定 Documents 页「SHALL NOT present a question/answer interface」，且 `web/src/pages/DocumentsPage.tsx` 无 QuerySection、`e2e/` 无对应测试。功能已删，spec 未同步。
- 其余条款与 `playwright.config.js`、`e2e/helpers.js:211` 一致——spec 大体健康，但两条 stale 条款会误导任何「按 spec 重写/补测」的人做反向工作。**修法：删除/改写 app-shell 与 RAG 两条即可升 B+。**

### C — caller-preferences
- spec 规定「平台 SHALL 提供调用者偏好的读写面」，但 paas 仓内零命中实现；仓内仅 `gateway/wanxing/a2a.js:25-31` 的 context_id 直通符合其第三个 req 的一半。门面实体是外部 sub2api fork，spec 无任何归属声明或跨仓指针。**能力在本仓悬空。**修法：spec 标注实现归属，或补 in-repo 锚点。

### ciyuan-* 八条家族合并勘察
- **共性**：8 条中 7 条的实体在外部 sub2api 仓，本仓只承载 ciyuan-account 的卡面与凭据库、voice/search 转发（`server/routes/voice.js:43-46`）与首页内容源（`docs/ciyuan/`）。spec 族内部互引正确，无互相矛盾。
- **ciyuan-account（A-）**：本仓实现最实。
- **ciyuan-gateway-lanes（B）**：内容质量高，唯 TTS scenario「调者」漏字。
- **家族 P2 建议**：每条 spec 头部补一行「实现归属：sub2api fork 仓 + 对应路径」。

## 三、本簇 P0/P1/P2 候选

**P0（误导实现，先修）**
- `e2e-testing`：改写 app-shell 条款（改为现役 tab 集与「nav-bots/nav-trace 不存在」断言）并删除「Ask the collection」RAG 条款或改指 chat 内检索流。

**P1**
- `caller-preferences`：C 级悬空——补实现归属声明或落 in-repo 锚点。
- `app-navigation` / `layout-configuration` 枚举漂移：统一注册表已含 `fleets`（智语）与 `fleet`（desktop-only）两个面，两条 spec 的 tab 集枚举均只写后者；app-navigation Purpose 行残留「including the Bots entry」。建议两 spec 同步现役面清单（surfaces.ts 为单一真源）。

**P2**
- ciyuan 家族补「实现归属：外部 fork 仓」头部声明（8 条）。
- 卫生：ciyuan-gateway-lanes TTS「调者」漏字；artifact-contract 补验「同回合 library save 工具」条款。
- 快筛未逐行 sighted 的 A-/B 项可在深挖轮补验，均无误导风险。
