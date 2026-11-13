# 簇 H7-1 健康卡 — 应用面/导航/契约/Builder/偏好/CI/CRM 客服台/预设/依赖安全/拖传/E2E/外部技能（15 模块）

审计人：H7-1 体检员 · 日期 2026-11-06 · paas HEAD `b956f336`→`04d543ce`（审计窗口内仓库仍在前移，各检查以执行时点为准）
**实册核对**：15/15 全部在 `openspec/specs/` 在册（逐一 ls 核过），零跳过。

**③ 共同部署事实**（fd-infra-deploy/all-services/prod/，只读；简报给的 sha-a96731b 已过时——**platform.yaml:57 与 facet.yaml:66 现为 `sha-1275719`，源 paas `94ec620f` 2026-11-06 05:06**，merge-base 实证 ⊆ HEAD）：`94ec620f..HEAD` 共 7 提交，触及面=win-install-smoke.yml/agent-runner/manager.js/dsh-profile-template/package.json/openspec specs(s caller-preferences 归属注记)/docs/scripts/test-*。本簇 15 模块运行时代码**零条落入未部署窗**（caller-preferences 仅 spec 注记、builder 队形仅 docs/fleet-templates 溯源件）。痛感口径：`git log --oneline --since=2026-09-05 -- <路径>`，n=总 f=fix。

---

### 1. app-center — 评级 A
**理由**：统一网格/徽章/降级三态全落位，纯函数单源可测，测试族新，痛感低。
① `web/src/pages/AppCenterPage.tsx:262-269`（catalog/connections 双独立 null+退避重试一次+错误态出口）+ `web/src/lib/appCatalog.ts:20-56`（五线品牌序/early 徽章纯数据）；`/api/catalog` `server/routes/misc.js:211`。
② `e2e/app-center.spec.js`(10-28)、`e2e/app-center-load-recovery.spec.js`(11-02)、`scripts/test-app-center.mjs`(10-23)、`verify-live-app-center.mjs`(10-18)。
③ undeployed=0，随 platform 当日镜像。
④ n=12 f≈4（AppCenterPage+appCatalog 两核心；fix=fusion 命名/ci 推池，非模块病灶）。
⑤ spec 11-02 vs 代码 11-04，剪刀差 2 天。

### 2. app-navigation — 评级 B
**理由**：谓词藏 tab/折叠持久化/页脚单行/工作台定制全有实现锚，但折叠三件专测 25 天未动而 Sidebar 活跃演进。
① fleet-web 隐藏谓词 `web/src/components/Sidebar.tsx:114-121`（IS_DESKTOP=preload bridge）；折叠持久化 `:150-167`（nav.families.collapsed+storage-blocked 降级）；页脚单行 `:949-980`；工作台定制抽屉 `:195,534`。
② `e2e/layout.spec.js`(11-02)、`sidebar-workspaces.spec.js`(10-31)、`nav-persistence/nav-routes/sidebar-collapse.spec.js`(均 10-11，25 天)、`fleet-nav-gating.spec.js`(10-16)。
③ undeployed=0。
④ n=26 f=5（19%；含真 bug `d5f28cc8` Sidebar 原生选路漏传 path——typecheck 门显形）。
⑤ spec 11-06 vs 代码 11-02，spec 反超 4 天（align-yizuo-specs-to-reality 批）。

### 3. artifact-contract — 评级 B
**理由**：结构守卫（ADR-0009）+基线技能+Dockerfile COPY 全实证，唯 remote fork 契约行未含"交付时入库"教学，守卫测试 26 天未随 R2 内容更新。
① 契约正本 `skills/platform-output-contract/SKILL.md:3`（description 全规则）+`:33`（save_to_library 同回合）；remote fork 行 `server/agent-session.js:671`（仅 echarts/相对路径/data: 三条+不谎称，**无 ingest 教学**）；入镜像 `Dockerfile:301`。
② `scripts/test-artifact-contract-guard.mjs`(10-11，26 天——关键词断言未覆盖 ingest)、`e2e/artifact-delivery.spec.js`(10-15)。
③ undeployed=0（agent-session.js 11-06 随 wake 修复已入镜像）。
④ agent-session.js n=32 f=16——高，但为共享宿主文件归因噪声，契约行自身近月零改动。
⑤ spec 10-16 vs SKILL.md 10-16，剪刀差 0。

