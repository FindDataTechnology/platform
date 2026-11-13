# 簇 H-a 健康卡 — bot/browser/cell/composer + chart/file + market/skill + workspace/org 系（25 模块）

审计人：H-a 体检员 · 日期 2026-11-06 · paas HEAD `18767807`（2026-11-06 05:07）
**实际在册清单**（/tmp/paas-g10.json H1/H2/H4/H5/H6 键，25 条，`ls openspec/specs/` 逐一核对全部在册、零跳过；简报写"约 29"，实册 25，以 json+ls 为准）：
- **H1（5）**：bot-relay / browser-use / extension-management-ui / extension-marketplace / extension-runtime-management
- **H2（2）**：cell-lifecycle / dynamic-cluster-composer
- **H4（5）**：chart-data-binding / chart-observation-history / doc-studio / file-persistence / file-preview
- **H5（5）**：ecosystem-access / ecosystem-curation / skill-content-propagation / skill-invocation / skill-self-evolution
- **H6（8）**：member-knowledge-profile / onboarding-guidance / project-container / project-database / project-identity / project-workspace / role-system / workspace-selection

**③ 共同部署事实**（fd-infra-deploy/all-services/prod/，只读）：platform.yaml:57 与 facet.yaml:66 镜像 `sha-a96731b`（源 paas `5e91d61b` 2026-11-06 03:55 ⊆ HEAD，当日新鲜）。`5e91d61b..HEAD` 全簇路径扫描仅 **1 个未部署提交 `94ec620f`**（fix(wake)，触及 gateway/ lib/cell-lifecycle.js server/agent-session.js cron.js——波及 cell-lifecycle 与 workspace-selection 两条，其余 23 模块 undeployed=0）。痛感口径：`git log --oneline --since=2026-09-05 -- <路径>`，n=总提交 f=fix；共享宿主文件（db.js/dsh-profile.js/Dockerfile/package.json）的 n/f 有归因噪声，已在各条标注。

---

## H1 — bot / browser / extension（5）

### 1. bot-relay — 评级 A
**理由**：认证/寻址语义逐条落位、注册顺序防 shadow 有注释锚、测试新鲜、痛感近零。
① 对齐：`server/routes/bot-relay.js:83`(POST `${RELAY_PREFIX}send`，:28 前缀) + `:73`(无 token→404 inert) + `:76`(错 token→401 先于 body)；注册先于 bots 路由防 `:id=relay` 吞调 `server.js:415-418`（注释明示 shadow 风险）。
② 测试：`scripts/test-bot-relay.mjs`(10-31)、`e2e/bots-surface.spec.js`(10-11)。
③ 部署：undeployed=0，随 platform 当日镜像。
④ 痛感：bot-relay.js n=2 f=1——低。
⑤ 陈旧度：spec 10-28 vs 代码 10-14，spec 更新，剪刀差负值。

### 2. browser-use — 评级 B
**理由**：车道供给/门禁/钉版全落位且测试新鲜，但 60 天内 6 连 fix 全是同一类截图输出路由问题（EACCES /tmp→workspace），车道配置面反复返工是真实痛感。
① 对齐：`server/browser-mcp.js:3`(exec 钉版 @playwright/mcp CLI)、bundle 声明 `platform.bundle.json:73`、供给门 `dsh-profile.js:969-974`(BROWSER_MCP_CLI/BROWSER_LANE)。
② 测试：`scripts/test-browser-lane-gate.mjs`(10-31)、`browser-lane-smoke.mjs`(10-31)。
③ 部署：undeployed=0。
④ 痛感：browser-mcp.js+bundle.json n=20 f=8（40%；6 条 lane 专属：054dc944/c375f551/419bcee4/c6c3ed40/21eee179/2273d28a——outputDir/cwd/chromium 定位连环修）。
⑤ 陈旧度：spec 10-28 vs 代码 11-01，剪刀差 4 天。

