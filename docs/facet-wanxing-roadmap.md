> 2026-11-05 注记：谦面轨道定位以 `docs/supply-domain-roadmap.md`（供给域伞文档）为准；本文历史记录保留。

# 谦面 × 萬星 产品路线图（双星计划）

> 2026-10-11 `/opsx:explore` 定案（同日修订：补消费象限与场景C——萬星对话车道已交付）。
> 2026-10-12 增补：M4 萬星用户面（用户自部署产品化）——北极星场景D + M4 段 + 待定三行。
> 2026-10-13 完善轮：全线出口判据对账（M0-M4+F1-F3）+ 工程欠账清单建账 +
> M5 开门营业立项 + 终态线（按信号立项）。三伞分工就此齐：本文（双星）+
> `docs/facet-market-roadmap.md`（谦面市场线，F1-F4）+ `docs/yizuo-platform-roadmap.md`
> （壹座端矩阵，Y 线）。
> 本文件是伞：只记共识、里程碑与依赖，
> 每个 change 的细节在其 openspec proposal 里。谦面市场线（F1-F4：货架厚度/
> 客户端一等公民/自部署→萬星漏斗/终态推进）已执行级细化，见 `docs/facet-market-roadmap.md`。
> 定位公式沿用已定论：
> 谦面 = Claude 插件分发形状 × PaaS 应用商店（托管+售卖）杂交；
> 萬星 = agents 执行层。壹座 = 底座与创作面。

## 北极星

- **谦面终态**：多 harness 的 packs 市场——pack 可直接接入各个 harness（dsh/Claude
  Code/Codex/Gemini CLI/zcode…）使用。**现阶段核心问题 = 供给内部使用**（已定）。
- **萬星终态**：agents 执行层，承载自主运行。
  - 场景A：客户配置目标 + 基础配置（模型/执行时间/最多成本）→ 萬星自主搜索并
    规划自动执行方案，长程任务排夜间执行降本。
  - 场景B：agent ↔ agent 通信——客户在壹座长期迭代 packs，数据存壹座云或柏讯，
    用户之间让 agents 互相交流，增加人类交流的深度和广度。
  - 场景C：部署一个 agent 给外界使用、带界面——访客打开分享页即可与 agent 对话
    （基座已由 fd-wanxing `add-agent-chat-lane` 交付，见消费象限；缺部署者自助化）。
  - 场景D（2026-10-12 增补，M4）：用户自助舰队——发现/筛选/集合/预配置/部署/观测
    全程自助，执行情况与目标完成进度直观可见（挑得准、配得好、看得清）。

## 结构：双星一底座，pack 是原子单位

```
                    +-----------------------------------+
                    |         壹座 (底座/创作面)          |
                    |  cell 交互 * 任务引擎 * 网关 * 计费  |
                    +----------------+------------------+
                             |                |
          创作+长期迭代 pack  |                |  人先用、打磨、实证
                             v                v
                 +-----------------+      +-----------------+
                 |    谦面 facet    |      |   萬星 wanxing  |
                 |   pack 供给面    |      |   agent 执行面  |
                 |  创作->策展->分发 |      |  自主*调度*预算  |
                 +--------+--------+      +--------+--------+
                          |                        |
            终态: 装进各 harness          场景A: 目标->计划->夜间自主跑
            [dsh/Claude/Codex/zcode]    场景B: agent <-> agent 通信
                          |                        |
                          +-----------+------------+
                                      v
                    数据面: 壹座云 / 柏讯 (connector-mt)
```

## 消费象限（对话车道补齐「公众×交互」格）

```
                      交互式                          自主/异步
                +---------------------------+-----------------------------+
  自己人(owner) | 壹座 cell 对话      [已上线] | 驻留+工作节奏+定时     [已上线] |
                +---------------------------+-----------------------------+
  公众(human)   | 萬星对话车道               | M2 场景A 延伸：agent 夜间干活 |
                | add-agent-chat-lane [已上线]| -> 晨报自动出现在它的公开页  |
                +---------------------------+-----------------------------+
  程序(agent)   | facade API/A2A      [已上线] | M2 场景A：planner 派发       |
                +---------------------------+-----------------------------+
```

- 对话车道（fd-wanxing `add-agent-chat-lane`，2026-10-10 归档，生产真扣款+幂等重放
  PROBE PASS）：访客对话页（ChatView）+ Logto 登录访客（chat 门免白名单、登录后
  回跳原页）+ 三层瀑布计费（平台补贴 → 部署者额度 → 绝不掏访客的钱；自带 key
  溢出桥走 /a2a）+ 主人记录面；访客按 tenant subject 派生稳定 caller id，复用
  API 车道 RPM/槽位/幂等机核。
- 四格填了三格，唯一空白 = M2 planner——消费面基建已跑在供给面前面，反过来印证
  70/30 节奏；且内部每做一个好 pack 立刻能变成带计费闭环的对外产品页，这是 M1
  内部供给最强的动机设计。

## 已定决策（不许重开）

