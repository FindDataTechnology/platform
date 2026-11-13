# 簇 G3 健康卡 — pack 全系 + market（13 模块）

审计人：G3 体检员 · 日期 2026-11-06 · paas HEAD `ae04f0b`（2026-11-06 02:45）
**实际在册清单**（`ls openspec/specs/ | grep -E '^(pack|market)'`）：`market-revenue-share / marketplace-cluster-view / pack-agent-scoping / pack-authoring / pack-bot-units / pack-category-line-mapping / pack-display-format / pack-domain-taxonomy / pack-installation / pack-locale-tracks / pack-marketplace / pack-usage-telemetry / pack-visibility` 共 13 条。
**③ 共同部署事实**：13 模块同宿 `fd-infra-deploy/all-services/prod/platform.yaml:57` 镜像 `sha-70a3620`（源 paas `dde77c3a`，2026-11-06 00:29；`git merge-base --is-ancestor dde77c3a HEAD` = 是，落后 6 提交——含未上产的 feat(supply-store) 38cb9fed）；facet 角色同镜像 `facet.yaml:66`；`facet-market-mcp.yaml:31`/`facet-ops-mcp.yaml:30` 镜像 `sha-0a2dba6`（源真 0174f3e，非本仓 sha，祖先律未证实）。

---

## 1. market-revenue-share — 评级 A-
**理由**：账本/装前闸/收益账三面全对齐、幂等键清晰、专测 15 例在册，唯一短板是生产侧 sub2api 结算链靠环境变量桥接曾断过一手。
① 对齐：append-only 成交记+幂等两键 `gateway/market.js:1-12`（createMarketStore :52、结算执行 :272、购买 :291、供应商收益 :385）；装前闸 402 `server/routes/packs.js:230-244`（purchased 投影 `gateway/packs.js:1900`）；部署者侧 host 结算 `gateway/packs.js:1295-1302`（表 :388）；sub2api 边界 `gateway/index.js:824-876`。
② 测试：`scripts/test-market-revenue-share.mjs`(10-31, 15 test)、`test-pack-sellability-gate.mjs`(10-29)、`test-vendor-supply-open.mjs`(10-28)——在册且新鲜。
③ 部署：同共同事实。
④ 痛感：market.js n=1 fix=0；routes/packs.js n=10 fix=2（低痛）。
⑤ 陈旧度：spec 10-28 vs market.js 10-28，剪刀差 0 天。

## 2. marketplace-cluster-view — 评级 B
**理由**：服务端 agent_count SQL 与前端 URL 滤链都在，但 agent 桶滤无任何专测钉住，且该滤链注释自曝已回归过一次同类病。
① 对齐：列表 SQL `json_array_length(v.manifest,'$.agents') AS agent_count` `gateway/packs.js:1018`（投影 :611-612）；桶滤+URL ?agents= `web/src/components/packs/PackMarketView.tsx:121-135`（桶定义 :20-22）；详情 cluster 区 `PackDetailDialog.tsx:747-748`。
② 测试：`scripts/test-cluster-platform.mjs`(10-20)；**e2e 中 agent 桶滤（?agents=2-3）未证实存在**（grep e2e/ agent_count/agents bucket = 0）。
③ 部署：同共同事实。
④ 痛感：宿文件 gateway/packs.js n=71 fix=15（共享计入，非本模块独担）。
⑤ 陈旧度：spec 10-22 vs 代码 11-03，剪刀差 12 天，新鲜。

## 3. pack-agent-scoping — 评级 A-
**理由**：scope 派生/focus 三族叠加/自检全落位，测试当日同写；宿文件 dsh-profile.js 与 fleet 深度共栖，痛感归属无法干净切分。
① 对齐：资源 scope 派生 `dsh-profile.js:1608`（scope 定义）+ :788（agentPreset 选 scope）+ :1084（focus 层三族）+ :2723（scope 自检）；persona 免 focus 组合 `server.js:640`；skills-patch 重写 `server.js:974`。
② 测试：`e2e/pack-agent-scoping.spec.js`(10-22)、`scripts/probe-pack-scope.mjs`——在册。
③ 部署：同共同事实。
④ 痛感：dsh-profile.js n=67（与 fleet 共享文件，fix 密度未证实可归因本模块）。
⑤ 陈旧度：spec 10-22 vs dsh-profile.js 11-05，剪刀差 14 天，新鲜。

