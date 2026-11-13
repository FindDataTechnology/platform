# Design: add-unified-memory-and-outputs

## Context

背景与动机见 proposal.md / Why。本设计只对「怎么做」的技术选择与不动量边界负责。上位框架（ADR-0030）已把四平面正交、底座自有、零 LLM 热路径、supersede 不覆盖定为铁律；本设计是它的 v2.1 方向性沿申——**统一在缝与面，不统一在库**。

## Goals / Non-Goals

**Goals:**
- 成果/资料库的分类（tags 自动+人工修）与分等（draft|stable|canonical）进长期记忆模型，人机同读、回收也回灌。
- fd-memory 新增 reference 页型与 tier/tags 模型；digest 名份引用 + tier 优先。
- 壹座成果页三层收纳与三手势；壹座「记忆」面板 + 萬星 console 部署者 d/ 浏览共用 visibility 读面。
- facade/智语回合接入同一条 digest 读缝。
- 全部动作有降级态；fd-memory 未配置时成品页/面板零破坏。

**Non-Goals:**
- 库合井（资料库/成果本体不搬家）；L3 profiles；共享 namespace；agent 扩权。
- 新外部依赖；不动 token/授权模型内部结构。

## Decisions

### D1 统一落点在缝与面，不是仓库
「四平面互不收编」10-19 已定为正解——转录/轨迹/资料库/工作记忆的体量/生命周期/受众不可同库。但是用户世界观是「一个记忆系统」。调和：**服务与契约统一**——写入手势（记住）三处走同一个 write 契约；读出入口（digest 读缝）是唯一的活性召回缝；浏览面吃同一张 visibility API。替代项考虑过「合一库」和「界面合逐」，都被四平面体量差与用户买单的体份否决。

### D2 reference 页型——薄名份，大且低频的本体不搬家
资料库与成果文件只能在 fd-memory 留下 title/summary/tags/tier/source_ref 五元组页，全文只在原仓。召回命中渲染为名份引用（「见资料库《台同模板》」）。理由：一兑现「是哪个文件」与「主题命中」的两种判读粒度，二保证 prompt 预算可控（参考 fleet-memory digest 名份规则 spec）。替代项「全文嵌入向量」成本与一百倍文档体量对立，附合 ADR 零 LLM 热路径纪律。

### D3 tier/tags 真源在 fd-memory，成果行存镜像（单写纪律）
成果列表页需要按 tier 快速筛选——本地行存镜像是最便宜的查；但是 tier/tags 有 AI 自动提案与人类修正在 fd-memory 侧流动，所以**写主 = fd-memory service 唯一**，成果行由受信写面同步。老人镜像只作读，不得有客户端直改路径。替代项「双写无主」会走集漂移；「仅服务为真源+列表实时」会吹响每行慢讯。

### D4 三级命名 draft | stable | canonical
- draft（草稿）：一切自动捕获默认层。
- stable（成果）：开过/改过名/被对话引用过 → 信号晋级。
- canonical（正典）：钉住/被分享/被 prompt 召回引用/同题终审胜出。

命名的准则三条：AI 可读激励语义（`canonical` 对模型天然传递「可信任引用」）、人读不装腔（草稿/成果/正典都是日常词）、无差异化中文文案歧义。替代项 bronze/silver/gold（数据湖惯例，人事职上太生份）与「一/二/三级」（空洞）否决。降级永远走既存 supersede 链（可下钻、可撤销），绝不做「层级直降」二的玄写。

### D5 tags 由蒸馏车道起笔、人类修正回灌（混合必可修）
蒸馏器本来就有 L0→L1→L2 在产并行，打标支线新增「每 reference 一次 tags+tier 候选」的廉价任务，打 per-owner 日预算门（ARN 已规径），产物带「AI 提议」来源。人类/AI 在 UI 的一键修改写为 correction note（含改前改后与按者身），后续打标语读本人近期 correction 适配词表。替代项「登录时用户必填 tag」会转后打工入存仓礼仪；「纯自动」违反人类必可修的拍板。

### D6 浏览面两面共用一 API——visibility 扩 tier/tags 筛选
壹座记忆面板（owner u/）与萬星 console 部署者 d/ 浏览吃同一张 visibility 读面（rootKey 语意原样），不新建服务端路线。person=本人，platform/runner=受信 lane，agent 族拒。勘误回面（修 tag/tier）从 UI 送 correction note 到 fd-memory 并即时同补表行。

### D7 facade/智语走 chat-memory 同一条缝，不分不帕
facade 是最后一条未接 digest 的 chat-surface。启用条件并入同一条 chat-memory 读缝（四件套 + 总闸），住户/游客按 zhiyu/identify 既有身份合流先例：登入=本 owner，游客=不注入。预算/tier 优先规则与壹座 chat 同腰。

### D8 迁移与鏀茫
- 存量成果行：tier 统一初始 draft，tags 空；打标支线按项目逆偏分批补标（budget 门内）。
- 新列与页型都是加性（additive）——不做 ilgil时时运动。
- 回滚=按面分旗（成果页 tier/tags 面、门户面板、facade 读缝）——每面可独立关闭，镜像列允许保留为空。

## Risks / Trade-offs

- **镜像/真源漂移** → 单写纪律 + 有醒镜重（out-of-band 写直接记 warn)；开箱体检脚本读双方按行采样。
- **打标成本失控** → per-owner 日预算门 + 打标任务按 batch+去抖进既有 distilled scheduler 调性，不超纲带増新调度。
- **游客冒认/身份合流** → 游客永远不注入；zhiyu/identify 既先例复用，不新建的身份管道。
- **成果页 UI 四套岛**（层收纳/海筛/手势/徽标） → i18n 五语言闸 + 默认体验不变（类型筛选为主的旧观可进层视图才变）；A/B 位设默认层收纳 off-by-default→on-by-default 按版本切换。
- **浏览面 API 超帅被榨** → 分页沿 visibility 现同约束；修 UI 百万次改动细分 segment 去抖。

## Migration Plan

1. fd-memory: reference 页型+suptags（对原机依赖垛加 test 定），名份引用规则进 digest，deploy（姜及 infra yaml 镜像班）。
2. paas server: 库行增列 + 手势写面 + 自动落 reference 子。
3. paas web: 成果页三手势与 tier/tags 面 + 「记忆」面板（先立后开旗）。
4. 万星: cabin 部署者浏览 + facade 读缝接线 + deliverable 打标弯腰。
5. ADR-0030 修订 v2.1 + 部署文档预算分表更新；The evaluation harness（memory-eval） baked 加一个 tier/citation 场景 postscale。

## Open Questions

- 「成品」的 tier 信号里「被 prompt 召回引用」初版以 digest 渲染内记数甩为为准，开门后如果召回导金塔不满足信号数量，把 stable 信号集调为升降 \\
（这是可以在实施中 v1.1 里 adjusted without 好吗 spec）。