| # | 决策 |
|---|---|
| 节奏 | **70/30**：M1 主线全给谦面内部供给，萬星只做 C5 + 观察 spider-heal；M2 再上场景A。除非出现外部客户催萬星执行能力的信号（如柏讯侧真实需求），才把 M1/M2 并行对调 |
| 主轴依赖一 | tool-scoping 是两星共同地基：pack 上下文经济学（161 工具≈3-8 万 token → pack 只带所需工具）既决定谦面供给密度，也决定萬星每回合成本 |
| 主轴依赖二 | C5 套餐（sub2api 虚拟用量）是场景A「最多成本」的对账前提（预算硬停 C1 只管体验不管计价） |
| 主轴依赖三 | 格式同源纪律保护多 harness 终态：出向桥已产 Claude 插件格式+五 target，多 harness = 保持双向兼容 + 逐 harness 补工具权限（上游 allowedTools），不推倒重来 |
| M1 重心 | 重垂直内容、轻通用市场功能（护城河 = 垂直内容 + 计费闭环，2026-10-07 已定论；竞争时钟：Anthropic 补托管运行/Coze 开放自部署会压中地带，压的是泛用市场想象，不伤垂直生意） |
| 供给顺序 | 先供后跑：谦面供给质量直接决定萬星自主的成本与成功率 |
| 访客档位 | 对话车道保持登录访客（身份 = 补贴瀑布记账锚）；匿名/微信扫码档仅数据证流失再开，开也是更严限额形态 |
| 内部范围 | M1 的内部 = finddata 自己人（含 creators org）；伙伴侧（柏讯/zihan）为第二波，触发 = 伙伴侧真实 pack/对话车道需求出现；M1 目录与权限形状预留伙伴可见性（设计约束），不建伙伴功能 |
| tool-scoping 五决策 | 2026-10-11 代拍：① 执行层做全（pack persona/自定义预设/用户级裁剪一处 bridge 实现，裁剪 UI 后置）② 未声明 tools = 兼容全量（guard 只拦声明者，发布门对未声明者警告，commercial surface 上限独立生效）③ 自部署 MCP 同名绑定正式化（对拍降级 warn）④ 上游 allowedTools 已递交（#9385）不阻塞，本地 bridge 先行 ⑤ virtual MCP 保留仅限产品级 SKU 窄用途，不做 pack 创作粒度——全部已随 add-mcp-tool-scoping 落地归档（2026-10-11，18/18） |
| M2 planner 形态 | 2026-10-11 立项定案：**agent 路线**——planner = 营运自营 pack agent（spider-heal 同型：persona+rhythm+预算+通知，部署在 runner），消费 MC 四期工具族（search_agents/delegate·progress·result/scheduling/bot_notify）拆解派发；**不建独立规划服务，不建外部 MC console**（mission-control-bridge 的外部控制台方向与 runner 部署模型相悖，console 侧从未成产品；四期的真身=工具族，消费即演进）。平台侧新增=任务定义面（facade 四元组+成本闸+console） |
| 多机 runner | 2026-10-11 用户拍板：**多机部署 agents + 相互协同 = 萬星蓝图硬前提**（不再是"等需求触发"）。落地=add-runner-fleet-sharding：descriptor `runner_id`+托管过滤（缺省归 cheap-1，存量零迁移）+机群表（agent_runners，env 种子）+deploy API 选址+第二台 runner（agent-runner-b@cheap-6，hostNetwork 8851+32）；协同面本就经 facade HTTP 中介（mission 派发/委派/A2A），跨机不变式=分片只改代理落点。扩容路径自此=加机器+机群表加行 || M4 套装分享边界 | 2026-10-12 M4③ 拍板：**含 suggestedConfig 透传**（{model?, budgetMinutes?, rhythm?} 向导同款三旋钮，按 agentId 直传 deploy 载荷、部署者可改、facet 唯一校验权威；须 agentId 命名作用域）。仅引用清单=退化子集。已随 add-deploy-collections 落地 |
| M4 目录热度口径 | 2026-10-12 M4② 拍板：**featured（策展优先档）+ turns7d（usage 台账 7 天双车道外部回合）双信号**；安装数不采用（无安装事件回流，不可测）。已随 add-catalog-facets 落地 |
| 谦面运营面 | 2026-10-12 用户裁定（修订 M1「轻通用市场功能」边界）：谦面内容管理 C 档全量建设——作者面（#/mine：列表/版本/下架/可见性/从清单发布）+策展（category/featured+策展板 #/curate）+观测（用量代理）。「服务垂直内容主线的运营面」不算通用市场功能；触发=功能集白屏事故（10-11 R4 路由钩子炸穿谦面壳）暴露共享面演进无谦面侧安全网，且 19 包四垂类在架无人能组织呈现。已随 add-facet-content-management 全链上线 |
| M1 出口口径 | 2026-10-13 实测定案：**全量口径**（对话遥测 ∪ 萬星 A2A 计费台账，验收/演示件剔除）≥5 即达，首测 8 达成；单口径（对话遥测 3）作对照；按月复测，探针 `scripts/probe-m1-weekly-active.mjs` 固化 |
| M4 试驾预调 | 2026-10-13 定案：维持后置不进里程碑——向导主体+绿地部署已实证、无用户信号催迫；M5.3 首批用户旅程若集中反馈再升切片 |

## 待定决策（挂账，定案即并入上表）

| # | 问题 | 影响 |
|---|---|---|
| pack 自带界面 | 长线开放线索（已升格市场线 F4.2 探索切片）：pack 清单声明前端、部署即挂载（带 UI 的 pack = mini-app 形态，谦面多 harness 的延伸）；做/不做/何时=F4.2 探索报告拍板 | 谦面终态演化方向 |
| 开门容量水位线数值 | 512MB 默认已上线；开门前按三 runner 实余量复核一次、是否上调——M5.2 开门动作的前置复核项 | M5 开门质量 |

## 里程碑

```
 M0 (现在~2周)       M1 (~1个月)         M2 (~2-3个月)        M3 (~3-6个月)        M4 (供给就绪后)      M5 (开门营业)
 谦面地基            内部供给闭环         萬星场景A            双星合流             萬星用户舰队         开放运营期
 ================   ================    ================    ================    ================    ================
 收口在途 change     官方功能集 x N 垂类   任务定义面           谦面: 多harness适配   部署向导+目录筛选    合规摸底(经营性/等保)
 tool-scoping 拍板   发布门+漂移防线      规划器              谦面: 外部创作者      集合(组织->套装->团队) 开门动作(拧开关+宣布)
 (上下文经济学)      内部用量遥测         夜间车道+晨报        萬星: agent社会      驾驶舱(观测产品化)   首批用户旅程(M4出口验收)
                    萬星: C5 套餐        mission 观测视图     萬星: 结算v2+数据面   开放前置(容量+身份门) 运营节奏+欠账清偿
```