## 4. pack-authoring — 评级 A
**理由**：草稿/预填/发布冻结/导出≠发布全链对齐，PACK_LIMITS 天花板走 packLimits(env) 读环境可覆盖（无硬编码腐化），测试三车道在册。
① 对齐：草稿存取 `pack-store.js:47-49`；preset→draft 迁移判断服务端单点 `preset-pack-bridge.js:1-14`；发布冻结+身份门 `gateway/packs.js:1666-1700`；天花板 `PACK_LIMITS` `lib/pack-manifest.js:42-58`（maxAgents 3→50 于 10-30 提额，`packLimits(env)` :123 可覆盖）。
② 测试：`e2e/packs.spec.js:240-499`（发布/资源声明/face 必填，11-03）、`e2e/preset-pack-bridge.spec.js`(10-22)、`e2e/pack-offline-authoring.spec.js`(10-29，导出≠发布)。
③ 部署：同共同事实。
④ 痛感：pack-store.js n=12 fix=2；preset-pack-bridge n=3 fix=0。
⑤ 陈旧度：spec 11-04 vs 代码 11-03，剪刀差 1 天。

## 5. pack-bot-units — 评级 B+
**理由**：bot 第三原语「行即占位」物化与禁用初生实现到位，但舰队衔接一条跨到 fleet-templates 域，本仓内未逐条核实。
① 对齐：bots 段物化为行、born disabled `pack-store.js:104-212`（:206 bots.reload、:212 awaiting credentials 如实口径）；上限 `PACK_LIMITS.maxBots=3` `lib/pack-manifest.js:55-58`。
② 测试：`scripts/test-bots.mjs`(11-01)、`e2e/bots-surface.spec.js`(10-11)。
③ 部署：同共同事实。
④ 痛感：pack-store.js n=12 fix=2（低）。
⑤ 陈旧度：spec 10-25 vs pack-store.js 11-01，剪刀差 7 天；舰队衔接条的 fleet 侧实现未证实。

## 6. pack-category-line-mapping — 评级 A
**理由**：零迁移纯投影小模块，实现即注释即 spec，专测在册，零 fix。
① 对齐：映射单文件 `lib/pack-category-lines.js:1-9`（存储零迁移、展示层归位）；分面按线全序渲染 `gateway/packs.js:1055-1070`（facets() lineSlugs 全集+零计数线也渲染）。
② 测试：`scripts/test-category-line-mapping.mjs`(10-31)。
③ 部署：同共同事实。
④ 痛感：n=3 fix=0。
⑤ 陈旧度：spec 11-04 vs 代码 11-03，剪刀差 1 天。

## 7. pack-display-format — 评级 A
**理由**：v2 显示字段/降级链/逐字节不变量四份专测同日钉住（11-03），badge 三轴合成单点纪律明确。
① 对齐：display_* SQL 投影 `gateway/packs.js:1024-1028`（identity/promise/audience/outcomes/examples）；overlay 键集 `lib/pack-manifest.js:519`；badge 结构轴派生 `lib/pack-badge.js:1-9`（两调用形状同 precedence，测试钉矩阵）；三轴合成 `lib/pack-provenance.js:1-16`。
② 测试：`scripts/test-pack-display-format.mjs`/`test-pack-display-identity.mjs`/`test-pack-display-projection.mjs`(均 11-03)、`test-pack-badge.mjs`(10-27)、`test-adoption-display.mjs`(10-31)。
③ 部署：同共同事实。
④ 痛感：pack-badge.js n=1 fix=0；pack-manifest.js n=34 fix=2。
⑤ 陈旧度：spec 11-04 vs 测试/代码 11-03，剪刀差 1 天。

