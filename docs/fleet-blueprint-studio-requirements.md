> **入口注记（fold-blueprint-into-studio, 2026-10-31）**：蓝图构造间已并入智能体工作室团队模式（`/studio`，团队 tab）；`/blueprints` 重定向至此。本文为需求历史底稿，生命周期语义不变。

# 垂直蓝图构造间（Blueprint Studio）产品化 · paas 侧需求书

> 交付对象：paas 实施者。承接 2026-10-27 产品线方向会话用户裁决：「内部方法论对外开放、工具化」——L3 垂直构造器（NL→蓝图→批准→铸造→真跑，已在 fleet-packs 跑通跨境电商政策盯梢试点）要成为**客户面产品**，不是只在内部 harness 里跑的手艺。姊妹单参见《owner 经营面》《供给开放》《pack-i18n》《集群改名与货架分视图》；词表与定位承接 finddata 根 spec `pack-taxonomy-and-naming` / `fleet-platform-positioning` / `vertical-blueprint-constructor`（蓝图格式契约）。
> 若 paas/openspec/changes 下已有 `add-blueprint-studio`，以 change 为准、本文当验收视图；尚无的话，promote 本单立项，勿对修（防止任务台账撞车）。

---

## 1. 问题

L3 方法论已经全真跑通（试点档案：一句业务描述→蓝图草稿→校验→主人批准→模板包上架→集群实例化→首轮真跑断言通过），但形态仍是**内部 harness**：

- 蓝图只活在 `fleet-packs/blueprints/` 仓与构造师 pack（市场 `O30LA92kq1D5uuNIBGKsZQ`）里；
- 客户视角缺三块：蓝图编辑面、批准闸的展示与操作、铸造/上架/试跑报告的结果面板；
- 三侧既有资产已就位但还没缝合：**agent-fleet-architect**（活舰队 NL 编排面：起草→校验→批准→落地）、**agent-fleet-templates**（模板分发 + 「用—养—传」上架环）、**真跑验收链**（L1/L3 阶段的断言纪律）。蓝图产品化要在这三件之上长「垂直包铸造舱」，**不新造第二套校验、不新造第二套上架、不新造第二套调度器**。

核心产品承诺（用户原话式表达）：内部方法论对外开放、外部供体都能用——studio 最终要给外部供应商一条「场景→批准闸→上架」的对客通路（过来接供给开放单的 vendor 身份与闸）。

## 2. 范围

| 编号 | 交付物 | 优先级 | 说明 |
|---|---|---|---|
| A | **蓝图对象产品形态**：平台内立蓝图实体：板块边界（名称/一句话/不做什么）、数据来源引用（registry 在册名或内部库逻辑名，**禁端点禁凭据**）、岗位编制（岗位名、职责一句话、纪律 pack 引用、KPI 槽位、错峰节奏、编导边）、看板与产物骨架、监控判据与 escalate 阈值、验收断言清单。字段形状与 finddata 根 spec `vertical-blueprint-constructor` §蓝图格式同源；fleet 段 **SHALL 直接通过既有 parseFleetTemplate 校验**（零翻译层） | P0 | 蓝图是与活舰队不同的资产对象，不是草稿变体 |
| B | **工作室界面（编辑→校验→diff）**：owner 面开「蓝图构造间」：蓝图创建/编辑（表单+JSON 双轨）、NL→草稿（承袭构造师 pack 的编译能力）、草稿走**既有校验链**（parseFleetTemplate → validatePackManifest → allowTools ⊆ 商业集，禁新立第二套）、校验结果与 diff 呈现 | P0 | 批准纪律：未经主人明确批准，不铸造、不上架、不实例化；apply 重校验兜底（沿 architect 同款两段纪律） |
| C | **批准闸与铸造**：批准→铸造 manifest（依赖占位 `{{PACK_ID:*}}` 补齐）→上架为集群模板 pack（市场=唯一分发更新通道）→产出「装一台跑一轮」的试跑入口。铸造产物带追溯（来源蓝图说明 + 批准凭据 + 时间进 `_casting` 段） | P0 | 铸造不授予任何新平台能力；走既有市场发行门 |
| D | **试跑验收报告**：首轮断言清单按蓝图验收段执行，报告全量落盘（断言/证据/首回合标识）；**试跑不绿 → 报告如实标出，该模板条目不进入可对外呈现/可售态** | P1 | 与供给开放单对账：第三方模板的必备质量证明位 |
| E | **供应商通路（依赖供给开放单的 vendor 身份与闸）**：vendor 可提交蓝图并走同一「批准→铸造→试跑」链，模板条目标 vendor 归属；分成账记在市场分成单 | P2 | 本单只定义「形状可装」的承接位，vendor 身份不在本单立 |
| F | **词表与命名跟进**：studio UI 与文案走「构造位（compile）/主人闸」骨词组；场景名以中文主轨（「政策盯梢」类），**不出现「舰队」字样**（该词已对外退休）；英文仅副轨等义 | P0 | 与 pack-i18n 需求书的语言层接口对齐，勿各自造词 |

