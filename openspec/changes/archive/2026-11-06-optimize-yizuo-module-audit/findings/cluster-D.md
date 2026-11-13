# 簇 D 审计 findings——pack·供给·registry·凭据·计费（43 spec）

- 日期：2026-11-06；仓：/Users/chengsishi/finddata/paas（branch `release/cell-session-persona`，HEAD 8fae027c）
- 方法：五项检查（spec-代码对齐 / 内容正确性 / 接口契约 / 可靠性 / 卫生）。逐条 Purpose+Requirements 提取后按族核对代码锚点；对 B 级嫌疑深挖。registry-* 等 5 条跨仓（finddata 根 / registry fork）spec 按约定只做文件间一致性核对，不对生产。
- 在途 change 处理：add-supply-store-unification 与 add-supply-studio-migration 的 specs delta 不计漂移；但其 tasks.md 声称「已完成」的任务逐条对代码核实（见 P0）。

## 一、判定总表（43 条）

| # | spec | 判定 | 一句话证据 |
|---|------|------|-----------|
| 1 | agent-builder-hub | A- | /agents 四区+旧区重定向在（web/src/App.tsx:321,405-415；web/src/pages/AgentsPage.tsx:1,255,300）；注意 studio-migration 4.2 计划解体该面，在途不计漂移 |
| 2 | agent-builder-workspace | A- | 三栏组件齐全（AgentStudioPage.tsx:32-36）；深链 ?doc=/?fork=/?new= 全处理（AgentStudioPage.tsx:313-316） |
| 3 | agent-materials-plaza | A- | site-plaza 静态站+机器面在；generated/counts.json 与在途单基线逐项相等（pack 82 / skill 265 / mcp 22 / facade 22 / official-data 473 = 864） |
| 4 | auth | A | server/auth.js（446 行）forward-auth + GATEWAY_SECRET_HEADER 契约在 |
| 5 | connector-credentials | A | connector-credentials.js + server/routes/connector.js:136-163（connection/credential，只写不读姿态） |
| 6 | credential-file-format | A | dsh-profile.js:325-411 单行引号标量纪律落地（2026-10-12 PAT 泄漏注记、raw 文本校验、js-yaml 折叠防护） |
| 7 | extension-management-ui | A- | ExtensionsPage.tsx:3 明确挂 /settings/mcp+/settings/skills；Installed/Market 双视图（:109-117） |
| 8 | extension-marketplace | A- | market-catalog.json+market-catalog-skills.json 内置；requiresConfig 在 extension-store.js/McpMarketCard.tsx；分组准入服务端强制（server/routes/extensions.js:115-127） |
| 9 | extension-runtime-management | A | origin/locked/requiredGroups/热载全在（extensions.js:115-127,181-182,190-193,216-217）；personal overlay 经 reapplyProfile |
| 10 | facet-editor-cli | **B** | Purpose「v1 不写 MCP 配置」与 Requirement(38+)三车道写入模型矛盾——Purpose 未随能力修订更新（展开节） |
| 11 | facet-market-credentials | A | facet-market-credentials.js + routes/facet-market.js:47-55（pair/静默续登/Ed25519 服务端持有，镜像 connector 姿态） |
| 12 | facet-platform | A- | 24 条 Requirement 的面全部有落点：facet/web/src IntroView/DocsView/CurateView/MineView/McpCatalog/LineLadder/SiteMark/PageFooter；catalog+vendor lane（facet/index.js:32,119,173,239） |
| 13 | line-boards | A | routes/boards.js:1-38 + lib/board-adapters.js + LINE_BOARDS_ENABLED 门 + copilot dock 不跑 adapter |
| 14 | line-credentials | A- | mint/start+callback（PKCE）+paste 三端点在（routes/line-credentials.js:99-271）；小瑕：Purpose 仍写「三 ref」，实际四（wanxing-deployer 已入 Set，:24） |
| 15 | logto-auth | A | logto-auth.js:22-23,128-135,159 AUTH_MODE=logto/confidential 校验/slideCookie/PKCE |
| 16 | market-revenue-share | A | gateway/market.js:1-136 与五条 Requirement 逐条对应（append-only 成交记+幂等两键+sub2api 结算+refund 方向+30% ADR-0022 快照） |
| 17 | model-surface-budget | **B** | Requirement 与代码逐字对齐（server/model-budget.js:2 三级 single/daily/monthly、budget_exhausted_log:138、懒滚动），但 Purpose 是 TBD 占位（spec.md:4）且 spec 目录未提交（展开节） |
| 18 | pack-agent-scoping | A | 焦点态改写 server/agent-session.js:906；全模式收窄 lib/full-mode-tool-scope.js:28（交集+override）；per-server 上界 lib/operator-tool-face.js |
| 19 | pack-authoring | A | pack-author.js 回环 lane 复用同一 validatePackManifest；.yizpack 导出/反向导入（server/routes/packs.js:96-131）；发布工具面闸 lib/publish-tool-gate.js:1-15 |
| 20 | pack-bot-units | A | lib/generic-bot-types.js:1-23（只引用通用类型、双侧同拒、materialization 在 server/bots.js） |
| 21 | pack-category-line-mapping | A | lib/pack-category-lines.js:1-25 与 spec 逐条一致（零迁移/badge=facade 承担 company+facade/env 覆盖回落内置） |
| 22 | pack-display-format | A | lib/pack-manifest.js:881-893 promise 宽度帽+CJK 计 2+en 副轨扫描；不写则逐字节不变 |
| 23 | pack-domain-taxonomy | A | lib/pack-taxonomy.js:13,139-156 受控词表+部署侧 env 覆盖+非法回落；packs 表 domains 列（gateway/packs.js:264-270） |
| 24 | pack-installation | A- | subscribe/upgrade/uninstall + 服务端 manifest 解析（server/routes/packs.js:5-9 头注）+ 快照/冲突/卸载语义 |
| 25 | pack-locale-tracks | A | lib/pack-locale.js + LOCALE_OVERLAY_KEYS（lib/pack-manifest.js:519）；zh 唯一回落 |
| 26 | pack-marketplace | A- | gateway/packs.js 路由面密集对齐：publish:1623/validate-only:1677/facets:1762/curation:1793/visibility:1835/versions/files/deploy:2734/billing:2743+；files 闸:198-200；sellability 闸:229 |
| 27 | pack-usage-telemetry | A | server/usage-telemetry.js:18,39,54（180d 保留、逐回合一行）；ops 门 fail-closed（routes/pack-usage.js:14-22 无 token 503） |
| 28 | pack-visibility | A | 默认 public（gateway/packs.js:248,254）；private 全域 owner-scoped（:588,674-680）；发布字段（:705） |
| 29 | paper-trading-credentials | A | paper-trading-credentials.js + routes/paper-trading.js:99-109（advisory probe/stale 翻转/只存服务端） |
| 30 | registry-console-i18n | A- | 跨仓（registry fork），本仓零耦合、文件间自洽；未对生产（按任务约定） |
| 31 | registry-credentials | A | registry-credentials.js:58-74（silent SSO/staleness=不可注入但仍标识 re-connect）+ routes/registry.js:54-64 |
| 32 | registry-lineage | A- | 跨仓；fd-1.0.0 谱系声明与 per-user key/额度预检在本仓无反证；未对生产 |
| 33 | registry-market-deployment | A- | env 契约与 registry-bridge.js:28-33 精确对齐（MARKET_REGISTRY_URL‖REGISTRY_URL+MARKET_REGISTRY_TOKEN） |
| 34 | registry-product-home | A- | 跨仓；内部自洽；未对生产 |
| 35 | registry-quota-gate | A- | 跨仓；本仓（registry-bridge/mp-bindings/facet-proxy）零 quota 耦合，与「门住 registry 预检层」的管辖域声明一致；未对生产 |
| 36 | scoped-relay-credentials | A | services/search-relay/scoped-token.js 单实现双运行时 + lib/scoped-relay-token.js:1-27（wsrc-<scope>-<mac> 派生、单 cell 吊销、稳定 scope id） |
| 37 | skill-content-propagation | A- | 跨仓（registry 更新 API）；谦面侧读面 /api/skills-catalog/:name/content（facet/mcp-catalog.js:173-190）与版本一致语义相容 |
| 38 | skill-invocation | A | /skill: 解析（server/skills.js:23,103）+ list_skills（server/ws.js:926）+ skill_use 广播（:517-519）+ 物化热载 |
| 39 | skill-self-evolution | A | 候选永不直接生效+supersedes 必指真实技能（server/skill-evolution.js:8-9,67-70）；A/B 门三臂（server/skill-eval.js:1-13,85-88） |
| 40 | supply-annotation-overlay | A | 四源合并落地为两处合并点：registry-bridge.js:289,396（registry metadata>仓库 market-annotations.json）→ extension-store 再并内置 catalog 注释 → 上游原文兜底；lib/supply-annotations.js:118 逐叶合并 |
| 41 | supply-catalog | A- | 五物种单读路径（facet/supply-catalog.js:38）；facade/data-anchor 各自真源（:249-257 WANXING_FACADE_URL/DAAS_CATALOG_URL） |
| 42 | vendor-identity | A- | gateway/vendors.js:3-24,110-115（自助注册/完整度闸/ACTIVE BINDING/归属骨架行） |
| 43 | vendor-server-onboarding | A | gateway/vendor-onboarding.js:3-25,60-91（准入→selfcheck→平台代写；registry_write_failed 如实降级；供应商永不直触 registry） |