### M0 — 谦面地基（现在 → ~2 周）

- 收口在途：add-mobile-app（13/18，尾巴多在真机）。**其余在途已全部收口归档
  （2026-10-11）**：add-onboarding-tutorial（12/12 上线）、simplify-ia-non-technical
  （上线 sha-6fa854c）、add-login-hero（11/11——prod loginHero 双语终稿+6.3 Playwright
  双栏实锤+platform-demo `loginHero:null` 降级实证三证齐）、add-wanxing-deployments-cache
  （7/7——生产分页/钳制/全量形状断言复跑）、R3 add-projects-automation-flow、
  R4 add-pack-tutorials-and-wizard（均上线）；publish-tool-gate-probe-degradation 前期已收。
  onboard-registry-argocd 为 proposal-only 存根（registry 走 compose 栈路线，与 ArgoCD
  相悖）留置。
- tool-scoping 五决策已拍板并**同日全链交付**：`add-mcp-tool-scoping` 归档
  2026-10-11（18/18，commit 7125cf9）——声明层/执行桥/本地绑定/发布双门/编辑器/
  e2e/finddata 侧 delta 全落。存量迁移同日完结（见 M1 内容线），不再挂账。
- allowedTools 上游提案**已递交**（dsh-mcp-client Discussions #9385，
  docs/upstream-issue-dsh-mcp-client-allowedTools.md）→ M0 只做跟进。
  **跟进完结同日**：argszero 发布 register-shadow 插件 + 我们把接缝内嵌进平台桥
  （`add-tool-scope-register-shadow` 9/9 归档，双代实证+生产矩阵树哨兵 3/3，
  镜像 sha-d986a12 全链含 runner 同滚）——执行桥升三层
  （guard+**shadow 注册期丢弃**+restrict 兜底），resync 不再回涨 roster；
  回帖 discussioncomment-18860857。上游落地 allowedTools 后影子换原生。

### M1 — 谦面内部供给闭环（~1 个月）：装得上、用得动、看得见

- 范围：finddata 自己人（见已定决策表「内部范围」）；目录/权限形状预留伙伴可见性
  （设计约束），不建伙伴功能。
- 创作线：facet-pack-builder 打磨 + 发布门对拍 tool_list 快照 fail + 漂移防线（guard 兜底）。
- 内容线：「数据研究·生态版」模式复制到 N 垂类——盘点（2026-10-11）：四垂类种子全部
  在架（法律=识律×6 + 老 demo×2；doc-studio=文档工坊 v2；daas=自助分析/指标工坊；
  爬虫自愈=spider-heal v7 private 自营+已部署 A2A）。**tool-scoping 迁移同日完成**：
  全部装机 pack 补齐 allowTools（自助分析 25/161、指标工坊 27/161、生态版 16+2+1、
  识律检索 8+8/32、spider-heal 1/1），五版全发、两 cell 装机升级、runner v7 重部署；
  fd-health-config 快照经 Mongo 直写补齐（tools:0→1）。
- 反馈线：内部用量遥测（哪个 pack 被谁用了多少回合）→ 供给决策有据
  （`add-pack-usage-telemetry` 全链上线 2026-10-11：sha-9859ac4，网关面聚合
  cells:2 实证、ops 台板块活；同日归档 e8af04a，spec 并入主 specs 125/125）。
  周活跃数字校准（≥5 是否合适）待有机流量积累。
- 运营线（2026-10-12 增补，见已定决策表「谦面运营面」）：谦面自有内容管理全量上线
  ——作者面/策展板/用量观测三面在谦面域闭环（add-facet-content-management）。
- 萬星侧只做一件：**C5 套餐**（add-serving-plans 已归档上线）；spider-heal rhythm
  持续观察（首个内部自主案例）。
- 出口判据：≥5 个内部 pack 周活跃（遥测已可测，待流量积累校准；
  **2026-10-13 首次实测（对话车道单口径）：7 天活跃 pack=2**（7 回合+3 回合各一）；
  **同夜复测**：① 同口径（对话遥测 weeklyActivePacks）：**3**——文本引擎·剧本经典 7
  回合 / 生意体检·内核 5 / 识律·法律检索 3；② 全量口径（对话遥测 ∪ 萬星 A2A 计费
  台账，剔除验收/演示件三只）：**8**——再加上文档工坊 22 回合（三调用者含外部
  p6e1…@paas.platform）/市场快讯 8（真实外部调用者）/数据-分析师 7/spider-heal 5/
  萬星 planner 3（平台自营 pack）。**全量口径 ≥5 达成；单口径 3 距 5 差 2**——复测
  探针 `scripts/probe-m1-weekly-active.mjs`（两车道+跨车道 slug 映射+caller 分解）
  可随时复跑；口径建议：按月复测以全量口径为主、单口径为对照，验收件不计）；后续按月复测；
  **tool-scoping 覆盖全部装机 pack ✅ 2026-10-11 达成**（6/6：五 scoped + 文档工坊
  无 MCP 面）。

### M2 — 萬星场景A：目标驱动的自主执行（~2-3 个月）

**2026-10-11 立项+①②同窗上线+④收尾**：planner 形态定案（已定决策表）；① `add-mission-definitions`
已归档（spec 并入 mission-definitions）+② `add-mission-planner-pack` 已归档——生产真 mission
e2e **两程 reported**（完整状态机+真报告+writeback 台账+spent 记账落账）；planner=`i262i0TUwtF9WSLeX12COw`
（runner :8801，rhythm 15m，notify=fd-ops）；④ `add-mission-board` 同日上线（observer 收
mission.* 事件族+board missions 段+console 任务小节——事件曾整批被白名单拒收，facade
reporter 重试梯在 observer 升级后自动补放积压）。**M2 出口判据首个样本已达成**。③ `add-mission-runner-attribution` 同日完结归档——
事实调研改写切片：sub2api 无时间窗路由（车道=组→账号映射+组 rate_multiplier，运维配置
经 agent-service-config 模型面即达，零代码）；代码缺口实为 runner 回合事件归属戳
（session+tokens，mission 派发回合可归属）+ planner v2 三律（每醒核窗/调查有界/report
前终态——生产实证：标语任务 90s reported 两步全 done）。**M2 四切片全数完结**：
①任务定义面 ②planner pack ③归属戳+v2 ④mission board。
（补记 2026-10-13：③ 的 tokens 半边当时实测恒 null——真因是 tokensOf 字段名错配，
已由 paas fix-turn-token-attribution 修复：dsh harness usage 是 camelCase 分列，
补分列求和后滚后实证 tokens:428。归属戳双字段自此全实。）