## 3. 不在范围（分层纪律）

- **活舰队编排本身** = agent-fleet-architect 属地：studio 治「包」（蓝图→模板→上架），architect 治「舰」（现场新建/改/停/复）。两处在 fleet 段共享同一校验函数与起草批准纪律，但**不通融**：studio 不得直接开停活舰、architect 不得铸造上架。
- **新校验/新调度/第二写路径**——一律禁；蓝图落地照旧走既有舰队写路径 + 任务引擎 + 市场发行门。
- **技能正文自动翻译**：SKILL.md/persona 只有一份（中文主轨）；仅「显示名与描述」走多语言结构（接 pack-i18n 单）。
- vendor 身份、账目、分成结算——在《供给开放》《市场交易记》两单承接。

## 4. 验收口径

一个**非内部** owner（或试用账号）在仅经平台界面下完成全链，每一闸失败路径如实分类回报：

1. 在 studio 输入一句业务场景（如「跨境电商政策盯梢」），生成蓝图草稿；
2. 草稿既有校验全绿 + diff 可阅；**草稿阶段市场不出现新包、舰队库不出现新舰队**；
3. 主人明确批准后铸造上架；上架条目在市场「集群模板」专辑可见；
4. 从市场装一台试跑：首轮真跑断言全绿，产出原件带 source_ref 三元组纪律；
5. 试跑报告含断言/证据/首回合标识；后续 vendor 上架时条目可见 vendor 归属与分成单的对账位。

校验类失败（fleet 段不合法 / manifest 非法 / allowTools 越商业集）**逐字段指名**（复用既有校验器原文）；未经批准而出现的上架或实例化属结构性违例、应被结构性拒绝。

## 5. 与既有资产锚（防重复找）

| 资产 | 落点 |
|---|---|
| 蓝图格式契约 | finddata 根 spec `vertical-blueprint-constructor`；模板示例 `fleet-packs/blueprints/schema.md` 与 `blueprints/cross-border-ecom-policy/`（含首跑验收 + _casting 追溯） |
| 构造师 pack | 市场 `O30LA92kq1D5uuNIBGKsZQ`（能力包·构造·蓝图构造师） |
| 校验链 | 既有 `parseFleetTemplate`（模板/蓝图共用）+ `facet-pack-builder/validate_manifest.py`（发布门） |
| 活舰队编排 | paas spec `agent-fleet-architect`（NL 起草—批准—落地，工具桥 loopback + cell owner） |
| 模板分发 | paas spec `agent-fleet-templates`（用—养—传上架环，市场=唯一分发） |
| owner 面 | 需求书《fleet-owner-surface-requirements》：总览坞 + 读数 + 主人闸 + 装作路径 |
| vendor/分成 | 需求书《fleet-platform-supply-open-requirements》；change `add-market-revenue-share` |

## 6. 当前立项状态提示（2026-10-27 晨）

paas 侧已有同线 change 在推进：owner 面（`add-fleet-owner-surface`）、owner 迭代（`add-fleet-owner-iteration`）、市场分成（`add-market-revenue-share`）、vendor 供给（`add-vendor-supply-open`）、pack i18n（`add-pack-locale-tracks`）、词表（`add-ai-native-lexicon`）均已立项。**蓝图工作室是与之并列的第六而战**，本单为其需求承接；若 `add-blueprint-studio` 已立，请将本单归入该 change 的验收视图并照应词表与姐妹单。