### 4. blueprint-trial-bounded-fire — 评级 A
**理由**：有界点火立案即毕即归档，竞速/入档/finally 释放逐条对齐，spec 与代码同日零剪刀差。
① `server/blueprint-trial.js:260-266`（fireJobBounded=Promise.race+fire-timeout code）+`:349-353`（fireRound 逐作业 bounded 注记）；fired 带 error 走 `:216` 收证判红路径。
② `scripts/test-trial-fire-timeout.mjs`(11-01，4 测)、`test-blueprint-trial.mjs`(11-01，回归 27)。
③ undeployed=0。
④ n=14 f=8——但 fix 全是 blueprint-studio 模型解析链（早于本需求），点火超时自 11-01 落地零返工。
⑤ spec 11-01 vs 代码 11-01，剪刀差 0。

### 5. builder-team-templates — 评级 A
**理由**：四员双新种子 bundled 自激活+工具面负清单+roster 官方徽章+locale 门全链实证，60 天零 fix。
① `server/blueprint-author.js:1,59`（校验绿才落池）/`server/pack-author.js:3-29`（同一 validatePackManifest）；bundled 登记 `platform.bundle.json`（blueprint-author"无 approve/cast/trial"/pack-author"无 publish/pricing/deploy"逐字）；roster 判定 `gateway/index.js:808`（OFFICIAL_AUTHOR_EMAILS）+`gateway/packs.js:1618,1659`；locale 门 `lib/pack-locale-coverage.js`+`gateway/packs.js:138`。
② `scripts/test-builder-author-bridges.mjs`(10-30)、`test-official-locale-gate.mjs`(10-30)、`e2e/official-showcase.spec.js`(11-03)、`test-official-showcase.mjs`(11-03)。
③ undeployed=0。
④ n≈3 f=0。
⑤ spec 10-30 vs 代码 10-31，剪刀差 1 天。（分身工坊 pack 在 `packs/facade-builder/manifest.json`，其离线供给道未证实——非 spec 强制项，该员种子供给只要求过校验。）

### 6. caller-preferences — 评级 B
**理由**：跨仓归属已如实注记、本仓 context_id 直通缝实证，但回调/重试/密钥纪律四大行为场景在 paas 仓内不可证。
① 归属注记 `openspec/specs/caller-preferences/spec.md:7`（sub2api fork 仓——本仓仅 a2a 缝）；缝实证 `gateway/wanxing/a2a.js:25-31,285,318,364`（context_id 原样透传+幂等键含 contextId）。
② 本仓无 caller-preferences 专测；间接 `scripts/test-agent-delegation-a2a.mjs`/`test-wanxing-*.mjs`（10-31 前后）。
③ undeployed=0（a2a.js 11-05 ⊆ 镜像源）；spec 注记 24e64f39 在未部署窗（纯文档零运行时影响）。
④ a2a.js n=8 f=3（幂等重放/并发槽/agent-card 脱敏——wanxing 面共性修复）。
⑤ spec 11-06 vs 代码 11-05，剪刀差 1 天。**未证实**：回调签名/15 分钟退避窗/密钥不出请求——须 fork 仓对账。

### 7. ci-pipeline — 评级 C
**理由**：主门禁 35 天绿（ci.yml:3 注记），但验收腿 60 天 103 提交 33 修（32%）为全簇痛感之最——windows/桌面/装机腿连环返工。
① 门禁链 `.github/workflows/ci.yml:20-133`（lint→dsh 边界→typecheck→unit→locales→build→e2e fast）；miniapp 经济门 `miniapp-ci.yml:1-49`（10-27 起）；Jenkins 出片 `Jenkinsfile:1-30`。
② 自身即测试基建；n/a（不跑测，只核在册）。
③ 无部署面（CI 配置不入镜像）——但 Jenkinsfile 产出生产镜像，其 9-29 残留回收修复 `4e27c02b` 已入产。
④ n=103 f=33：`6cee45eb`（windows 三修+runner 腿）、`615a4dba`（五轮 E2E 全暗真凶 ESM 导入）、`23dad1e8`/`4a707a03`（推池凭据两连修）、`cfaeb4f5`/`13fd0792`/`b1f23a29`/`8e956d24`（windows 腿同台阶 env/路径四连坑）。
⑤ spec 10-29 vs workflows 11-06，代码反超 8 天。

### 8. crm-desk-bridge — 评级 A
**理由**：钉版 1.1.0、98 工具上界=123−23 fork−2 发送类逐字算清、双凭据形态与商家 profile 发现全落位。
① 上界 `lib/operator-tool-face.js:12-19`（98 名单 frozen，版本升级强制重生成）；server 接入 `platform.bundle.json` chatwoot 条目（requiresEnv/envRefs/credentialEnv→BYOK）+钉版 `package.json:48,81-83`；技能钉 account_id=1+分页 `skills/crm-desk-reception/SKILL.md:12-14`；商家变体 `packs/crm-desk-suite/skills/crm-desk-reception-merchant/SKILL.md:10-16`（profile_get 发现，不假定）；发送走闸 `lib/action-registry.js:229-251`。
② `scripts/test-crm-desk-bridge.mjs`(10-23，18KB)。
③ undeployed=0。
④ n=12 f=2（bundle+skill+face 面，低）。
⑤ spec 10-23 vs operator-tool-face 10-22，剪刀差 1 天。