基建四期已齐（任务引擎/执行槽/委派/预算 C1/通知 C3/机群观测），缺三层新产品面：

- **任务定义面**（①）：goal + 模型 + 时间窗 + 成本上限 四元组成为一等公民（复用
  C1+C5+rhythm；facade 状态机+派发契约+成本闸+console 面）。
- **规划器**（②）：萬星 planner——搜谦面 pack/agent（search_agents 已有）→ 拆解计划 →
  人批或自动 → 派发任务引擎。
- **成本感知调度**（③）：夜间车道 = sub2api 降费引擎（模型车道 × 时间窗）+ 长程 checkpoint
  续跑（dsh resume 已有）+ 早晨报告（通知 C3 已有）+ runner 侧计量挂 mission 维度。
- 观测（④）：fleet board 加 mission 视图（目标→计划→成本→产物一屏）。
- 容量实测：**已实测收口（2026-10-11，观测式零压测）**——pod 硬顶 1536Mi 本代峰值
  **1530/1536MB（99.6%）**；dsh child 实测 RSS 新鲜 117-136MB、长会话重上下文
  480-540MB（规划数 64-96MB 仅 idle 成立，重载低估 1.4-5.6×），每 active child 另带
  ~55-60MB MCP sidecar；基座（gateway+cell servers）~770-870MB 与用户会话同 cgroup。
  **500 agent 闸门远非约束，内存才是**：现 pod 实际并发上限 ≈2-3 个新鲜 child 或
  1 重会话+1 新鲜，夜间批量并发=1。两缺陷已修：runner 记账幽灵（自发退出 child 无
  exit 钩子按 96MB 地板永计——记账点存活性自愈，paas 9f7e1e4）+ 限额错配
  （AGENT_RUNNER_RESIDENT_BUDGET_MB 3072>pod 1536Mi——GitOps 已改 512 对齐）。
  **规模化前置（结构决策）✅ 2026-10-13 已落**：serving runner 独立 deployment
  `agent-runner-serving`（4Gi/预算 3328，M4⑤ 行）——夜间车道容量使能器就位；registry
  多 runner 路由与 runner 自报名标签按预留直用（add-serving-runner-split）。
- 出口判据：一个真实内部 mission 从「一句话目标」到「夜间执行+晨报+成本对账」全链。
- **依赖 M1**：planner 派发的每一步都是 pack，pack 上下文经济性直接决定自主成功率。

### M3 — 双星合流（~3-6 个月）**2026-10-11 立项探索定切片**

地基事实（本日摸底）：**分享页今已在**——任何 public 部署即 chatable（补贴/部署者额度瀑布开着），
`https://wanxing.finddatatech.cloud/#/chat/<slug>` 即对话 URL；console 已有部署管理面
（列表/暂停恢复/配置/调用者）但**无部署触发**；部署需 serving 契约+billing key（部署者自己的
sub2api 键）；跨用户 allowlist 面（按 email 加调用者）已存在，差的只是友好化；connector-mt
（add-multi-tenancy）已在 finddata propose 4/4 待实施（伙伴触发）；结算 v2（分成/租金）纯设计。

切片：**①部署者自助流 ✅ 已上线**（fd-wanxing 4d80b51/a301e6a：selfservice 模块——
facet 转发身份通道（FACET_BASE_URL/FACET_INTERNAL_TOKEN+facet Service）+my/packs 作者
过滤+自助部署（billing key 必填、错误透传）+分享卡（URL/chatability/额度指引）+console
deploy-panel；镜像 8aa2ad9）→ **②目录发现+agent card 富化 ✅ 已上线**（paas
add-agent-card-examples 91d0f34/0c41ce3——manifest `serving.card.examples`（≤3 条、
≤200 字）校验+composeAgentCard+**注册载荷透传**（生产验证抓得：deployToRegistry 载荷
初版漏 examples）；fd-wanxing add-catalog-discovery e682d2f——a2a 卡/目录行 examples
透传+CatalogView 试问卡（可聊才可点、只读展示）+ChatView `?q=` 一次性预填；镜像
285cc37+facet 滚 79d8624；**注册处 fd-1.2.1 加 examples 模型字段**（PR#5 三构造点+
GET model_dump 自动带出，cheap-3 重建线——org 账单阻断 GHA image 期间的正路）；
planner v4 转公开+带试问示例（示例数据源））→ **③connector-mt 实施 ✅ 并行线完结**（finddata
open-connector-mt 六 change 全归档：multi-tenancy/service-PAT/deployment+三 UI 轮；线上
sha-b20f029 健康（401 租户鉴权墙实证）→ **④结算 v2 ADR ✅ 已落**
（ADR-0022：收入分成（非毛利）×（1−抽成 30% 旋钮）入 deployer_earnings 收益账、
adjustBalance add 幂等入账、闭环抵扣不提现、host/share 互斥、租金留 500 闸门后
（耗尽转 paused 不删））。**实施 `add-deployer-revenue-share` 全链上线+归档
2026-10-11**（fd-wanxing 2f19599+a95d94d；镜像 sha-23ba9e0=law-ai-official org
出片线——org+scs001 GHA 私有仓账单双阻断期用户定案的三级绕行）。**生产实证三证**：
admin（user1）→ aloadtree（user2）agent 真回合 earnings 0.07 落账（收入 0.1×70%，
settled，share: 幂等键入账）；自调零分成（earnings 无孪生行）；console
my/earnings 401/403 身份门。earnings 账本+纪元补账+deploy-panel 收益区全在产；
facade 47/47+全套件 118/118 绿。**M3 四切片至此全部完结且全上线**。
谦面多 harness 线：
allowedTools 上游 #9385 跟进+harness 适配按需。