分布：A×24 / A-×17 / B×2 / C×0 / D×0。簇整体健康：43 条中 41 条在代码里能指到具体锚点，无「能力悬空」「归属错位」「与代码矛盾」级（C/D）问题。

## 二、B 级展开

### B1. model-surface-budget——TBD 占位 + 资产未提交（P1 候选）
- openspec/specs/model-surface-budget/spec.md:4 的 Purpose 仍是 `TBD - created by archiving change add-model-surface-budget-gate. Update Purpose after archive.`。归档已发生（openspec/changes/archive/2026-11-05-add-model-surface-budget-gate/ 存在），但 Purpose 没有回填——归档流程的收尾步骤被跳过。
- 加重项：`openspec/specs/model-surface-budget/` 整个目录与 archive 目录都处于 git 未跟踪状态（`git status` `??`），「已归档的能力 spec」只存在于工作树。
- Requirements 本身与代码零漂移：三级=single/daily/monthly（server/model-budget.js:2 与 spec「三级检查」同口径）、model_budget 表 model+tier 键（:105）、budget_exhausted_log（:138）、窗口懒滚动+显式 reset（头注 13 行）、超限报表（:182-185）。
- 修复：回填 Purpose 一段话 + 把 spec 目录与 archive 提交入库。

### B2. facet-editor-cli——Purpose 与 Requirements 互相矛盾（P1 候选）
- Purpose（spec.md:3）说「MCP 引用如实标注凭据要求（**v1 不写 MCP 配置**）」；但 Requirement「MCP references are honest about credentials」（spec.md:38 起）已演进为三车道模型（native OAuth / brokered token / caller key），并明确规定「With a credential established, the CLI SHALL offer to write each target's native MCP configuration」。实现（facet/cli/facet.js:7-15,87）跟随的是 Requirement：「Without a verified caller key … writes NO MCP configuration; with one (facet connect), install …」。
- 即：Purpose 是 v1 旧姿态的化石，Requirement+实现是修订后姿态。读 spec 的人若只看 Purpose 会得出「CLI 永不写 MCP 配置」的错误结论——有债、且这处债会误导。
- 修复：重写 Purpose 一句（如实标注凭据 + 凭据在手时按能力表车道写入），保留红线（无凭据不写、能力表举证才走 native OAuth）。