### 3. extension-management-ui — 评级 B
**理由**：路由迁移（legacy→Settings）与双 tab 结构落位，但专测停在 10-11（26 天），此后 UI 仍活跃改动。
① 对齐：重定向注释与实现 `web/src/App.tsx:10`+`:361`；页面 `web/src/pages/ExtensionsPage.tsx:5-26`(已启用/商店两 tab)；Settings 挂载 `web/src/components/settings/SettingsDialog.tsx`。
② 测试：`e2e/extensions.spec.js`(10-11)、`e2e/settings-modal.spec.js`(10-11)——26 天未随 UI 演进更新。
③ 部署：undeployed=0。
④ 痛感：ExtensionsPage+SettingsDialog n=13 f=2——低。
⑤ 陈旧度：spec 10-28 vs 代码 11-02，剪刀差 5 天。

### 4. extension-marketplace — 评级 B
**理由**：本地目录/排序/分组门 fail-closed 落位，远程 registry 目录依赖外置服务，fix 密度中高。
① 对齐：`extension-store.js:40,172`(requiresConfig 派生，服务端/客户端同规则注释 :24)；商店视图 `web/src/components/extensions/McpMarketView|SkillsMarketView`（ExtensionsPage.tsx:15-18 导入）；registry 摄取 `registry-bridge.js:1-30`（fail-closed：组受限条目"never degrades to public"）。
② 测试：`e2e/extensions.spec.js`(10-11)、`e2e/registry-connect.spec.js`(10-18)、`scripts/test-market-annotations.mjs`(11-02)。
③ 部署：undeployed=0。
④ 痛感：extension-store+registry-bridge+catalog n=21 f=6（29%）。
⑤ 陈旧度：spec 11-05 vs 代码 11-06，剪刀差 1 天。

### 5. extension-runtime-management — 评级 B
**理由**：REST 全家+locked 不可变+credentialRef 系统管理标记逐条落位、痛感低，唯 e2e 26 天未更新而接口 11-06 仍在动。
① 对齐：`server/routes/extensions.js:56,97,169,206,226`(MCP CRUD/enable) + `:110-111`(credentialRef→400 "system-managed") + `:254-453`(skills 同族)；store `extension-store.js`(329 行 origin/locked 元数据)。
② 测试：`e2e/extensions.spec.js`(10-11)——接口面专测单一且旧。
③ 部署：undeployed=0。
④ 痛感：extensions.js+extension-store.js n=23 f=3（13%——低）。
⑤ 陈旧度：spec 11-04 vs 代码 11-06，剪刀差 2 天。

## H2 — cell / composer（2）

### 6. cell-lifecycle — 评级 B
**理由**：词汇单源双执行体（gateway+桌面管家）落位、测试族全簇最厚（12+ 个 cell-* 专测），但痛感全簇第一，且唯一现网未部署修复正是它的 wake 修复。
① 对齐：注册表+默认居住策略 `gateway/index.js:92,135`(`initialPolicy: "on_demand"`)；值日环 `gateway/index.js:138-144`+`gateway/duty-ring.js`；注册表执行体 `gateway/cell-registry.js`/`gateway/spawner.js`；桌面侧 `lib/cell-lifecycle.js`。
② 测试：`test-cell-lifecycle.mjs`(10-27)、`test-cell-lifecycle-wake.mjs`(11-06，205 行随 94ec620f 新增)、`test-cell-registry-db.mjs`/`-wake-admission`/`-spawner-dedup` 等 12+ 族。
③ 部署：**undeployed=1——`94ec620f`(fix(wake) 三条 re-arm 路径) 在 sha-a96731b 源之后，现网缺**。
④ 痛感：gateway/+lib/cell-lifecycle.js n=150 f=58（39%）——全簇之最。
⑤ 陈旧度：spec 11-06 05:24 vs 代码 11-06，剪刀差 0 天。

### 7. dynamic-cluster-composer — 评级 B
**理由**：composer UI/绑定/解散全链有代码有 API 专测，但 UI 断言型 e2e 未证实，fix 占比过半。
① 对齐：API `server/routes/clusters.js:50,169`(`/api/clusters/mine`) + `clusters-db.js`(SQLite 持久)；UI `web/src/components/clusters/ClusterComposerModal.tsx` + `web/src/pages/AgentsPage.tsx`；绑定 chip `web/src/components/ChatHeader.tsx`。
② 测试：`scripts/test-cluster-platform.mjs`(10-20，pack 校验+cluster API)；composer 交互 e2e **未证实**（e2e/ ls 核过无专 spec）。
③ 部署：undeployed=0。
④ 痛感：clusters.js+clusters-db.js n=11 f=6（55%）。
⑤ 陈旧度：spec 10-22 vs 代码 10-22，剪刀差 0 天。