- 谦面多 harness：五 target 出向已有 → 补各 harness 适配 + 技能双向兼容纪律 +
  allowedTools 落地；外部创作者开放（creators org/community 档已实证）。
- 萬星场景B（agent 社会）：用户自助从 pack 部署自己的 agent——具体故事 =
  **部署 → 得到可分享的对话页 URL**（对话车道已交付，console 管理动作已有，缺的
  只是部署者自助流；若柏讯侧有真实需求可提前，与「内部范围」挂账同触发器）→
  agent card 富化 + 目录发现（agent 名片 = 人类社交的代理）→ 跨用户 allowlist UX →
  数据面 connector-mt（open-connector fork，add-multi-tenancy 已 propose）接壹座云/柏讯 →
  结算 v2（跨用户分成/租金，ADR 延迟项）。访客档位维持登录（见已定决策表）。
- 出口判据：两个不同用户的 agent 互相调用、引用各自数据、完成结算。

### M4 — 萬星用户舰队：挑得准、配得好、看得清（供给就绪后 ~2-3 个月）**2026-10-12 `/opsx:explore` 定案；同日 ① 上线开工（①已完成）**

定位：M2（mission 引擎）+ M3（部署引擎/计费/分成）交付的是运营者视角的机器，M4 把
它们包成**用户视角的产品**——不懂运维的人从「发现 agent」到「看着它干活」全程自助。
与谦面市场线的交界：F3 漏斗（`docs/facet-market-roadmap.md`）把自部署供给导进官方生态，
M4 是漏斗落地端的体验面；F3.3 全旅程验收若早于 M4① 落地，走现有表单不阻塞。衔接
纪律：M1（内部供给）是供给前提（用户挑的货 = packs），M4 起步 = M1 出口后；70/30
不重开。

```
  ① 部署向导        ② 目录筛选          ③ 集合(三段式)       ④ 驾驶舱            ⑤ 开放前置
  pack 内勾选 agent   服务端 facets       a.组织分组(轻)       console IA 重构      runner 独立 dep
  模型/预算/节奏      垂类/标签/能力      b.可部署套装(中)     目标->计划->进度     (M2 挂账决策)
  可见性前移         谦面策展信号消费     c.团队语义(经        ->成本->产物一屏     容量水位线
  试驾预调(可选)     部署者挑货面         mission,不另建)      自主+mission 双视图  开放身份门
```

- **① 部署向导（配得好）✅ 2026-10-12 全链上线**：部署从 4 裸字段（packId/版本/计费键/通知通道）升级为
  分步交互，每个 knob 都有现成地基，纯前移 + deploy 载荷扩展、无新引擎——agent 勾选
  （前置半边 paas `add-deploy-agent-selection`：facet deploy 端点 `agents` 子集载荷+选中集
  计费语义，镜像 sha-770e402 三面滚；fd-wanxing `add-deploy-wizard`：facade 载荷转发扩展+
  my/packs modelWhitelist 富化+console 四步向导【选包→勾 agent→配置（模型/预算/节奏）→
  计费通知】+结果步可见性收尾【额度一键设置+allowlist caller 前移】，镜像 sha-b25f05a 双滚）。
  生产实证：双 agent pack 勾 1 部署（wx-alpha 上线、wx-beta 未动、记账 1 行、描述符
  model/budget/rhythm 全落）；模型车道拒收 verbatim 且配置保持；收尾面额度+caller 落账。
  试驾预调（部署前临时实例聊几轮调 persona）后置可选。
- **② 目录筛选与挑货面（挑得准）✅ 2026-10-12 全链上线**（fd-wanxing `add-catalog-facets`
  4defe8c+6b4be50，镜像 sha-31e264e 双滚；生产修复一轮=策展 join 误用原始 Response）：
  catalog 服务端 facets（q/category/featured 过滤在分页前+facets 汇总块计数未过滤集）；
  策展信号消费=条目带 category/featured（facet browse 60s join，unlisted/私有 pack 诚实
  降级无策展）+turns7d 活跃回流（自家 usage 台账双车道 7 天回合——**热度口径拍板**：
  featured 策展优先档+turns7d 真实外部使用，安装数无回流不采用）；console 向导「目录
  可部署」源（browse+detail+在役徽标）+foreign 公开 pack **绿地**部署（转发身份附
  creators 组=console 允许清单信任桥；在役 400 拒收=不接管他人在役部署）。生产实证：
  facets live（data/docs 两类+featured 1）、q=planner 服务端命中、文档工坊精选前置、
  turns7d 真回流（18/3/4/2）、外作者 pack 绿地部署成功进目录带 cat data、在役再部署
  400 指名作者路径。
- **③ 集合：三段式语义，一个数据模型 ✅ 2026-10-12 全链上线**（fd-wanxing
  `add-deploy-collections` 14acdbe+prop 修复 7aac97a，镜像 sha-d9c02c0 双滚）：
  `collection = {owner, name, entries:[{packId, agentId?, suggestedConfig?}], visibility}`
  一张表 JSON entries（≤20/去重/三键白名单）；a 组织分组=private；b 可部署套装=public
  +`#/bundle/:id` 公开分享页（匿名只读/登录后一键部署）+套装部署逐条 verdict
  （deployed/skipped-in-service/refused/error——在役跳过不阻断，facet 拒收透传）；
  c 团队语义**留门未建面**（mission/planner 仍是唯一协作通道）。**套装分享边界拍板**
  （已定决策表）：含 suggestedConfig 透传={model?,budgetMinutes?,rhythm?} 按向导同款
  直传 deploy 载荷、部署者可改、facet 唯一校验权威——仅引用清单是其退化子集。硬约束
  落 spec 文字（集合无调度/运行/监控）。生产实证：UI 三条目混编套装（own+suggested
  budget 15+foreign 在役+foreign 绿地）→分享链接匿名 200/bogus 404→一键部署三 verdict
  全中→wx-alpha 描述符 budget=15→分享页全渲染。