### 在途 change 的「已完成任务」核对（任务书点名项）
- add-supply-store-unification：16/25 勾选。**P0 发现见下**——勾选项中 1.2/1.3/1.6 与现实不符（不是「没提交」就是「没挂载」），其余勾选项在工作树有真实工件（gateway/supply-store.js 模块本体、scripts/supply-store-migrate.mjs / supply-store-dual-read.mjs / supply-store-dump.mjs/sh、scripts/lib/supply-registry-read.mjs、docs/supply-store-cutover-runbook.md、scripts/test-supply-store*.mjs、change 目录内 supply-store+facet-platform 两个 specs delta——1.6 注记「实施时补列」的 facet-platform MODIFIED delta 实际已补）。
- add-supply-studio-migration：0/26，无声明可核对；其解体计划（4.1-4.6）与现有 /agents、/studio 面现状自洽，不构成漂移。

## 三、本簇 P0/P1/P2 候选

### P0
1. **add-supply-store-unification「勾了没提交 + 勾了没挂载」三重失真**（本会话第三起同类）：
   - (a) **未提交**：全部实现文件 git 未跟踪——`?? gateway/supply-store.js`、`?? scripts/supply-store-*.mjs/.sh`、`?? scripts/lib/supply-registry-read.mjs`、`?? docs/supply-store-cutover-runbook.md`，连 change 目录本身（`?? openspec/changes/add-supply-store-unification/`）都未入库。一次 `git clean -fd` 或分支切换即清空「已完成」的脊柱。
   - (b) **未挂载**：gateway/supply-store.js:533 导出 `registerSupplyStoreRoutes`，但**全仓无任何 importer**；gateway/index.js:15-55 的 import 清单里没有它，readdirSync(:964) 只是 DATA_ROOT 列举不是路由自动加载。tasks 1.2「写闸 API」/1.3「只读投影端点」仅以库函数+测试形态存在，服务面上不存在这两个面。
   - (c) **开关不存在**：task 1.6 声称的 `SUPPLY_STORE_CATALOG` env 在全仓 *.js 零命中（只在 tasks.md:10 与 runbook 文本里出现）；facet/mcp-catalog.js:200-213 仍纯走 registry-bridge 读，无脊柱分支。
   - 模块本身质量不差（fail-closed visibility 注记 supply-store.js:18-22、legacy-direct 结构性拒绝 :193、未知字段拒绝 :235，与 specs/supply-store delta 一致）——问题是「勾了没做完」+「做了没入库」叠加，让 16/25 的进度声明失真。
   - 修复路径：提交全链 → gateway/index.js 挂载 registerSupplyStoreRoutes → facet/mcp-catalog.js 补 env 读源分支 → 或把 1.2/1.3/1.6 回退为未完成并注明。