## 8. pack-domain-taxonomy — 评级 A
**理由**：词表 env 覆盖单一真源、三态出口（合法/未归类/词表外阻发布）全对齐，e2e 中文工作台实测三条在册。
① 对齐：受控词表 env PACK_DOMAIN_TAXONOMY 单源 `lib/pack-taxonomy.js:187`；未归类显式出口 :126；域滤 SQL `gateway/packs.js:1004-1008`（json_each 精确匹配，不 derivation）；分面 declared order `gateway/packs.js:1075+`。
② 测试：`scripts/test-pack-taxonomy.mjs`(11-03)、`e2e/packs.spec.js:1113/1153/1195`（词表多选上限 3/词表外三态/422 分级聚焦）。
③ 部署：同共同事实。
④ 痛感：n=2 fix=0。
⑤ 陈旧度：spec 11-04 vs 代码 11-03，剪刀差 1 天。

## 9. pack-installation — 评级 A-
**理由**：一次物化/版本快照/冲突跳报/自凭证 MCP/装前闸全链齐，e2e 覆盖 7+ 场景；两笔 fix 均为生产实抓（部署互斥拧断 billing_key_ref）。
① 对齐：物化链+install report `pack-store.js:1-10, 183-212`；装前闸 402 `server/routes/packs.js:230-244`；UI 只投 {packId,version} `gateway/packs.js:710`（对应 e2e :710）；MCP 走订阅者自凭证 `pack-store.js:5-6` 头注。
② 测试：`scripts/test-pack-skill-install.mjs`(10-16)、`e2e/packs.spec.js:345/549/601/633/785/813`（物化/冲突跳报/卸载警告/自凭证/失败零写入/滚动兼容，11-03）。
③ 部署：同共同事实。
④ 痛感：pack-store.js n=12 fix=2；关键 fix `4dd46b2e`（pack 级部署互斥——并发双部署拧断 billing_key_ref）。
⑤ 陈旧度：spec 10-28 vs 代码 11-03，剪刀差 6 天。

## 10. pack-locale-tracks — 评级 A
**理由**：zh 唯一回落解析点单文件收口（与史实一致不做跨语回落），技能 title 轨已随 11-04 归档单合入；一笔生产缺陷 fix 已收。
① 对齐：解析唯一点 `lib/pack-locale.js:46-59`（resolveLocale + zh 唯一回落、无跨语链）；i18n 顶层叠加校验 `lib/pack-manifest.js:260, 571-578`；skills[].title 轨 `lib/pack-manifest.js:1414`；覆盖面 `lib/pack-locale-coverage.js`。
② 测试：`scripts/test-pack-locale.mjs`(11-01)、`test-pack-locale-validation.mjs`、`test-pack-mypacks-locale.mjs`(10-27)、`test-market-locale-refetch.mjs`(11-03)、`test-skill-display-annotations.mjs`(11-04)。
③ 部署：同共同事实。
④ 痛感：n=5 fix=2；`5fe497e2`（en 下列表/详情 tags 随 locale 投影——5.3 验证条款生产缺陷）。
⑤ 陈旧度：spec 11-04 vs 代码 11-04，剪刀差 0 天。

## 11. pack-marketplace — 评级 B
**理由**：三命门（tool_list 对象数组/按作者邮箱限速/同名闸 409）全部落位且有专测，spec 最新；但它是全平台痛感最高面——两条主文件两月内 34 刀 fix、多笔生产实抓，发布-部署链仍在补丁维稳。
① 对齐：同名闸 409 `facet/publish-gate.js:25-56`（listed/unlisted 均算、指名 upgrade path）+ 注册顺序前置 `facet/index.js:150-152`；按作者邮箱限速 429 `gateway/packs.js:1401,1483,1666`（validate 独立预算 :1685）；tool_list 对象数组非名字单 `registry-bridge.js:315-329`；registry 独立 facet 存储 `facet/index.js:24,90`；版本不可变 :782。
② 测试：`scripts/test-pack-marketplace.mjs`(10-11，全簇最老)、`test-pack-registry.mjs`(11-03)、`test-facet-publish-gate.mjs`(10-25)、`test-facet-marketplace-repo.mjs`(11-03)、`test-publish-rate-admin.mjs`(10-24)、`test-publish-tool-gate.mjs`(10-26)、`e2e/packs.spec.js`(11-03)。
③ 部署：同共同事实；MCP 侧 facet-market-mcp sha-0a2dba6 祖先律未证实（非本仓 sha）。
④ 痛感：gateway/packs.js n=71 fix=15 + facet/ n=70 fix=19（全簇最高）；生产实抓链：`ed35a849`(registry PUT 422)→`d3be46fb`(PUT→register 回落)→`fd1bbdc9`(path-to-regexp 404 首部署二弹)→`cf6c3115`(sub2api 派生邮箱碰撞)→`9491b474`(恢复上架单向写缺途，已修已归档)。
⑤ 陈旧度：spec 11-04 vs 代码 11-06（facet/），剪刀差 2 天。