- **④ 驾驶舱（看得清）**：前置 console IA 重构 ✅ 2026-10-12（fd-wanxing
  `refactor-console-ia` 84d8535，web 单滚 sha-58a1f96）：1442 行单体瘦壳+四组件
  （FleetView/MissionsView/OpsView/DeployWizard）——「我的舰队/我的任务」+运维面
  三标签，testid 零丢失、「去配置」slug 深链契约保持（保留字 missions/ops 切标签）、
  按需加载；R4 教训（先骨架后可视化）落实。**④b 可视化 ✅ 2026-10-12**（fd-wanxing
  `add-cockpit-views` ea12d4a→归档 12c6b6c，sha-443c622 双滚）：facade
  `GET /console/fleet/summary`（store-only 单 SQL 条件聚合 turns7d/minutes30d/usd30d
  [waived 排除]+allowance 全量，registry 富化客户端 join）；舰队视图部署卡片四信号
  （健康/近7天回合/近30天分钟+结算/额度余量水位条+管理动作全保留）；任务视图列表
  成本水位条+详情步骤进度/成本双条+窗口剩余。生产实证：10 卡全渲染、高流量卡真实
  信号（doc-studio 18回合/17分/$1.70 与目录 turns7d 一致）、草稿任务条全出。
  **M4④ 驾驶舱整片完结**——体验标准达成：不读手册答「在干活吗/离目标多远/花了多少钱」。
- **⑤ 开放前置**：serving runner 独立 deployment ✅ 2026-10-13（add-serving-runner-split
  已上线归档）：cheap-1 裸 docker 形态退役 → k8s 专用 Deployment `agent-runner-serving`
  @cheap-4（4Gi Guaranteed/预算 3328MB/并发 5-6 vs 旧 2-3；GitOps 生命周期；与任务车道
  b/c 异故障域），接管波 101s 零手工迁 8 条目，计费+分成链经新 runner 复核 settled；
  **M2「规模化前置」结构决策就此闭环**。**开放前置两件工程件 ✅ 2026-10-13 全链上线**
  （paas `add-opening-gates`，sha-a39dd6b/镜像 sha-b1adfe8 双清单滚）——**澄清：开放动作
  （对外开门的产品决策）不需要先发生，这两件是开门前就该建好的门本身，默认全部为现行
  语义，开门只是拧开关**：① 身份门 `PACK_ACCESS_MODE`（closed 默认=creator 组门逐字节
  不变；open=任意登录用户可发布/部署，计费键经济闸仍在；facet whoami 暴露 accessMode，
  生产实证 closed）；② 容量水位线 `FLEET_CAPACITY_WATERLINE_MB`（默认 512MB）：新增
  child 的部署在最优 runner 余量低于水位时 503 FLEET_AT_CAPACITY 指名余量水位；在役
  pack 重部署/升级豁免（生产实证：market-flash-briefer 真实重部署 200 走豁免路径）；
  观测缺口降级开。**余 = 合规项（经营性增项/等保评估——域名备案已在案，缺的是
  经营面许可与等保定级）+ 开门动作本身（拧开关+宣布）→ 已立项为 M5 开门营业（见下）**。

闸：供给前提（M1 出口前不动工——没货的货架不做挑选面）；执行面唯一性（见③硬约束）；
IA 先行（可视化在重构之后，不在旧骨架上堆）；容量物理闸（⑤不拍板只能内部小规模）。

出口判据：内部出口 = 非运营角色的自己人零运维介入，目录筛选->集合->预配置->部署->
驾驶舱看进度与成本全程自助 ≥3 agents；终态出口 = 两个外部用户各自部署自己的套装、
互相对话/调用、双方成本对账清楚（场景B 的用户态升级版）。

### M5 — 开门营业（开放运营期）**2026-10-13 完善轮立项**

定位：M0-M4 交付的是「运营侧代跑、全部实证」的机器；M5 = 拧开关、迎来第一批真实
用户、把运营姿态从代跑换成自助。全线出口判据对账（见下节）的共同结论就是这一句：
**机制全通，真人未采**。

顺序与前提：合规摸底（5.1）先行——开门动作（5.2）不必等整改全部落地，但等评估给出
「可开门/需先整改」结论；首批用户旅程（5.3）开门后随即开跑，它同时是 M4 内部出口
判据的验收场。

| 切片 | 内容 | 出口 |
|---|---|---|
| 5.2 开门动作 | `PACK_ACCESS_MODE=open`（runbook=DEPLOY.md 拧开关配方表）+宣布渠道。开门即验三件：whoami accessMode=open、非 creator 一发一部署真实走通、水位线拒绝路径演练（临时调低 `FLEET_CAPACITY_WATERLINE_MB` 重现 503 后复位）。前置复核两件：水位线数值 vs 三 runner 实余量（待定决策表）、marketplace.json 收录口径接策展（K1 ✅ 已于 2026-10-13 提前完成） | 三验记录在案 |
| 5.1 合规摸底 | 经营性增项与等保评估：范围盘点（对外对话车道/计费/分成=经营面、数据出境面、日志留存、隐私政策与用户协议文案位）。域名备案已在（介绍页备案号在案），此处指经营性许可与等保定级。公司侧主导，工程侧供材料+落地整改。**工程侧材料 v0 已备 2026-10-13**（`docs/compliance-opening-assessment.md`） | 评估结论「可开门」或整改清零 |
| 5.3 首批用户旅程 | 邀 3-5 名非运营自己人（伙伴侧若触发一并）零运维介入全程自助：发现→筛选→集合→预配置→部署→驾驶舱看进度成本；断点即修（邀请与组织=用户行动项） | M4 内部出口判据兑现（≥3 agents 全程自助） |
| 5.4 运营节奏固化 | 遥测月报（`probe-m1-weekly-active` 按月、全量口径为主单口径对照）+策展 cadence（category/featured 维护纪律）+creator 准入阈值运营（community→creator 升档流程化） | 连续两个月月报在案 |
| 5.5 欠账清偿 | 工程欠账清单（见下节）逐项处置；K1 随 5.2 前置完成 | 清单清零或降级观察项 |

