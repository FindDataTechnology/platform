# 壹座平台 Roadmap（多端执行平台篇）

> 2026-10-13 `/opsx:explore` 定案（2026-10-12 首轮定位展开的续集，三形状问题本轮全关）。
> 本文是壹座**自己的**单一事实源：多端矩阵、产品线承载、非技术用户旅程。
> 与既有双文档的分工：伞文档 `docs/facet-wanxing-roadmap.md` 管谦面×萬星产品计划；
> `docs/facet-market-roadmap.md` 管谦面市场线；本文管壹座端矩阵+承载面+用户旅程。
> 交界处（谦面 pack 在壹座运行、萬星群蜂被壹座承载）互相引用，不重复规划。

## 北极星

**壹座 = 寻数五线的多端 agents 执行平台 + 统一门户。**

- 多端矩阵：windows / mac / web / android / ios / 微信小程序。web 与电脑端是**承载
  所有寻数产品线的执行平台**（识律、柏讯、谦面、萬星、萬星 connector），深度融合，
  且具备完整的 AI harness 系统功能；移动端是**远程指挥面**——安排任务、监控执行、
  简单对话、查看关键信息（对话/产出文档）、分享。
- 目标用户：**不太擅长技术的文本和数据处理人员**。他们在壹座上长期迭代自己的 AI
  系统，形成独属于自己的文本和数据 AI 解决方案，并便捷地分享/使用别人的解决方案。
- 谦面的 pack 资源与萬星的群蜂模式都运行在壹座上；柏讯和识律的产品也顺利可用。

## 多端矩阵与职责

| 端 | 形态 | 职责 | 现状 |
|---|---|---|---|
| web | platform.finddatatech.cloud | 承载平台主场：harness 全功能+五线门户 | ✅ 在产（多租户 cells） |
| windows/mac | dsh 桌面壳 | 承载平台桌面形态（同 web 职责） | ✅ v1.3.8 已收 |
| android/ios | Expo/RN app（app/） | **远程指挥+简单对话**：安排任务、监控执行、查看、分享 | 🔄 add-mobile-app 14/16（真机尾巴） |
| 微信小程序 | miniapp | 移动轻量入口（对话/任务/资源/分享） | ✅ 0.6.x 提审多轮 |

移动端纪律（2026-10-13 定案）：**只做远程指挥和简单对话，不做完整执行环境**——
执行永远落在 web/电脑端/云端 cell；移动端价值 = 随时安排任务、看任务在干活、
收通知、看产出、分享。

## 五线全景（2026-10-13 调研实证）

```
                    ┌──────────────────────────────┐
                    │        壹座（本座）            │
                    │  统一 IdP(Logto)·计费·网关     │
                    │  cell 执行层·任务引擎·harness  │
                    └──────────┬───────────────────┘
        ┌──────────────┬───────┴────┬───────────────┐
   识律 lex          柏讯 wire      谦面 facet      萬星 wanxing
   lex.finddata…    wire.finddata… facet.finddata… wanxing.finddata…
   法律数据·应用·模型 B2B 数据中台    pack 市场供给面   agent 执行层
   四入口(官网/       三入口(官网/    介绍页 LIVE      介绍页 LIVE
   console/admin/API) console/mcp)   +#/docs+市场    +console+chat
   官网=占位页        官网=骨架       （独立 deployment，见伞文档/市场线文档）
   检索本体=          企业租户=
   fd-legal-search-  壹座 cell
   mcp(MCP 服务)     (ADR-0002)
```

关键事实：

- **深度融合已在架构层成立**：柏讯 ADR-0002 定案「企业 cell = 壹座 cell」——柏讯的
  企业租户就是壹座 cell；识律检索本体是 MCP 服务（谦面识律 pack×6 即消费它）；
  谦面 pack 经订阅一键装 cell。执行承载不是待建，是待**呈现**。
- **身份统一已成立**：五线统一 IdP（Logto 同租户），用户不重复注册；授权直通 =
  同租户 SSO 跳转即登录，无新建身份工作。
- **呈现层缺口**：识律/柏讯官网为占位/骨架；壹座 web `/` 直跳 `/chat`，无发现面。

## AI 操作面（五线操作 MCP）——2026-10-13 explore 定案

**目标：壹座里的 agent 能直接操作各产品条线**（发布、建需求单、部署、检索、
管理），并配 skills/手册让 AI 高效使用各线软件。探索结论：轨道已建成约八成，
缺的是各线动作 MCP 与知识层。

盘点实态（2026-10-13 探索实证）：

