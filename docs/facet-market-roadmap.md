> 2026-11-05 注记：谦面轨道定位以 `docs/supply-domain-roadmap.md`（供给域伞文档）为准；本文历史记录保留。

# 谦面市场线 Roadmap（开店营业篇）

> 2026-10-12 `/opsx:explore` 定案。伞文档 = `docs/facet-wanxing-roadmap.md`（双星计划）；
> 本文是其**谦面轨道的执行级细化**：四个 Phase（F1-F4），每个切片 = 一个可 propose 的
> OpenSpec change。定位公式沿用已定论：谦面 = Claude 插件分发形状 × PaaS 应用商店
> （托管+售卖）杂交；壹座 = 第一公民客户端；萬星 = 执行层承接。
> 2026-10-13 完善轮：F4 终态推进立项（M5 窗并行，按信号启动）；D1-D5 挂账对账
> （四落地一待接线）；F3 验收缺陷已销账（记入伞文档工程欠账清单口径）。
> 同日补记：D5/K1 已由 `wire-marketplace-json-curation` 接线收口（见挂账表），五项全清。

## 北极星

**任何人在任何主流客户端，一条命令用上谦面的包；自部署者打磨好自己的谦面后，
被自然引导到萬星把包变成 7x24 agent。**

六项诉求（2026-10-12 原话归纳，本文的回答结构）：

1. 谦面承担 packs 市场的作用
2. 客户能在各主流客户端对接使用，壹座优先适配
3. 很好的文档，使用体验很好
4. packs 介绍充分，历史版本顺利保存
5. 平台提供的 skills 和 MCP 等基础设施有充分介绍
6. 自部署谦面后，引导用户去萬星把完善后的谦面部署成 agents

## 基线（已在产，不重规划）

| 能力 | 事实 | 出处 |
|---|---|---|
| 市场骨架 | 独立部署+匿名浏览+策展+用量代理+作者面 `#/mine` | add-pack-marketplace（09-29）、add-facet-platform（10-03）、add-facet-content-management（10-12） |
| 多客户端分发 | CLI 六 target（claude-code/cursor/zcode/codex/gemini-cli/workbuddy）+ CodeBuddy/WorkBuddy 兼容市场仓 + Claude 原生 `marketplace.json` 端点 + MCP OAuth 发现（零贴 key） | add-ecosystem-bridge（10-08）、add-workbuddy-mcp-lane / add-pack-marketplace-git-channel（10-30），specs: facet-editor-cli / ecosystem-access / pack-marketplace |
| 壹座优先 | 订阅→cell 一键安装、MCP 凭据已接线，天然第一公民 | specs: pack-marketplace / pack-installation |
| pack 教法 | manifest.guide 三步指南 + 示例提问 + 安装向导 | add-pack-tutorials-and-wizard（10-11） |
| 计费闭环 | 结算 v2 分成（收入×70%、幂等入账） | add-deployer-revenue-share（10-11） |
| 部署入口 | 托管谦面 detail 部署按钮 + 萬星 console 深链（`VITE_WANXING_CONSOLE_URL` 默认指生产） | add-deployer-self-service（10-09） |
| 自部署可行性 | OSS 快照已含 facet（`dist-opensource/platform/facet`）——漏斗钩子已随开源版发出 | paas-opensource-snapshot-pipeline |

## 差距（2026-10-12 摸底）

| 诉求 | 缺口 |
|---|---|
| 文档 | **谦面壳无文档面**（`#/docs` 不存在）：按客户端安装指南、MCP 接入指南、创作指南无处安放 |
| 历史版本 | detail 对外只展示最新版；**公开版本历史 UI 缺**（API 级 `/api/packs/{id}/versions/{v}` 已支持逐版取）；版本说明（changelog）字段缺 |
| 基建介绍 | `#/mcp` 只有卡片（名称/描述/端点/组）；每 server 深度页缺；**skills 目录无门面**（registry 152 技能只在壹座扩展市场可见）；「平台基建 vs 包内容」叙事缺 |
| 客户端体验 | 机制在，**实证不在**：五客户端「从零到装好」无验证背书，OAuth 零贴 key 路径未逐客户端验证 |
| 自部署→萬星 | **跨实例不通**：自部署者的 pack 在他自己的 store，现有部署通道走内部凭据转发，出集群即失效；OSS 构建里部署按钮在跨实例场景只会报错，无引导 |