闸：合规结论先行；开门前水位线与 marketplace.json 收录口径双复核（把 Claude 原生
市场面从「全量公开包」收敛到「已策展」，与浏览面一致）；70/30 不重开——M5 是双星
合流的运营期，不是新工程周期。

出口判据：第一批外部/非运营用户在零运维介入下完成 发现→部署→对话→（可选）发布，
计费/分成真实发生，且无计费完整性事故（欠账清单相关项清零）。

## 出口判据对账（2026-10-13 完善轮，M0-M4 + F1-F3 全线审计）

对账方法：逐条按生产实证证据核状态；「◐」= 机制与样本已证、判据的完整形态未采。
壹座 Y 线（第三伞 `docs/yizuo-platform-roadmap.md`）不属本表记账范围，另行记账。

| 里程碑 | 出口判据 | 状态 | 证据 / 缺口 |
|---|---|---|---|
| M0 | 在途收口 + tool-scoping 拍板 | ✅ | 2026-10-11 全收口；add-mcp-tool-scoping 18/18 + register-shadow 三层桥 |
| M1 | ≥5 内部 pack 周活跃 | ✅ | 2026-10-13 全量口径实测 8（对话 3 ∪ A2A 计费 5，剔除验收/演示件）；口径已定（已定决策表）；按月复测=M5.4 |
| M2 | 一句话目标→夜间执行+晨报+成本对账全链 | ◐ | 首个样本已证（真 mission 两程 reported+spent 记账落账；v2 三律 90s 两步全 done）；夜间窗+晨报形态样本未采=K3 |
| M3 | 两个用户的 agent 互相调用、各引数据、完成结算 | ◐ | 单向已证（admin→aloadtree 真回合 earnings 0.07 settled+幂等）；双向互调+数据引用未采=K4（终态线承接） |
| M4 内部出口 | 非运营自己人零运维介入全程自助 ≥3 agents | ◐ | 全链各环生产实证（含 F3.3 五跳：自部署发布→回流→部署→外部调用者真回合→分成落账），但均为运营侧代跑；真人样本=M5.3 验收场 |
| M4 终态出口 | 两个外部用户各自部署套装、互相对话/调用、成本对账清楚 | 未采 | 开门后自然到来；场景B 深化线承接 |
| F1 | 匿名访客谦面域内自解释闭环 | ✅ | 出口四条全兑现（市场线文档 F1 节） |
| F2 | 五客户端实证+矩阵+update | ✅ | walkthrough/矩阵/update 全落地；npm 渠道=K2（渠道项非功能缺口） |
| F3 | 真实自部署者全链走通零运营介入 | ◐ | 五跳全通+案例卡为回归基线；严格口径的「真实自部署者」（非运营真人）同归 M5 采集 |

对账结论：九条判据四 ✅、四 ◐、一未采；四个 ◐ 的共同缺口都是「真人/真实形态样本」，
不是机制——这正是 M5 的立项依据。

## 工程欠账清单（2026-10-13 建账，跨阶段统一记账）

修毕即销账，定案即升切片。分工：各线文档的「挂账」段记产品决策，本表记工程欠账。

| # | 欠账 | 性质 | 出处 | 处置 |
|---|---|---|---|---|
| K1 | ~~marketplace.json 收录口径未接策展信号~~ | ✅ **已销账 2026-10-13**（`wire-marketplace-json-curation` 全链：真 sha-e279152/镜像 sha-5ccc968/GitOps 59b3b9b；生产实证 19/19 与 packs DB 策展集合逐 id 全等、未策展公开包树直链 200、非公开 404；白名单覆写语义保已设部署零变化） | 市场线 D5 | 见本行 |
| K2 | npm CLI 发布挂 org GHA 账单（v0.2.2 功能完备、v0.3.0 含发布桥在仓） | 渠道 | F2.3/F3.2 | 账单恢复即发（动作项非开发项） |
| K3 | ~~夜间形态样本~~ | ✅ **已构造 2026-10-26**（§15.53 补记二：夜巡 one-shot 04:46+08 准时 fire、160s 真回合、报告产物落盘、sub2api 计费对账——三要素齐） | M2 出口 | 见本行 |
| K4 | ~~双向互调样本~~ | ✅ **已构造 2026-10-26**（§15.53：fleet a2a 成员双向真回合 aloadtree↔p2walk1025，各引各的语料、各记部署者键成本；构造路障=调用者个人凭据/preset 归属/supervisor 边——三枚入坑册） | M3 出口 | 见本行 |
| K5 | 合规项（经营性增项/等保评估） | 开门前置 | M4 余 | M5.1（公司侧主导） |
| K6 | 免费车道 429（free 系上游限速） | 观察（已缓解：部署键改绑 openrouter paid 车道，运维记录在案） | F3.3 坑③ | 观察项；复发再议分流 |
| K7 | ~~SSO 自助开户键无组全废~~ | ✅ **已销账 2026-10-25**（§15.50：Logto 开注册+邮箱验证码注册实发；sub2api default_subscriptions=group3 3650 天，OIDC 首登 assignSubscriptions 既有路径自动挂组；残余=验证码送达率随首个真人注册确认） | M5.3 构造验收（§15.49） | 见本行 |
| K8 | ~~pack serving agent 部署单槽互顶~~ | ✅ **已销账 2026-10-26**（§15.52 add-deploy-tenancy：三元组记账+部署者地址段（作者/存量零变化）+归属管理；生产双部署者双真回合实证） | M5.3 构造验收（§15.49） | 见本行 |
| K9 | ~~registry /agent/ 通道新 agent 401+串包~~ | ✅ **已销账 2026-10-26**（§15.51：paas 部署层三修=proxy_pass_url 恒写/占用按物理主机归组/两遍法+fresh GET；四 agent /agent/ 全 200 零串包；registry 零改动） | M5.3 构造验收（§15.49） | 见本行 |
| K10 | ~~跨进程 SQLite 读抖动~~ | ✅ **改判销账 2026-10-26**：非产品缺陷——操作员 slug 笔误（fzxa→fzxza），404/miss/抖动全是笔误连锁（platform 读 12 探 0 miss 定案） | M5.3 构造验收（§15.49） | 见本行 |