| 线 | 操作面资产 | 缺口 |
|---|---|---|
| 谦面 | registry API+publish 桥（F3.2 刚收口） | 动作 MCP + skills（facet-pack-builder 为手册底稿） |
| 萬星 | serving API 三路由（A2A+允许清单+usage，ADR-0014） | 薄 wanxing-mcp + 工单动词手册（SUBMIT/STATUS） |
| 识律 | 检索 MCP 10 工具（全只读）；law-bench 52 工具含大量写 | 主要缺 skills/手册（内容层），工具基本在 |
| 柏讯 | fd-wire-api ~126 路由（需求单/萬星分派/市场/pipelines） | **无 MCP**，wire 入口未在 MCP-REGISTRY 在册 |
| 连接器 | open-connector-mt 生产在跑：/v1/actions 真写 + 5 元 MCP 工具（get_action_guide=手册即工具）+ 壹座凭据注入轨道全链 | 基本不缺，做策展 |

**统一形状：每线一个操作 pack** = {各线动作 MCP 接线 + skills（playbook）+
手册（AI 可读、事实单源在各线仓）+ 凭据 ref（各线 key 类型接进 credential-refs，
复用粘贴即连接+探活+401 翻面整套)}——识律 pack×6 已验证此模式。
工具形状分两型：调用型（发布/建单/管理）常规命名工具 1:1 包 REST；
对话型（萬星 A2A 长活流式）薄专用 MCP，不塞调用型框架。
连接器双定位：外部 SaaS 动作总线（1000+ provider）+ 全线凭据注入地基。

**接入规约（各线自包 MCP 的对齐清单，壹座侧产出；已落盘 finddata
`LINES-MCP-CONFORMANCE.md`，含 credential-refs 五件套契约与各线 key 形状）**：①鉴权=Bearer 各线
自有 key 且必须接受用户级 key（壹座注入）；②可探活（health 或 initialize，
401→ref 翻面）；③tool-surface.json commercial/internal 分面台账（识律/
law-bench 既有实践为种子）；④工具命名动词_名词+线前缀、写操作显式；
⑤每工具带指南（连接器 get_action_guide 为样板）；⑥MCP-REGISTRY 登记
（台账先行；wire 域名入口已于 2026-10-13 补登记 §1.2）。

**切片顺序**：C0 共轨（credential-refs 泛化各线 key + wire 台账注册）✅ →
C1 谦面（动作面最小+publish 桥现成+吃狗粮）✅（含 C1.1 市场面+凭据 ref，2026-10-14 全收口）→
C2 萬星（八工具双凭据分型，wanxing-ops-mcp @31895）✅ 2026-10-15 生产上线 →
C3 柏讯（十工具：需求单+数据面读+市场订阅，wire-ops-mcp @31896，双轨鉴权透传）✅ 2026-10-15 生产上线；C3.1 挂账 wire-customer 凭据 ref →
C4 识律（lex-ops-mcp @31897：全景导览+账户四+凭据三；检索面/套件面早已在产——C4 补的是"操作识律"的口子）✅ 2026-10-15 生产上线。

**五线 AI 操作面 2026-10-15 全线收官**：壹座里的 agent 至此可以操作谦面（网关目录+市场发布）、
萬星（舰队目录+回合+部署者管理）、柏讯（需求单+数据读+市场订阅）、识律（账户+凭据+全景导览）、
萬星·连接器（外部 SaaS 动作总线，早就在产）。凭据轨道三 ref 在产（registry/connector/facet-market），
wire-customer/lex/wanxing-caller ref 按需补（各线粘贴 ID token/caller key 路径已可用）。

**进度（2026-10-13 当日）**：C0 ✅（规约落盘 `LINES-MCP-CONFORMANCE.md`+wire 域名
入口台账补登记 §1.2；credential-refs 本就是泛化形状零改码）。C1 主体 ✅ 生产上线
（openspec change `facet-ops-mcp`：六工具薄包 registry 网关 AgentCard 面，用户委托
鉴权全链，fd-prod NodePort 31892，生产 e2e 真数据返回；镜像 law-ai-official 出片线）；
C1 余=操作 pack 发布+cell 装包验收（CLI 配对需用户浏览器动作）。**C1.1 市场面**：
A ✅ 生产上线（同镜像 FACE=market，NodePort 31893，六工具含头牌 facet_market_pack_publish；
探针=/api/app/devices——/api/packs 匿名读不可用）；B ✅ 代码落地（paas change
`add-facet-market-credentials` 14648b5：Ed25519 设备密钥+静默挑战续登注入、
pair-by-绑定码路由+面板、pack-store ref 数据驱动、14 测全绿）——余=三滚部署
（标准出片线）+用户配对验收（面板 6 位码）+操作 pack 发布。