## H4 — chart / doc / file（5）

### 8. chart-data-binding — 评级 A
**理由**：绑定一线数据源契约全落位、五件专测齐、40 天双冻结零漂移零痛感。
① 对齐：`chart-bindings.js:1`(lineage/存储) + `chart-source.js:1`(v1 限 fd-open-data-mcp read_series/read，:39 stale_reason 三态) + 路由 `server/routes/resources.js`。
② 测试：`test-chart-bindings/-source/-bind-bridge/-bind-declared/-fence-hash.mjs`(均 10-11) + `e2e/resources-binding.spec.js`(10-11)。
③ 部署：undeployed=0。
④ 痛感：chart-bindings/source n=1 f=0——零。
⑤ 陈旧度：spec 09-28 = 代码 09-28，剪刀差 0 天（双冻结但互相对齐）。

### 9. chart-observation-history — 评级 A
**理由**：append-only 点级观测+五分类+保留路径逐条落位，专测在、零痛感。
① 对齐：`chart-refresh.js:1,6`(对照存量逐点分类再写观测) + `:36`(refresh-log/unchanged 观测老化) + `:423`(unit 契约 attach 记录) + `:600`(清理无引用 binding 及其历史)。
② 测试：`scripts/test-chart-refresh.mjs`(10-11) + 共享 e2e/resources-binding.spec.js(10-11)。
③ 部署：undeployed=0。
④ 痛感：chart-refresh.js n=1 f=0——零。
⑤ 陈旧度：spec 09-28 = 代码 09-28，剪刀差 0 天。

### 10. doc-studio — 评级 C
**理由**：执行层契约在镜像层有锚，但 paas 仓内无模块专测、内容层技能不在本仓、宿主文件 fix 密度全簇第二且归因噪声大——契约与实现两头悬空。
① 对齐：`Dockerfile:211-213`(python3+pip office 执行层，add-doc-studio 注记) + `:325`(requirements-office.txt 钉版 COPY)；**内容层（office 技能集）不在 paas 仓（finddata-skills 侧），未证实**。
② 测试：**未证实模块专测**——scripts/ ls 核过无 office/doc-studio 断言脚本（test-library-fetch 属 resource-library）。
③ 部署：undeployed=0（镜像即执行层载体）。
④ 痛感：Dockerfile+requirements-office.txt n=36 f=21（58%，但 Dockerfile 为全镜像共享宿主，归因噪声大）。
⑤ 陈旧度：spec 10-09 vs 代码 11-05，剪刀差 27 天（临界未破 30）。

### 11. file-persistence — 评级 A
**理由**：原子写+fsync+串行化单文件单源落位，专测在，痛感近零。
① 对齐：`lib/persistence.js`(atomic writeJsonOr/readJsonOr 单源；registry-bridge.js:14 等多处 import 引用即旁证)。
② 测试：`scripts/test-persistence.mjs`(10-11)。
③ 部署：undeployed=0。
④ 痛感：lib/persistence.js n=2 f=1——低。
⑤ 陈旧度：spec 10-21 vs 代码 10-31，剪刀差 10 天。

### 12. file-preview — 评级 A
**理由**：安全属性即特性（allowlist root+realpath+只读）逐条落位、专测双档、零 fix。
① 对齐：`server/routes/files.js:90`(`/api/files`) + `:112-113`(lexical root 与请求路径双 realpath) + 头注 `:4-8`(read-only/allowlist/inline 类型白名单)；注册位 `server.js:421-422`（先于 SPA fallback 防 catch-all 吞 /api/files，注释明示）。
② 测试：`scripts/test-file-serving.mjs`(10-11) + `e2e/attachment-preview.spec.js`(10-11)。
③ 部署：undeployed=0。
④ 痛感：files.js n=3 f=0——零。
⑤ 陈旧度：spec 10-15 vs 代码 09-27，spec 更新。

## H5 — market / skill / ecosystem（5）