### 9. crm-desk-embed — 评级 A
**理由**：四路（go/sso/entry/proxy）降级语义逐条诚实呈现，token-only 用户有专路而非死端，最新修复已部署。
① `server/routes/desk-embed.js:210-230`（go：未连→连接面板引导、缺登录对→need-login 引导、未配置→503 诚实页）；`:236-260`（Platform API SSO 兑换，404 未开通/401 凭据无效/503 未配置/502 上游）；`:265-290`（entry 引导+et cookie）；BYOK `chatwoot-credentials.js:24-37`（401→stale，重存恢复；降级 unconnected）。
② `scripts/test-desk-embed.mjs`(10-23)；无专 e2e（grep e2e/ 无 desk 文件）——扣分点但单测覆盖四路。
③ undeployed=0（desk-embed.js 03-55 修复随 94ec620f 当日入镜像）。
④ n=5 f=1。
⑤ spec 10-23 vs 代码 11-06，代码反超 14 天（<30）。

### 10. crm-desk-pack — 评级 B
**理由**：pack 形状/fullSurface 理由/BYOK 租户隔离实证，唯 pack 在生产镜像的供给道未证实（runtime stage COPY 清单未见 packs/）。
① `lib/crm-desk-pack.js:31-37`（chatwoot ref 必须 fullSurface+理由，operator face 为界）；manifest `packs/crm-desk-suite/manifest.json`（mcpServers=[chatwoot]、skills=[reception-merchant]）；凭据不出共享面 `chatwoot-credentials.js:6-13`（仅 owner cell patch+embed 会话映射）。
② `scripts/test-crm-desk-pack-embed.mjs`(10-23，14KB)。
③ **未证实**：`Dockerfile:187 COPY . .` 入 builder 后，runtime stage（:227-269）COPY 清单未见 packs/crm-desk-suite——生产是否可一步安装存疑；platform.bundle.json 亦无该 pack。
④ n=3 f=0。
⑤ spec 10-23 vs manifest 10-30，剪刀差 7 天。

### 11. custom-presets — 评级 B
**理由**：CRUD/保留前缀/mcpTools 收窄/外来主跳过全实证，唯"未知工具名编辑时拒绝"场景在服务端校验器未见存在性检查。
① `server/routes/custom-presets.js:222-349`（GET/POST/PUT/DELETE/pack-draft 全套）；`user.` 前缀 `:7-11`；mcpTools `:108-142`（≤64 项/格式/去重/仅引用服务器可挂面）；外来主跳过 `pack-store.js:13,74,103`；样本提示上界 `:165`。
② `e2e/custom-presets.spec.js`(10-22，20KB)、`scripts/test-custom-presets.mjs`(10-14)。
③ undeployed=0。
④ n=5 f=1。
⑤ spec 10-20 vs 代码 11-05，代码反超 16 天。**未证实**：spec 场景"Unknown tool name is rejected at edit time"——:108-142 仅格式校验，未见对实际 server 工具表的存在性拒绝（或落组合面兜底，实现点未寻获）。

### 12. dependency-security — 评级 B
**理由**：轮次契约建制化（轮次记录/override 论证/豁免可达性/嵌套大版本显式项全备且落 package.json），但至今仅一轮，复跑机制未见。
① override 存续 `package.json:77-84`（@mapbox/node-pre-gyp→tar ^7.5.22+chatwoot ts 剔除）；轮次记录 `openspec/changes/archive/2026-10-21-dependency-security-round/notes/round-record.md`（151→分 manifest 清单/decompress dev-only 豁免/weapp 36 文件 sha256 基线证据）；out-of-scope 归属=app 移交 add-mobile-app（同记录 §表）。
② 轮次门=各 manifest 测试门（记录 §1）+weapp 字节级比对；无独立常驻测试脚本（契约按轮收口，设计如此）。
③ 无部署面（依赖治理，产物随镜像出片 v1.3.18+）。
④ package.json/lock n=53 f=20——高频但多为功能随行；二次 dependabot 复核未见于 10-21 后记录。**未证实**：第二轮是否已排期。
⑤ spec 10-21 vs 轮次 10-21，剪刀差 0。