**C3 柏讯动作面 · 模拟交易凭据轨 ✅ 生产上线（2026-10-15，paas change
`add-paper-trading-credentials` d161053，镜像 sha-46999e1 五清单同滚）**：第四条
credential-refs 轨 `paper-trading`（paste 形最简实例——fdt_ 长命 token 不过期、
无设备配对、无续登；db v29 单槽表；路由三端点含 fdt_ 形状门+advisory 探活唯 401
硬拒；面板五语一次做齐）。实施中另修**第二个安装分派点**：市场卡片安装路径
（routes/extensions）原硬编码判 registry 凭据并 stamp `credentialRef:"registry"`
——装 fd-paper-trading 条目会把 registry 市场 token 注入柏讯服务（跨服务错投）；
分派函数上移 credential-refs.js（两个安装路径共用）。生产等价实证：双 fdt_ token
服务级隔离（A 见 1 账户/B 见 0）+注入链真调 200+吊销→401→翻面 fail-closed 省略+
测试 token 全清理。余=真人浏览器 paste→装包眼见（方式 B 用户体验）。
对方侧：registry 条目 metadata 已挂+pack `DydB2cal` 已发布（finddata
`paper-trading-facet-pack` change；handoff `reports/paas-handoff-credential-ref.md`
四件活已全数落地）。**注**：pack manifest `requiredGroup: "wire-customers"` 组门在
对方侧——壹座用户装包前需被授该组（跨系统依赖，未验）。

## 已定决策（不许重开）

| # | 决策 | 出处 |
|---|---|---|
| 移动端职责 | 远程指挥 + 简单对话，不做完整执行环境 | 2026-10-12 定，2026-10-13 细化=安排任务+监控任务执行 |
| 融合档位 | **项目联邦，不是融化**：各产品线保持独立项目身份（有自己的官网、在其他地方也能直接用）；壹座做门户+承载层，不做功能融化 | 2026-10-12 定 |
| 身份 | 统一 IdP（Logto 同租户）零重复注册；壹座内授权登录即直通各线核心功能 | 2026-10-13 定 |
| 门户形态 | 壹座应用中心 = 五线项目卡片（介绍+直达），介绍内容归各线自己（官网/intro 页），壹座不复制内容只聚合入口 | 2026-10-13 定 |
| 运维面 | 各产品线独立部署独立滚版不推翻；融合只发生在体验层 | 2026-10-12 定 |
| 操作 MCP 归属 | **各产品线自包自己的动作 MCP**（REST 契约+工具封装归线，最懂自己的面）；壹座不做统一包装层（担心遗漏），改产出「接入规约」清单 | 2026-10-13 定（本页 AI 操作面节） |
| 聚合呈现 | 各线 MCP 以 registry 条目/virtual MCP 呈现，形状自由；virtual MCP 用途=产品级聚合（与 tool-scoping 决策⑤的保留用途一致，非重开） | 2026-10-13 定 |
| 壹座职责边界 | 凭据注入轨道（credential-refs 泛化各线 key）+台账/scope 门/计费轨道+skills/手册策展（操作 pack 内容层）；连接器=外部 SaaS 动作总线+凭据地基 | 2026-10-13 定 |

## 现成地基（探索实证，勿重建）

| 愿景要件 | 已有资产 |
|---|---|
| 第三方项目承载 | 壹座 web `/external/:appId`：同源 iframe + 服务端代理注入 token（密钥不落前端），agents.json external-service 目录注册，现嵌 NEW API；注释原话 "we embed, not reimplement" |
| 介绍页基建 | 谦面/萬星 intro 页三仓三 change 已 LIVE（2026-10-05） |
| 统一身份 | Logto 同租户：壹座/谦面/萬星已接（萬星 chat 门 Logto 登录访客已实证 SSO 形态） |
| 指挥引擎 | 任务引擎+cron+mission 状态机+bot_notify 通知（C3）+`/api/app/*` 设备配对端点+capabilities 通告——移动端指挥面的服务端全在 |
| 嵌入降级 | iframe blocked 自动降级"新开标签"（EmbeddedFrame 已实现） |

## 里程碑（Y 线）

```
 Y1 应用中心        Y2 端矩阵收口       Y3 移动端指挥面      Y4 用户创作闭环
 门户发现面          app v1 真机尾巴     任务安排+任务监控     会话→我的解决方案
 五线卡片+直达       （并行收口）        +通知+产出查看       →复用/分享
 SSO 直通验证
```