### 13. ecosystem-access — 评级 C
**理由**：spec 需求主体（自助注册/community 身份/wgk- 调用键/RFC 9728 发现/付费组墙）实现在**外部仓**（上游 agentic-community/mcp-gateway-registry，cheap-1 `mcp.finddatatech.cloud` 栈，MCP-REGISTRY.md 口径），paas 仓内只有消费侧 bridge——本仓口径核心对齐未证实。
① 对齐：本仓证据仅 `registry-bridge.js:1-30`（摄取/组门 fail-closed）；gateway 本体不在本仓（finddata/ ls 核过无 registry 仓）——**未证实**。
② 测试：`e2e/registry-connect.spec.js`(10-18) 测的是 paas 侧连接流，非 gateway 身份面。
③ 部署：gateway 镜像不在本簇 yaml 对账范围（外部栈）——未证实。
④ 痛感：registry-bridge.js n=15 f=4——中。
⑤ 陈旧度：spec 10-31 vs bridge 代码 11-06，剪刀差 6 天（但覆盖的是外置主体）。

### 14. ecosystem-curation — 评级 C
**理由**：审核门/托管姿态/来源许可证可见的主体治理在外部 registry 仓，paas 侧只有精选目录+溯源标注+fail-closed 组门——"只有过审素材进场"在本仓不可闭环验证。
① 对齐：本仓证据 `registry-bridge.js`(fail-closed 组门+hand-mapped fallback)、精选目录 `market-catalog.json`/`market-catalog-skills.json`、溯源 `lib/market-annotations.js`（provenance 三分 kinds）；审核工作流本体 **未证实在本仓**。
② 测试：`scripts/test-market-annotations.mjs`(11-02)、`test-facet-marketplace-json/repo.mjs`。
③ 部署：同 13——外部栈未证实。
④ 痛感：bridge+annotations+catalog n=15 f=4——中。
⑤ 陈旧度：spec 10-31 vs 消费侧代码 11-06，剪刀差 6 天。

### 15. skill-content-propagation — 评级 B
**理由**：物化链（DB→SKILL.md watched dir→热载）与 pack 安装侧专测齐，唯"取值 URL 随版本派生刷新"子句未逐行核对；痛感低。
① 对齐：`skill-materialize.js:1-13`(DB custom skills→SKILL.md、watcher 热载、pack-owned originPackId 分根) + `server/routes/packs.js`(安装/版本面)。
② 测试：`test-skill-materialize-files.mjs`(10-15)、`test-pack-skill-install.mjs`(10-16)、`test-skill-package-upload.mjs`(10-16)。
③ 部署：undeployed=0。
④ 痛感：skill-materialize+packs.js n=14 f=1——低。
⑤ 陈旧度：spec 10-12 vs 代码 10-31，剪刀差 19 天。

### 16. skill-invocation — 评级 B
**理由**：装载/物化/调用广播/热载全链落位，但宿主 dsh-profile.js 全仓 churn 最重文件之一，fix 密度噪声高且 slash 自动补全 UI 子句未单独核。
① 对齐：skills 发现补丁 `dsh-profile.js:1493-1505`(dsh-skill-filesystem customSkillDirs override-by-id) + `skill-materialize.js`(热载无重启) + `skill_use` 广播 `server/ws.js:517-519`。
② 测试：`e2e/packaged-skills.spec.js`(10-22)、`test-skill-materialize-files.mjs`(10-15)。
③ 部署：undeployed=0。
④ 痛感：dsh-profile.js n=68 f=24（35%——共享宿主，含非本模块修复，归因噪声大）。
⑤ 陈旧度：spec 10-21 vs 代码 11-05，剪刀差 15 天。

### 17. skill-self-evolution — 评级 A
**理由**：提议→评测→双钥匙晋升→lineage 全链当日新鲜落位，专测当日同步更新，零 fix。
① 对齐：`server/skill-evolution-routes.js:37-124`(candidates/propose/evaluate/promote/reject 五口) + `server/skill-evolution.js` + `server/skill-eval.js`(A/B 评测门)。
② 测试：`scripts/test-skill-evolution.mjs`(11-05)、`test-skill-eval-groundtruth.mjs`(11-06)。
③ 部署：undeployed=0。
④ 痛感：skill-evolution 族 n=4 f=0——零。
⑤ 陈旧度：spec 11-05 = 代码 11-05，剪刀差 0 天。