## Phase 总览与依赖

```
 F1 货架厚度            F2 客户端一等公民         F3 自部署漏斗            F4 终态推进
 (M1 窗, ~2-3周)        (M2 窗, ~3-4周)           (M3 窗, ~4-6周)          (M5 窗并行,按信号)
 =================      =================         =================        =================
 版本历史公开化    ──>   五客户端实证 walkthrough   自部署引导（路线A）       allowedTools 影子换原生
 基建深度页+skills      支持矩阵+定期冒烟          跨实例发布桥             pack 自带界面探索
 #/docs 文档面           CLI update                真自部署者全旅程验收      垂类内容规模化
   │                        │                         │
   v                        v                         v
 谦面域内自解释闭环     每客户端"从零到装好"有背书   供给侧新来源+萬星执行收入
```

依赖：F1.1 → F2.3（update 要版本历史先在）；F1.3 → F2.1（文档面建位后才能填实证内容）；
F3 依赖 OSS 快照发布节奏与萬星容量（伞文档 M2 容量行）。
**F1 三片互不依赖，可即刻启动，不等 M0 尾巴（add-mobile-app 真机项）。**

## F1 — 货架厚度（~2-3 周，M1 窗）

主题：匿名访客在谦面域内**看懂、选对、装好、追溯**，全程不用问人。内部用户同受益
（M1 供给闭环用同一个市场）。

| 切片 | change | 内容 |
|---|---|---|
| F1.1 ✅ | `add-facet-version-history` | **已上线 2026-10-12**（sha-606d1ac=真 242acf7；双壳 dist+匿名版本列表+notes 三态生产实证）。detail 视图版本列表 + 逐版 manifest/skill 链接；manifest 可选版本说明字段（≤500 字，随版本不可变，发布门+安装路径同源校验）；`#/mine` 复用共享 PackVersionList 组件（三面同源不可漂移）；版本列表按 detail 可见性放行匿名 |
| F1.2 ✅ | `add-facet-infra-pages` | **已上线 2026-10-12**（sha-26e70a2=真 f080a29；生产三证：深度页工具面+来源许可证、skills 176 条/143 带来源、组门控 404）。`#/mcp` 升级：每 server 深度页（工具清单含描述/许可证/提供方/托管方式**如实**标注，无则「未标注」）+ skills 目录视图（来源 repository_url/作者/tags，生态与官方可辨，分页+搜索）+「平台基建 vs 包内容」叙事段；深度载荷按需加载 |
| F1.3 ✅ | `add-facet-docs-view` | **已上线 2026-10-12**（sha-34016d1=真 80db14a；生产三证：in-pod 11 探针全过、浏览器验收三块+壹座置顶+客户端切换+深度链接、公开仓指南可达）。`#/docs` 公开 tab：三块——安装（壹座置顶默认选中+五客户端 tab：命令/技能目录/MCP 配置文件/深度指南链接）/ MCP 接入（wgk-key 通用路径+OAuth 发现路径如实写依客户端支持）/ 创作 quickstart（三路径+发布纪律+深度链接）；事实单源防漂移（cliFacts 表=CLI target 表，单测全等断言）；新 `docs/creating-packs.md` 创作者指南随 OSS 快照发布 |