- **Y1 应用中心（呈现层）✅ 2026-10-13 全链上线**（add-app-center 归档；镜像 sha-b5f7dc5
  双清单滚，GitOps f087a4d）：壹座 web「应用」导航 `/apps`——五线卡片（壹座 self/谦面·萬星
  live/识律·柏讯 early 如实徽标）+平台应用区（external-service 目录聚合，空则隐藏）；
  单源 appCatalog.ts+五语；in-pod 实证 chunk 在位+/api/catalog 门正常+Logto issuer 同域。
  **生产眼见 ✅ 2026-10-13 用户验收**：五卡渲染正确（截图在案）+谦面/萬星双线
  SSO 直通（点击「打开」新页面均免重登）。识律/柏讯官网填充后徽标转 live。
  **Y1 至此全项闭环。**
- **Y2 端矩阵收口**：add-mobile-app 真机尾巴（14/16）——**全部待用户行动项**（Apple
  Developer Program 付费决策+真机在手侧载 CI APK），不挡 Y3。
- **Y3 移动端指挥面**：app/小程序的任务安排（cron/mission 下发 UI）+任务监控
  （状态/进度/成本水位，复用 M4④ 驾驶舱的信号面）+通知消费（bot_notify 已有）+
  产出文档查看。服务端零新建（原判），实施时细化为两片：**第一片=MP 指挥台
  ✅ 2026-10-13 上线归档**（add-mp-command-center，sha-f1da0ed：command-summary
  聚合端点+三区页[待答问询→会话深链/任务异常→任务页/近期完成]+抽屉入口；
  单测 4/4+构建绿+生产端点实证；MP 页面眼见随下个提审窗；实施中改判=cron 新建
  表单已既有无需重做）；**第二片=通知触达闭环**（微信订阅消息直达对应会话/任务
  ——依赖模板申请=用户行动项，挂账）。萬星舰队维度（跨域信号）留 v2。
- **Y4 用户创作闭环**：非技术用户「在对话里调教出好用法 → 沉淀为我的解决方案
  （pack 容器）→ 一键复用/分享给别人」。**第一刀 ✅ 2026-10-13 上线归档**
  （add-session-to-preset，sha-8e1516b：会话菜单「存为我的方案」提炼向导
  [名称/persona 按 catalog 预填+示例提问从会话勾选]+CustomPreset examples 字段
  全链[校验/迁移 v26/编辑器]+桥透传 serving.card.examples[发布后试问卡带作者
  真实问题]；单测 8/8+e2e 2/2——e2e 抓出菜单 deps 真 bug 已修）。**第二刀 ✅ 同日上线
  归档**（add-solution-iterate，sha-d7b3436：向导双模式——「更新已有」把本次会话调教
  覆盖所选方案的 persona+示例提问、技能组合保持不动边界明示；捎带修复 dialog 被
  backdrop-blur 劫持 fixed 定位的用户级 bug=ui/dialog portal 到 body，全量 e2e 回归
  395 过 0 败）。后续刀口（迭代更新已有方案/轻分享档）待流量与反馈定形。

## 待定决策（挂账）

| # | 问题 | 影响 |
|---|---|---|
| 电脑端执行节点化 | 桌面 dsh 注册为"我的设备"、移动端派活到本机跑（个人设备群）——2026-10-13 用户选了云端任务档，本地设备群降级为长线线索，有真实需求再立项 | Y3 范围边界 |
| 应用中心给谁看 | 登录后导航项（快）vs 匿名可逛门户首页（拉新友好，login hero 已有可复用叙事）——Y1 立项时 grill | Y1 形状 |
| 识律/柏讯官网填充 | 两线官网现为占位/骨架；壹座卡片降级策略已定（如实+直达），但介绍内容的最终归宿是各线官网自己长 | 五线呈现质量 |
| Y4 闭环形状 | 「我的解决方案」= 会话快照？预设+技能组合？轻量 pack？——待 explore | Y4 立项前必答 |
| 操作面身份模型 | **2026-10-13 用户确认定案**：管理类动作走用户 key 委托（connector 模式：粘贴即连接+注入+401 翻面），消费类动作走既有计费门（facade 模式：边界结算） | 已定案，随 C0 落地 |

## 与双星伞文档的对齐

- 谦面线（F1-F3）与萬星线（M0-M4）的推进节奏**不变**，伞文档仍是那两星的事实源；
  本文只在壹座侧消费它们的产物（pack 进 cell、群蜂在壹座可触达）。
- M4⑤ 开放前置（serving runner 独立 deployment）等伞文档挂账继续有效。
- 资源竞争时优先级裁决：壹座 Y 线与双星 M/F 线冲突时按「非技术用户旅程完整度」
  断——哪个缺口挡住用户全程自助，哪个先。