## H6 — workspace / project / org 系（8）

### 18. member-knowledge-profile — 评级 A
**理由**：knowledge profile 编译/挂载/预算隔离落位、专测当日、spec 代码同日、痛感低。
① 对齐：`server/knowledge-profile.js`(249 行，pack→部署 profile 编译) + `server/fleet-context.js` + 挂载面 `server/routes/fleets.js`。
② 测试：`scripts/test-knowledge-profile.mjs`(11-05)。
③ 部署：undeployed=0。
④ 痛感：knowledge-profile+fleet-context n=8 f=2——低。
⑤ 陈旧度：spec 11-05 = 代码 11-05，剪刀差 0 天。

### 19. onboarding-guidance — 评级 B
**理由**：三步导览+帮助中心+包指南落位，但 e2e/onboarding.spec.js 归属存疑（可能与 intent-onboarding spec 重叠），26 天未动。
① 对齐：`web/src/components/OnboardingTour.tsx`(308 行) + `web/src/components/HelpDialog.tsx`(284 行)；服务侧 profile 面 `server/routes/onboarding.js:71-140`（注意：该路由或属 intent-onboarding spec，归属未证实）。
② 测试：`e2e/onboarding.spec.js`(10-11)——**归属未证实**（guidance vs intent-onboarding）。
③ 部署：undeployed=0。
④ 痛感：OnboardingTour+HelpDialog n=9 f=3——中低。
⑤ 陈旧度：spec 10-28 vs 代码 10-31，剪刀差 3 天。

### 20. project-container — 评级 A
**理由**：项目一等实体（id+name+backing path 唯一索引）落位清晰，容器专测 10-31 新鲜；共享宿主噪声不影响模块本身。
① 对齐：`db.js:965-987`(projects 表+idx_projects_backing_path 唯一) + `:1232-1270`(查询/插入/改名) + `server/routes/misc.js:827,862,868`(POST/GET/PATCH /api/projects)。
② 测试：`scripts/test-project-container.mjs`(10-31) + `e2e/projects-automation.spec.js`(10-11)。
③ 部署：undeployed=0。
④ 痛感：db.js+misc.js n=63 f=13——**共享宿主噪声大**，模块自有行可靠性不因之降。
⑤ 陈旧度：spec 10-31 vs 代码 11-03，剪刀差 3 天。

### 21. project-database — 评级 C
**理由**：迁移/降级/存储落位，但 spec 剪刀差 43 天**超标**（spec 09-21 之后 db.js 又 churn 45 次），两份专测 26 天旧——spec 已跟不上单库持续演进。
① 对齐：`db.js`(3938 行单库) + `migrate.js`(234 行幂等迁移)；legacy 导入见 migrate.js。
② 测试：`e2e/sqlite-persistence.spec.js`(10-11)、`scripts/test-migrate-single-to-cell.mjs`(10-11)——26 天未动。
③ 部署：undeployed=0。
④ 痛感：db.js+migrate.js n=45 f=10——共享宿主噪声大。
⑤ 陈旧度：**spec 09-21 vs 代码 11-03，剪刀差 43 天——stale**。

### 22. project-identity — 评级 C
**理由**：身份面是静态契约且现状一致（name=platform/启动日志/MCP UA），无功能风险，但 spec 102 天剪刀差**全簇最旧**，且无任何身份面专测。
① 对齐：`package.json:3`("name": "platform") + 启动日志 `server.js:1101,1814`；npm/MCP UA 面同源——契约未漂移，spec 只是陈旧。
② 测试：**未证实**（无 identity 断言脚本，scripts/ ls 核过）。
③ 部署：undeployed=0。
④ 痛感：package.json n=52 f=20——**几乎全为版本 bump 噪声**，非身份面痛感。
⑤ 陈旧度：**spec 2026-07-22 vs 代码 11-01，剪刀差 102 天——全簇最 stale**（churn 虽为噪声，spec 自 07-22 起未回访）。