销账记录：F3.3 验收挖出的「车道≠dsh 花名册静默空返且照常计费」已于 2026-10-13
五连环修复清偿——fd-wanxing fix-error-turn-billing + paas add-deploy-roster-gate /
add-config-roster-gate / fix-empty-turn-billing / fix-turn-token-attribution；生产复核
错回合 waived、tokens 真数值 428 在案（案例卡坑②）。K1 同日销账（见上表行）。
M5.1 工程侧材料 v0 已备（`docs/compliance-opening-assessment.md`——经营面/数据面/
出境面/日志留存盘点+待公司侧定夺五项，只供料不下结论）。

## 终态线（M5 后按信号立项，不预排期）

- **谦面多 harness 深化**：allowedTools 上游 #9385 落地→影子层换原生（F4.1 跟进）；
  pack 自带界面探索（F4.2）。触发=外部创作者/多客户端真实混合信号。
- **萬星场景B 深化（agent 社会）**：双向互调+各自数据引用+consent/数据边界的
  产品语义（全局闸 4 的题在此解）。触发=M5 首批用户出现互调需求（K4 样本随之采集）。
- **商业运营深化**：提现通道（现闭环抵扣不提现）、定价/套餐迭代、租金 500 闸门后
  评估。触发=分成收入规模信号。

## 全局闸与风险

1. **tool-scoping 是全局闸**（M0 必须定案，两星共同地基）。
2. **C5 是「成本上限」语义的闸**（只有硬停没有对账，场景A 不成立）。
3. **容量**：已实测（2026-10-11，见 M2 容量实测行）——内存是硬约束不是 500 闸门；
   夜跑规模化前置 = serving runner 独立 deployment ✅ 2026-10-13 已上线（M4⑤ 行）。
4. **场景B 信任面**：跨用户 agent 通信的 consent、数据边界（柏讯侧）是产品语义问题，
   M3 前想清楚，不是纯技术。（该题在终态线·场景B 深化首个切片内解。）
5. **竞争时钟**：见 M1 重心决策。

## 与既有 program / change 的关系

- wanxing-independence program（fd-wanxing，2026-10-04 收官）：工程结论（独立部署/
  观测面/wanxing-web）= M2/M3 的地基；本文档是其上的**产品层伞**。
- agent-platform program（2026-10-02 四切片完结上线）：驻留/节奏/委派/计费 = M2 地基。
- mission-control 四期（2026-10-01 完结）：任务引擎/执行槽/MC 桥 = M2 规划器的地基。
- ecosystem-bridge（2026-10-08 归档）：出向五 target/入向生态 = M3 多 harness 的地基。
- add-agent-chat-lane（fd-wanxing，2026-10-10 归档）：萬星对话车道 = 场景C 基座、
  M3 自助部署的直接地基（部署→分享页只差部署者自助流）。
- add-mcp-tool-scoping（2026-10-11 归档，18/18，commit 7125cf9）：工具白名单全链
  （声明/发布门/本地绑定/桥执行/编辑器/e2e/finddata delta）= 两星地基已落地。
- 壹座平台线（`docs/yizuo-platform-roadmap.md`，2026-10-13 立项）：多端矩阵+门户
  承载+用户创作闭环（Y4 会话→我的解决方案→发布为 pack 已通车）= 双星的呈现面与
  谦面供给的用户生成车道；资源冲突按「非技术用户旅程完整度」裁决（见该文档对齐节）。

## 硬依赖备忘

- tool-scoping → 一切 pack 密度与萬星自主回合成本。
- C5 → 「最多成本」对账语义。
- M1 → M2（planner 派发的每步是 pack）。
- connector-mt（open-connector-mt @ finddata）→ M3 数据面。
- tool-scoping 供给层（commercial surface）→ 公开 agent 的工具面上限（对话车道的安全面）。

## 多 harness 运行管理层（2026-10-14 用户定向；explore 待立项）

M3 已落「谦面多 harness」的**格式层**（pack 可接入各 harness：五 target 出向桥 +
allowedTools 纪律）。此定向把它推进到**运行层**：

- **谦面**：功能集兼容部署进主流 AI harness（不止 dsh）——格式层终态的运行侧延伸。
- **萬星**：agents 的运行管理层——监控与管理常驻（驻留 Agent 服务）与短期（工作槽）
  agents；运行底座不止 dsh，覆盖主流 AI harness；目标在壹座上顺利运行与管理数百个
  agents。
- 词汇表已落「Harness（代理运行骨架）」词条，萬星词条扩展运行管理层定义
  （CONTEXT.md，2026-10-14）。

前置与观察项：

1. `unify-dsh-generation`（0.2.0-rc.2 统一 + 剪枝 + 适配层 lint）——dsh 作为第一
   harness 的版本面清零，多 harness 抽象的地基；已 grill 定案（2026-10-14）。
2. 数百 agents 容量规划：每 dsh 子进程实测 64-96MB；runner 机群分片、serving runner
   独立化、温区机制为既有基建；独立 explore。
3. `dsh-api-session-controller`（0.2.0 新面，或可承接 11 个"改配置必重启"调用点）：
   unify 落地后独立探索。