### P1
2. model-surface-budget Purpose TBD 占位未回填 + spec/archive 目录未提交（见 B1）。
3. facet-editor-cli Purpose 与 Requirement 矛盾（见 B2）。

### P2
4. line-credentials Purpose「三 ref」未随 wanxing-deployer 第四 ref 更新（server/routes/line-credentials.js:24）；Requirements 已更新，仅 Purpose 落后一词。
5. site-plaza/translations/ 未跟踪（plaza 站五语翻译资产有丢失风险，与 plaza spec「五语言」契约相关的资产卫生）。
6. scripts/tmp-probe-machines.mjs / tmp-release-visual-wt.mjs / tmp-unbind-walk-machines.mjs / tmp-walkthrough-three-fixes.mjs 等临时脚本未跟踪散落 scripts/ 根（卫生噪声，建议删除或归档）。

## 四、跨仓 spec 的核对边界（诚实声明）

registry-console-i18n / registry-lineage / registry-product-home / registry-quota-gate / skill-content-propagation 五条的真源代码在 finddata 根 / registry fork，本仓不可见。本审计只验证了：spec 文件内部自洽、spec 间的域名词汇一致（mcp.finddatatech.cloud、fd-1.0.0、per-user key、额度预检）、以及 paas 侧接触面（registry-bridge env 契约、credential_ref 分派、skills-catalog content 代理）与 spec 声明的边界无冲突。registry-bridge 近期提交（dde77c3a fail-closed sentinel、6c871d63 groups 手工映射降级为 fallback）与 add-supply-store-unification proposal 里「carry-registry-visibility-through-bridge 协调收窄」的描述一致。