**出口判据**：匿名访客从发现包→在自有客户端装好全程不出谦面域；每个在列 server 有
深度页；任意包任意历史版本可视可取；`#/docs` 五语齐。
**F1 全片完结 2026-10-12**：出口四条全数兑现（F1.1 版本历史/F1.2 深度页+skills 目录/
F1.3 文档面），谦面域内自解释闭环成立。

**质量线**：新视图沿用 ErrorBoundary / hash 路由 / 诚实降级家法；e2e 哨兵覆盖新视图；
版本说明随版本不可变。

## F2 — 客户端一等公民（~3-4 周，M2 窗，可与萬星场景A 并行）

主题：机制已建，补**实证与背书**——每个客户端的体验不是文档想象，是验证过的。

| 切片 | change | 内容 |
|---|---|---|
| F2.1 | `add-facet-client-walkthroughs` | ✅ 2026-10-12（dcb761d+OSS d645590）：五客户端真环境 walkthrough——console 铸 wgk 键→connect 验活 0600→五 target install --write-mcp 技能+配置形状逐字节验证→wire initialize 200（fd-cn-report）；实证回填 docs/ecosystem/*.md+公开仓。三诚实边界入档：停用 server=405（fd-daas/fd-open-data location 当前注释，运维项）、设备流 facet-cli 未注册 IdP（粘贴键为可用路径）、双 Accept 要求 |
| F2.2 | `add-facet-client-matrix` | ✅ 2026-10-12（dd2506b，sha-5c99ea2 三面滚+OSS 34da38e）：逐格出处矩阵（深文档+#/docs 表[cliFacts 单源]+冒烟脚本生产 PASS 5/5；事实单测咬合能力表↔MCP_TARGETS） |
| F2.3 | `add-facet-cli-update` | ✅ 2026-10-12（dd2506b）：installed.json 记录+`facet update`（三态/零订阅副作用/v0.2.2）；**npm 发布挂账** org GHA 账单（仓库内 CLI 可用） |
| F2.4 | `add-marketplace-projection-fanout` | ✅ 2026-10-31（代码面）：**MCP Registry 公开发现**——`GET /api/mcp-registry.json` 把公开 server（`groups=[]`）投影为官方 `server.json`（schema `2025-12-11`，`name=io.github.FindDataTechnology/<server>`，`remotes[]` 免键无 headers），复用 `mcp-catalog.js` 的同一 `visibleTo` 闸（不写第二份规则）；`scripts/publish-mcp-registry.mjs` + `mcp-registry-publish.yml`（GitHub OIDC——组织 namespace 的唯一免费正路）。**代码与 dry-run 就绪，首个 server 上架待运营窗**（`mcp-publisher` 实际 publish 未执行，见 tasks 6.3） |
| F2.5 | `add-marketplace-projection-fanout` | ✅ 2026-10-31（形状面）：**技能市场可索引**——`facet-marketplace` / `fd-mcp-registry` / `fd-vertical-packs` 三个 PUBLIC 仓已是 skills.sh / SkillHub 可爬的标准形状（`SKILL.md` frontmatter + `.codebuddy-plugin/marketplace.json`），零 facet 侧适配代码。**登记与收录时间不可控**，验收仅锚定 `npx skills add` 可解析（见 tasks 3.3 / 6.4） |

**出口判据**：五客户端各有生产实证 walkthrough ✅；矩阵公开在 `#/docs` ✅；update 可用 ✅
（npm 渠道待 org 账单恢复——2026-10-12）。**F2 全片完结**（出口判据达成，npm 发行为
渠道恢复项非功能缺口）。

**质量线**：walkthrough 必须真环境录证（照 paas-release 的生产实证标准），不接受
文档想象。

## F3 — 自部署→萬星漏斗（~4-6 周，M3 窗）

主题：漏斗钩子已随 OSS 版发出（console 深链默认指生产），缺**跨实例这一段的承接**。

```
 自部署者（OSS: 壹座+谦面）          官方生态
 ┌────────────────┐   路线A桥    ┌─────────────────────────┐
 │ 自己的谦面打磨包 │ ──────────> │ 官方市场上架（community    │
 │ 部署按钮（跨实例  │  跨实例发布  │  注册→creator组→发布）    │
 │  降级为引导面板） │             │    │ 既有部署流原样复用     │
 └────────────────┘             │    v                     │
                                 │ 萬星部署→真计费→分成v2    │
                                 └─────────────────────────┘
```

| 切片 | change | 内容 |
|---|---|---|
| F3.1 | `add-selfhost-funnel-guidance` | ✅ 2026-10-13（5f9c37d，sha-5c9f532 三面滚+OSS f298100）：serving-status 探针（两向单测+生产双实例）+部署区引导面板（自部署=官方市场+创作指南双链/内部错误双隐藏/503 竞态同面板；官方路径零变化）+MineView 漏斗全链文案+空态创作指南。面板眼见实证（facet 壳同源市场+预启动 stub） |
| F3.2 | `add-facet-publish-bridge` | ✅ 2026-10-13（bd6c77b+5304bc5，sha-70b3b61 facet 面+OSS 815a191）：facet 配对面（pairing.js 三门+bindcode+withAppBearer 第三身份通道；模块第三次逐字复用）+CLI publish v0.3.0（本地清单/--from 跨实例拉存储 manifest→推官方；按需配对+每跑静默续登+token 零落盘+源id→官方id 映射续推；门全官方侧）。生产实证：本地第二实例双子包真 CLI 跨实例回流官方市场 v1→静默续登 v2、作者=配对账号、技能内容逐字搬运、下架清理干净。坑：Dockerfile facet 枚举拷贝漏 pairing.js 致首片崩启动（5304bc5 修） |
| F3.3 | `add-funnel-acceptance` | ✅ 2026-10-13（4dd46b2，sha-dadf3ea facet 面+OSS 随快照）：五跳生产全通——本地实例发布→CLI 回流官方（公开保留 ev5E51eth7e5McvyDrl9Rg）→萬星目录收录+部署（部署者键绑定）→外部调用者（73≠78）真回合 506 字固定版式速览（settled 1min×$0.10）→分成落账 share $0.07/回合×4（waived 负保护实证）。案例卡 docs/ecosystem/selfhost-funnel-case.md（五跳实录+四坑+诚实边界=回归基线）。**验收挖出真缺陷即修**：并发双部署拧断 billing_key_ref→packId 部署互斥（test-deploy-lock 2/2 无锁复现）。原挂账两只已销账（2026-10-13，伞文档欠账清单销账记录）：车道≠dsh 花名册静默空返且照常计费=五连环修复（fd-wanxing fix-error-turn-billing + paus add-deploy-roster-gate/add-config-roster-gate/fix-empty-turn-billing/fix-turn-token-attribution）；免费车道 429=改绑 openrouter paid 车道缓解（余观察=伞 K6）。 |

**出口判据**：一个真实自部署者全链走通，零运营手工介入。F3 三片全收口（2026-10-13）。

路线 B（manifest 直交萬星部署器）**挂账**，仅当 A 跑通后有真实需求再议。

## F4 — 终态推进（多 harness 与界面）**2026-10-13 完善轮立项；M5 窗并行，按信号启动**

主题：F1-F3 把「开店」做完了；F4 是谦面终态（任何人在任何主流客户端一条命令用上包）
的最后几块——上游能力就位后的收窄、pack 形态本身的下一次扩展、内容规模化成纪律。
不预排期：三片各有触发条件，信号到了再 propose。

| 切片 | change | 内容 |
|---|---|---|
| F4.1 | `swap-allowedtools-native`（跟进项） | #9385 上游落地后：register-shadow 三层桥收窄为 guard+restrict（影子层退役），resync 回归验证；每季冒烟矩阵已在 `#/docs` 固化。触发=上游发版 |
| F4.2 | `explore-pack-ui` | pack 自带界面（伞文档挂账升格）：manifest 声明前端→部署即挂载（带 UI 的 pack=mini-app 形态）。先 explore 定三边界——安全模型（沙箱面）、与萬星对话车道的关系、部署时的 UI 承载——再 propose。触发=M5 后多客户端真实混合信号 |
| F4.3 | `scale-vertical-content` | 垂类内容规模化（M1 内容线延续，与伞 M5.4 运营节奏合流）：生态版模式复制纪律——模板化生产、策展标准（category+featured 维护）、用量回流月评（turns7d）；并接壹座 Y4 用户生成车道（会话→我的解决方案→发布为 pack 已通车）做供给双轮 |

**出口判据**：F4.1=影子层退役且 resync 不回涨；F4.2=探索报告+做/不做/何时拍板；
F4.3=策展纪律+月评连续两个月在案。

**质量线**：F4.2 探索不预设结论（做/不做都算出口）；F4.3 内容生产仍走
「垂类归类→策展→用量回流」既有纪律，不另建流程。

## 挂账决策（定案即并入切片执行，重要者升伞文档）

| # | 问题 | 状态（2026-10-13 完善轮对账） |
|---|---|---|
| D1 | 漏斗路线 | ✅ 已定 **A** 并落地（F3.2 发布桥+配对面）；路线 B 维持挂账（A 跑通后真实需求再议） |
| D2 | 版本说明字段 | ✅ 已落地（F1.1：manifest `notes` ≤500 字、随版本不可变） |
| D3 | `#/docs` 家法 | ✅ 已落地（F1.3：壳内静态五语 + OSS 仓深度文档，双层） |
| D4 | CLI update 语义 | ✅ 已落地（F2.3：=重取最新快照，模型与订阅语义都不动） |
| D5 | marketplace.json 收录 | ✅ 已接线（2026-10-13 `wire-marketplace-json-curation`，真 sha-e279152/镜像 sha-5ccc968）：默认=公开∧¬unlisted∧（category∨featured）与浏览面一致；`FACET_MARKETPLACE_PACK_IDS` 白名单升为覆写语义（已设零变化）；未策展公开包插件树直链仍可取；生产实证 19/19 全等 |

## 与伞的对齐

- 不推翻 70/30 节奏：F1 本质是 M1「谦面运营面」裁定（2026-10-12）的自然延伸——
  内容厚度服务垂直主线，不算泛用市场功能；F2/F3 分别骑 M2/M3 窗。
- F1 与 M1 内容线（垂类扩容）互不阻塞：内容线管「架上有什么」，F1 管「货架本身」。
- F4 骑 M5 窗（开门营业期并行、按信号启动），与伞文档「终态线」对齐。
- 壹座 Y 线（第三伞 `docs/yizuo-platform-roadmap.md`）交界：Y4 创作闭环的
  「发布为 pack」已通车 = 谦面供给的用户生成车道（F4.3 供给双轮之一）。
- 推进节奏：每片按 propose → implement → archive 家法走；切片完成时在本文标记
  ✅ + change 出处（照伞文档 M2/M3 的标注体例）。

## 风险与闸

1. **文档维护成本**：五语×多页必须靠 `check-locales.js` 门 + 「事实可验证、不写计数」
   家法防漂移撒谎——文档面一旦失信，市场面全损。
2. **F3 容量依赖**：萬星执行侧内存是硬约束（伞文档 M2 容量实测行）；自部署者涌入前
   serving runner 独立 deployment 的结构决策需已落。
3. **自部署者身份桥**：沿 community 自助通道（已实证）；创作者组准入阈值是运营闸，
   开太宽伤货架质量，开太窄漏斗干涸。
4. **版本历史存储**：逐版不可变已有语义保证，UI 化后注意 detail 默认载荷体积
   （版本列表懒加载，不随包体膨胀）。