### 23. project-workspace — 评级 B
**理由**：命名建项目→目录创建→既有 workspace 契约接管的链路落位，与 project-container 共享路由与专测，自身无独立断言面。
① 对齐：`server/routes/misc.js:827`(POST /api/projects 建 backing 目录，projects root) + `db.js:965`(backing_path 落账)。
② 测试：借 `test-project-container.mjs`(10-31)+`e2e/projects-automation.spec.js`(10-11)——**无本 spec 名义专测**。
③ 部署：undeployed=0。
④ 痛感：misc.js n=27 f=3——共享宿主，低。
⑤ 陈旧度：spec 10-31 vs 代码 11-02，剪刀差 2 天。

### 24. role-system — 评级 A
**理由**：枚举单源（core 共享契约）+部署级存储+admin 分配落位、双专测、零痛感。
① 对齐：`packages/core/src/lib/roles.ts:12`(BUSINESS_ROLES 枚举单源) + `server/roles.js:1,23`(re-export 单源注释+header 解析 :37) + `web/src/components/settings/RolesSection.tsx` + 布局枢轴 `server/layout.js`。
② 测试：`scripts/test-role-system.mjs`(10-16) + `e2e/roles.spec.js`(10-16)。
③ 部署：undeployed=0。
④ 痛感：roles.js+layout+RolesSection n=1 f=0——零。
⑤ 陈旧度：spec 10-19 vs 代码 10-16，剪刀差 3 天。

### 25. workspace-selection — 评级 B
**理由**：boot 钉→持久选择→校验→重启应用→广播全链落位、三件专测，但宿主 agent-session.js fix 占比 50% 全簇第二，且 94ec620f wake 修复未进现网镜像。
① 对齐：`server/agent-session.js:63-77`(AGENT_WORKSPACE pin > persisted > cwd，拒绝入 rejected) + `:1148`(`workspace_changed` 广播)；list_workspaces 面同文件。
② 测试：`scripts/test-workspace-boot.mjs`(10-11)、`e2e/workspace-picker.spec.js`(10-22)、`e2e/workspace-boot.spec.js`(10-11)。
③ 部署：**undeployed=1——`94ec620f` 触及 agent-session.js:5 行，现网缺**。
④ 痛感：agent-session.js n=32 f=16（50%——共享宿主，但占比确实高）。
⑤ 陈旧度：spec 10-22 vs 代码 11-06，剪刀差 15 天。

---

## 簇摘要

**三件最严重的事**：
1. **H5 双 C 根因同一：ecosystem-access / ecosystem-curation 的 spec 需求主体（自助注册、wgk- 调用键、RFC 9728 发现、curation 审核门）实现在外部仓 mcp-gateway-registry（cheap-1 栈），paas 仓内只有 registry-bridge.js 消费侧可证——本仓体检口径对齐「未证实」，治理/身份两面在本仓无归责代码。建议体检结论记"跨仓能力"，后续以外部仓体检补位，或在本仓 spec 加权威指针（同 vertical-packs 先例）。**
2. **cell-lifecycle 痛感全簇第一（gateway/+lib n=150 f=58，39%）且全簇唯一现网未部署修复 `94ec620f`（fix(wake) 三条 re-arm 路径，205 行新专测同行）正落其上——sha-a96731b 现网缺此修复；workspace-selection 同批中招（agent-session.js 5 行）。下次滚镜像即销账，建议滚版时点名验证 wake 路径。**
3. **spec 陈旧剪刀差两单超标：project-identity 102 天（全簇最旧，07-22 起未回访；churn 虽为版本 bump 噪声）与 project-database 43 天（db.js 真实演进 45 commit 后 spec 未跟）——后者是实漂移风险，建议对 db.js 的 store/migration 面做一次 spec 回写。**

次级观察：doc-studio 无任何模块专测且内容层不在本仓（C）；browser-use 60 天 6 连 fix 同类问题（截图输出路由），门（test-browser-lane-gate）已三度逮住同类回归，配置面宜收敛。

**评级分布**：A×9 · B×11 · C×5 · D×0（共 25；A=bot-relay/chart-data-binding/chart-observation-history/file-persistence/file-preview/skill-self-evolution/member-knowledge-profile/project-container/role-system；C=doc-studio/ecosystem-access/ecosystem-curation/project-database/project-identity）。
