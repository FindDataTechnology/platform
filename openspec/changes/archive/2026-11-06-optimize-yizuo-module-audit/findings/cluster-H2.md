# 簇 H2 体检报告——长尾后半（49 条 spec）

仓：/Users/chengsishi/finddata/paas。方法：逐条读 spec → grep 定位实现锚点 → 五项检查 → 评级。三条已知信号全部核实：①mcp-auth-lanes 与 platform-memory-observability 的 Purpose 确为 TBD 占位（各自 spec.md:4）；②vertical-packs/spec.md:26 的 registry-groups.json 权威陈账确认（见展开节）；③ops-console 与 live-service-testing 按内部运维 spec 只查内部一致性（实现在 services/ops-console/ 与 playwright.config.js，均齐）。

## 一、判定总表（49 条）

| # | spec | 判定 | 一句话证据 |
|---|------|------|-----------|
| 1 | live-runtime-control | A- | 桥插件三 RPC+能力声明全在码（dsh-profile-template/platform-preset-bridge.js:18-91）、服务端、探针、e2e 齐；宿主侧降级分支未逐行核 |
| 2 | live-service-testing | A | 内部一致全对齐：playwright.config.js:30/82-93、package.json:19-20、Makefile:104-109、DEPLOY.md:1039-1082、live e2e 双 spec |
| 3 | llm-model-management | A- | server/routes/llm.js（CRUD、hasKey、default）+ server/llm-guard.js；后三条新增 req 仅锚点级确认 |
| 4 | local-agent-registry-feed | A- | server/local-agent-feed.js、gateway/packs.js 分页、agent-runner/registry.js 消费端同构；容量闸语义未逐行核 |
| 5 | local-services-launcher | A- | package.json:11 start→scripts/start.js（头注直指 local-services.js supervisor）；seeding 细节未逐行核 |
| 6 | marketplace-cluster-view | A- | PackMarketView.tsx+PackCard.tsx（agentCount 过滤）、PackDetailDialog.tsx:747-749；?agents= URL 参数未单验 |
| 7 | matter-threads | A- | agent-runner/matters.js:149-150（mt_ 标识）、routes/fleets.js；scope_key 访客边界未逐行核 |
| 8 | mcp-auth-lanes | **B** | 三车道能力表在 facet/cli/mcp-auth-capability.js、探针/测试/连接链齐；**Purpose TBD（spec.md:4）** |
| 9 | mcp-integration | A- | 全 req 有锚：mcp.json+DB 合并/requiredGroups、credentialRef 解析、探活、restart 交付控制器（含 2026-10-24 事故注记）、0600 patch |
| 10 | member-knowledge-profile | A- | server/knowledge-profile.js；簇 B 已深核（cell-memory.js:97-110、fleet-memory.js），不重复 |
| 11 | miniprogram-auth | A- | server/routes/mp.js：/api/mp/bindcode:26、/api/mp/login:50、login-bindcode:119；账号绑定共享数据集 |
| 12 | miniprogram-client | A- | miniapp/src/pages 齐全；15 条 req 契约细节做锚点级确认 |
| 13 | mission-control-bridge | A- | server/mc-bridge.js + 专测 + 挂载；MC_BRIDGE 默认关、幂等 claim 未逐行核 |
| 14 | mobile-app | A- | app/（expo 全家）+ server/routes/app.js + auth.js devicePairing+/api/app/pair |
| 15 | model-selection | A- | agent-session.js（list_models/set_model/effort）、llm-guard.js、ws.js 广播、default 指针、runtime-bindings |
| 16 | native-lexicon | A- | 五语种 locales 已改、site-plaza 品牌已更新；**Purpose 段仍以 v4 前词汇为现行**（正文已带 v4/v5 裁决）——陈旧小瑕 |
| 17 | offline-pack-supply | A- | offline-bundle.js、import-bundle 路由、export/bake 脚本 + 双专测齐 |
| 18 | onboarding-guidance | A- | OnboardingTour.tsx（三步+desktopOnly 第④步）+HelpDialog 三页签；措辞随 lexicon 演化非矛盾 |
| 19 | ops-console | A | 内部一致：services/ops-console/index.js 883 行——Logto org 门 fail-closed、Argo per-deployment 判定、relay stats、fleetBoard 源、快照 store；专测在册 |
| 20 | permission-mode-selection | A- | agent-session.js + dsh-events.js 广播；重启回落默认语义未逐行核 |
| 21 | persona-self-evolution | A- | persona-evolution.js、persona-eval.js（A/B 评测门）、routes、mcp——骨架齐 |
| 22 | platform-billing | A- | gateway/wanxing/core.js（caller key/余额闸/结算）、turn-pricing.js、line-credentials 路由、专测 |
| 23 | platform-memory-observability | **B** | **Purpose TBD（spec.md:4）**；但四 req 全有锚：三层读面 memory-face.js、准入闸 fail-open spawner.js:86-150、运维坞渲染 fleet-owner-api.ts+e2e、计量零侵入 proc-memory.js |
| 24 | preferences-ui | A- | electron/preferences/{window,ipc,preload,update-ipc,renderer/*} 全链在 |
| 25 | principal-facade | A- | facet/index.js、routes/delegation.js、routes/facet-market.js；与 matter-threads 互证 |
| 26 | project-identity | A- | package.json name=platform、启动日志；MCP clientInfo 两处未单独捕获（低风险） |
| 27 | project-workspace | A- | routes/misc.js:827 POST /api/projects（:862 GET、:868 PATCH）；单 req 直接命中 |
| 28 | release-pipeline | A- | release.yml + win-install-smoke.yml、build-node.js（ABI 同版）、verify-bundle.js；smoke 断言细节未逐行核 |
| 29 | resource-library | A- | resources.js（:502 canonical fence 捕获）、routes/resources.js（tier/tags 过滤、手势写面、save 落 reference 页） |
| 30 | resource-library-ui | A- | ResourcesPage.tsx、TurnArtifactStrip.tsx、AssistantTurn.tsx、useResourceStatus.ts |
| 31 | role-system | A- | server/roles.js（枚举/主角色/admin 面）+ LayoutSection.tsx |
| 32 | scheduling-cluster-aware | A- | cron.js:91-94 策略闸、:472 cluster 绑定、cron-runner.js:936+ fan-out/聚合 |
| 33 | settings-surface | A- | SettingsDialog.tsx + sections.ts（status 等全部分区）+ App.tsx 路由 |
| 34 | sidebar-nav-families | A- | Sidebar.tsx（families 折叠组） |
| 35 | sidebar-workspaces | A- | Sidebar.tsx + useProjectsStore.ts + /api/projects 复用 + locales 默认项目 |
| 36 | social-bot-channels | A- | routes/bots.js（WEBHOOK_PREFIX、forward-auth 豁免注记、qrSvg）+ server/bots/{bots,wecom-bot,feishu,bot-relay}.js；问询卡两条新 req 未逐行核 |
| 37 | studio-ai-drafting | A- | routes/studio-draft.js + AiDraftOverlay.tsx + 专测 |
| 38 | system-status-dashboard | A- | sections.ts:244-247 status 分区 + /api/supervisor/status |
| 39 | test-process-hygiene | A- | test-server.mjs 共享组属主 helper + 自检 |
| 40 | theming | A- | useTheme.ts + globals.css 语义 token + EChart.tsx 跟随 |
| 41 | tool-description-enrichment | A- | routes/overlay.js + agent-session.js + market-annotations.js + extensions 通道 |
| 42 | tool-discovery | A- | server/tool-discovery.js + dsh-events.js（roster 搜索/纠错候选） |
| 43 | tool-use-rendering | A- | ToolBlock.tsx + AssistantTurn.tsx + chat-store/ws types（tool_start/tool_end 契约） |
| 44 | user-runtime-bindings | A- | runtime-bindings.js + user-bindings 路由 + ws.js 身份感知 + agent-session 应用路径 |
| 45 | vertical-packs | **C** | spec.md:26 仍以 registry-groups.json 为组闸权威；代码已改 carried metadata 优先（registry-bridge.js:95）——陈账确认，见展开节 |
| 46 | virtual-mcp-servers | **B** | 跨仓 spec（registry fork）；本仓无实现域可证、spec 无归属注记 |
| 47 | voice-lane | A- | routes/voice.js + routes/misc.js（固定协议转发/voice 配置块） |
| 48 | wanxing-facade | A- | gateway/wanxing/{core,a2a,store}.js（a2a.js:268 Idempotency 三态、store.js 幂等窗+结算键）、卡片 redact |
| 49 | workspace-selection | A- | agent-session.js:63-77（AGENT_WORKSPACE pin > persisted > cwd，pin 拒绝记录）、server.js:677、ws.js workspace_changed |

分布：A×1、A-×44、B×3、C×1、D×0。唯一 C 是陈账型归属错位（能力仍在，权威指针陈旧）。

## 二、C 级展开节

### vertical-packs —— C（组闸权威指针陈旧，误导实现归属）

**spec 说什么**：spec.md:26（Requirement「Pack composition model」的 Scenario: Wrong-role user sees none of the pack）写：「the pack's gated entries (**per `registry-groups.json`**) are invisible to that user」——把 registry-groups.json 表述为组闸权威。

**代码现状**：registry-bridge.js 头注（:20）与加载逻辑（:95「Carried registry metadata wins over the hand-mapped registry-groups.json」）明示：随包携带的 registry 元数据是权威，registry-groups.json 已降级为无携带时的兜底。这正是 carry-registry-visibility-through-bridge（2026-11-06 归档，finddata 根 openspec）的语义。

**为何是 C 不是 B/D**：组闸行为本身存在且兜底仍可拒（非能力悬空）；但 spec 把权威归属指向已降级的一方——按 spec 操作的人会去维护 registry-groups.json 而不动 carried metadata，正是「归属错位」定义。

**修复**：spec.md:26 场景改写为「per the carried registry visibility metadata（registry-groups.json 仅作无携带时的兜底）」；Purpose 或头注加一行指向 registry-bridge.js 的权威序。

## 三、B 级简注

- **mcp-auth-lanes**：需求本体有落点；唯一债是 Purpose 仍为归档占位 TBD（spec.md:4）。
- **platform-memory-observability**：四条 req 实现闭环完整；唯一债同为 TBD Purpose。渲染端在 fleet owner 面而非 ops-console——「运维坞」对应关系建议在 Purpose 里说破。
- **virtual-mcp-servers**：registry fork 的虚拟 MCP scope 门在本仓无代码可证；spec 无「本 spec 实现域在 registry 仓」注记。

## 四、本簇 P0/P1/P2 候选

**P0**：无。

**P1**：
1. **vertical-packs/spec.md:26 权威陈账**（本簇唯一 C）：一处场景措辞改写即可消除「误导实现归属」。

**P2**：
1. **mcp-auth-lanes Purpose TBD**（spec.md:4）：补 3-4 行 Purpose（三车道 + 能力表 + 证据纪律）。
2. **platform-memory-observability Purpose TBD**（spec.md:4）：补 Purpose 并注明渲染端对应关系。
3. **native-lexicon Purpose 陈旧**：改写 Purpose 或加一行「词汇以 v4/v5 裁决为准」。
4. **virtual-mcp-servers 归属注记**：spec 头部加代码域注记（实现域在 registry 仓）。

---

**协调方注**：carry-registry-visibility-through-bridge 归档在 finddata 根 openspec（2026-11-06），非本仓——本报告§二的推测已由协调方确认修正。