## 12. pack-usage-telemetry — 评级 A
**理由**：每回合一行/失败隔离/循环修剪/ops 门四条全对齐且实现-测试-spec 同日生成，26 天零 fix——稳定非停滞。
① 对齐：每完成回合一行、失败隔离 `server/usage-telemetry.js:1-39`；180 天保留+日循环修剪（吸取 10-10 trace 事故）`:20,54`；表+索引 `db.js:572-582`；ops 门 503 未配/401 bearer `gateway/index.js:979-982`（跨 cell 只读聚合 :984-1000）。
② 测试：`scripts/test-pack-usage.mjs`(10-11)、`e2e/pack-usage.spec.js`(10-11)。
③ 部署：同共同事实。
④ 痛感：n=1 fix=0。
⑤ 陈旧度：spec 10-11 vs 代码 10-11，剪刀差 0 天。

## 13. pack-visibility — 评级 B+
**理由**：默认 public/owner-scoped/私有包隐身三条全落位且有 e2e；但它是全簇最老 spec（10-02），此后代码侧生长出的 visibility 翻转与 registry 组闸均不经本 spec 管辖——spec 疏于回看。
① 对齐：默认 public+迁移 `gateway/packs.js:249-255`；owner-scoped 隐身 `:675-681`（stranger 得市场 404）；author-or-admin 翻转 `:824-830`（add-facet-content-management，spec 主场不在本 spec）。
② 测试：`e2e/packs.spec.js:747`（private caller 视角+stranger not-found）；未证实有 visibility 专测脚本。
③ 部署：同共同事实。
④ 痛感：宿文件 gateway/packs.js n=71 fix=15（共享计入）。
⑤ 陈旧度：spec 10-02 vs 代码 11-03（按文件算剪刀差 32 天 >30 触发 stale 线；按可见性逻辑本身算未证实——翻转逻辑属另一 spec）。

---

## 簇摘要 — 三件最严重的事

1. **pack-marketplace 是全平台痛感最高面，发布-部署链靠补丁维稳**：gateway/packs.js（71 提交/15 fix）+ facet/（70 提交/19 fix）自 09-05 合计 34 刀 fix，全簇之冠；其中至少 5 笔是生产/上线探针实抓（ed35a849、d3be46fb、fd1bbdc9、cf6c3115、9491b474）。三命门虽已全落位且 spec 11-04 最新，但单文件 3538 行承载 registry+路由+物化+结算四方职责，fix 密度未见收敛趋势——建议拆分与回归护栏优先投入于此。
2. **marketplace-cluster-view 的 agent 桶滤是裸奔契约**：?agents= URL 滤链（PackMarketView.tsx:121-135）无任何 e2e/专测钉住（grep e2e/ 零命中），而该文件注释自曝同类「shell 无 Router 祖先」回归已于 2026-10-21 发生过一次——现只靠注释纪律守护。
3. **pack-visibility spec 触发 stale 线（32 天）且能力谱系外溢**：spec 自 10-02 未动（全簇最老），而 visibility 翻转（gateway/packs.js:824-830）、registry 组闸 fail-closed（carry-registry-visibility-through-bridge，已上产 sha-70a3620）等可见性行为散落在其它 change 名下——可见性真源分散，建议下次触碰该域时以本 spec 为轴收拢一次。