### 13. drag-drop-upload — 评级 D
**理由**：簇内最重脱节——spec 停在 8 月"extension 时代"（94 天未动，全簇最陈旧），两条场景实证不达标。
① 投放=附件路径（非 spec 语义的后台上传）`web/src/components/Composer.tsx:478-491`（注释自认 drop=attach 同 paperclip）→`packages/core` uploadFile→`/api/documents`；类型映射 `documents.js:26-38`（EXT_TYPE_MAP 单源）。**违背一**：不支持类型 spec 令 HTTP 415——实证为 422：`documents.js:165` throw→addDocument catch `:103-110` 转 error 行→route `server/routes/documents.js:52-56` 422；全仓 grep 无 415 赋值点。**违背二**：粘贴文本/URL 入文档场景——web/src+packages 全仓无 onPaste handler（`addText` 仅 `DocumentsPage.tsx:248` 手动按钮），未实现。
② 无拖/贴专测；仅 `e2e/documents-react.spec.js` 覆盖文档页 CRUD。
③ undeployed=0。
④ Composer n=14 f=4——修的是附件链，spec 零回写。
⑤ spec 08-04 vs 代码 11-02，**剪刀差 90 天=stale**。

### 14. e2e-testing — 评级 B
**理由**：隔离/单命令/三 project 语义全实证且 146 spec 在册，spec 刚随体检反向条款刷新；扣分=套件自身 60 天 54 修（30%），flaky 收口已第三处。
① 隔离 `playwright.config.js:38`（testDir）+`e2e/helpers.js` prepareTempStoreDirs→config `:141-142`（CHAT_HISTORY/DOCUMENTS_STORE_DIR→tmp）；单命令 `package.json:17-20`（test:e2e fast/smoke/live opt-in，live 需 PW_LIVE=1）；README 同口径 `e2e/README.md:7-11`。
② 自身即测试：146 个 spec 文件（ls 计数）。
③ 无部署面（测试基建）；其 CI 腿随 ci.yml 入产门。
④ e2e/ n=182 f=54——高频（大半为功能随行改测），但 `c2532cd6`（11-06"CI-only flaky 第三处"）示慢 runner 赛跑类问题复发。
⑤ spec 11-06 vs config 10-22，spec 反超 15 天（align-yizuo 批新增基线/反 flaky 条款，先行于实现属正常方向）。

### 15. external-skill-sources — 评级 A
**理由**：env 门/快照 stale-on-failure/服务端确认闸/名字归一/穿越拒绝逐条 file:line 实证，60 天零 fix，spec 11-04 与代码同窗。
① env 门 `external-sources.js:595`（parseSourceSelection）；快照 TTL 1h `:24,351`+stale-on-failure `:644-651`（allSettled，失败组不炸响应）；安装闸服务端强制 `server/routes/extensions.js:605-613`（confirm!==true→confirm-required，先于任何 fetch）；归一 `external-install.js:150`（原名校 origin_meta）；穿越拒绝 `external-sources.js:208-211`；更新链 `extensions.js:638,656`。
② `e2e/external-sources.spec.js`(10-21，21KB)、`test-external-install.mjs`(10-21)、`test-external-source-endpoints.mjs`(10-21)、`test-external-package.mjs`(10-15)、`test-external-sources.mjs`(10-14)。
③ undeployed=0。
④ n=5 f=0。
⑤ spec 11-04 vs 代码 11-03，剪刀差 1 天。

---

## 簇摘要

**三件最严重的事**：
1. **drag-drop-upload（D）spec 与实现双向脱节**：94 天未更新（全簇最陈旧），"不支持类型→415"实证为 422（`documents.js:165`→`server/routes/documents.js:56`，无任何 415 赋值点），"粘贴入文档"场景全仓无 onPaste 实现点——建议重新立项对齐或降格条款。
2. **ci-pipeline（C）验收腿连环失血**：60 天 33 修集中 windows/桌面/装机腿（三修、五轮全暗真凶、同台阶 env 两次踩坑），主门禁虽绿，验收轨是全仓最不稳定资产——建议腿基建固化（self-hosted runner 快照/夹具仓库化）。
3. **artifact-contract（B）remote fork 契约缩编**：`server/agent-session.js:671` 契约行未含 R2 新增的"save_to_library 同回合入库"教学（该教学只在 SKILL.md），远程 agent 与本地 persona 的产物契约出现版本裂缝，守卫测试（10-11）断言面未跟上。

**评级分布**：A×6（app-center、blueprint-trial-bounded-fire、builder-team-templates、crm-desk-bridge、crm-desk-embed、external-skill-sources）· B×7（app-navigation、artifact-contract、caller-preferences、crm-desk-pack、custom-presets、dependency-security、e2e-testing）· C×1（ci-pipeline）· D×1（drag-drop-upload）
