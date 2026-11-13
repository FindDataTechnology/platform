# 壹座·智能体素材广场 explore 底稿（2026-11-02）

> 探索结论的落盘。立案：`rename-agent-materials-plaza`（改名班）+ `add-agent-materials-plaza`（官网+管线）。
> 用户原始诉求：壹座·packs 改成壹座·智能体素材广场；要有官网让不同语言背景的**人和 AI** 理解
> 我们提供了哪些基础设施、如何提供、现在具备哪些素材。五个决策点用户委托代裁，裁定如下。

## 〇、事实底座（探索期核实）

1. **「壹座·Packs」已在 native-lexicon v4 被裁定为「壹座·智能体基础设施」**（2026-10-30 lexicon ruling），
   但该品牌串在当前树**零渲染点**（grep 证）。本番 v5 裁定是在未来渲染点（广场官网、页脚入口）定义品牌，
   不存在存量串迁移。市场面现名「智能体市场」（zh 6 处 + 四语平行键）。
2. **双向注释层先例已在生产**：`market-annotations.json`（765KB）对每个 MCP 服务同时维护
   `canonical.brief`（供 AI）+ `human.{zh,en,es,fr,ja}`（供人）+ `provenance.{source,updatedAt}`。
   广场 AI 面直接复用此形状，零新增词汇。
3. **官网建制现成**：`site-zhiyu/` 纯静态站（index.html+script.js+style.css）；部署配方在册
   （雷池 WAF 103.236.89.212 → 本机 Caddy 每域一块 file_server，yongyi/memory 双域名先例，台账 §15.59）。
4. **单一上市判据已有**：`facet/marketplace-json.js` 的 `loadListedPacks`（public + non-unlisted + curated，
   operator 白名单可整替）。广场导出必须复用，禁止第二套"什么能上架"规则（wire-marketplace-json-curation 疤）。
5. **facet web shell**：hash 寻址六视图（intro/packs/mcp/docs/mine/curate），五语 switcher，文案全 keyed
   （`facetIntro.*`/`facetFooter.*` 等键住 `web/src/locales/`，parity 由 check-locales 门守）。
   LineLadder 五行梯：壹座/识律/柏讯/谦面/萬星，行名链 `www.finddatatech.cloud/products/<slug>/`。
6. **workspace 现存 3 pack**：crm-desk-suite（Chatwoot 客服套件）、facade-builder（分身工坊）、
   finddata-facade（寻数分身）——生产市场另有全量货架（~89 包，memory 口径），清单真源在生产 facet API。
7. **星研 ai_readable 纪律已有家世**：每节自足 / 实体写全 / 术语唯一 / 输入-动作-产出 / 段落表格化 /
   规则按发布分区取。移植为 plaza-export lint。

## 一、五个决策（用户委托代裁，已裁定）

| # | 决策点 | 裁定 | 理由 |
|---|--------|------|------|
| D1 | 受众定位 | 对外官网优先（外部人+外部 AI 第一受众）；壹座内嵌市场面同步改名但同一真源 | 理解面在门外；装进壹座是点击之后的事 |
| D2 | 基础设施范围 | 以素材为主语讲全三层：素材→供给机制→接入方式 | 独立讲架构没人读完；机制每条都落在"它让你的素材能干什么" |
| D3 | 清单真源 | facet 市场 API 唯一真源；静态面构建期快照 + HTML 画廊客户端实时刷新兜底 | 官网按 house 配方纯静态；快照纪律有 facet 自身 ≤1h 缓存先例 |
| D4 | AI 可读性 | 同一真源三种机器面：llms.txt + catalog.json（复用注释层形状）+ 每素材自足 Markdown | 不是新发明——平台内部已把 MCP 工具注释成对人对 AI 双面，广场是既有机制的出仓 |
| D5 | 语言 | 人面五语沿用（parity 门不变）；AI 面 en 主 zh 镜，slug 稳定 | AI 检索生态英文为主；slug 稳定是 AI 引用地址不烂的底线 |

## 二、命名与词汇裁定（v5）

- 全名：**壹座·智能体素材广场**（Yizuo Agent Materials Plaza）；短名：**素材广场**；域名：`agent.finddatatech.cloud`。
- 词汇谱系：「素材（Material）」是**属**——广场上一件可被人与 AI 理解、获取、运行的供给物；
  种仍是既有词条（功能集/生态技能/MCP 服务/AI 分身/官方数据锚）。改名不改种词。
- **零 API 改**：路由 `/packs`、`/api/packs`、`packs` DB、代码键、manifest 字段全部不动
  （先例：舰队词汇两段决议——新 UI 用终词，键/API 零改）。
- 市场面终词：「智能体市场」→「**智能体素材广场**」（en: Agent Materials Plaza）；单位词「智能体」不动。

## 三、官网信息架构

```
壹座·智能体素材广场  agent.finddatatech.cloud（纯静态，雷池+Caddy 配方）

人面（五语）
  HERO    "智能体要用的每一种素材，都摆在这个广场上。" + 三活数字（功能集/技能/MCP 计数）
  ①素材有什么  五类卡片墙：功能集 / 生态技能 / MCP 服务 / AI 分身 / 官方数据锚
  ②怎么供给    机制链四段：发布（版本即不可变快照）→获取（壹座内置/CLI五编辑器/市场页）
               →运行（cell 隔离·聚焦模式·工具白名单）→服务化（serving→A2A·驻留·计费）
  ③素材目录    实时画廊（官方/分身徽章·垂类筛选·检索）→详情→三条安装路径复制即用
  ④给谁用      两栏同框：人（编辑器用户/企业接待/创作者）+ AI（机器面指针）
  页脚         五行梯 + 兄弟站互链（zhiyu/yongyi/facet/萬星）

AI 面（机器可读，同源生成）
  /llms.txt          站点索引（en 主 zh 镜，逐节指针+自足摘要）
  /llms-full.txt     全文
  /catalog.json      全量素材目录，复用注释层形状：
                     { canonical:{brief}, human:{zh,en,es,fr,ja}, whenToUse,
                       provenance:{source,updatedAt} }
  /materials/*.md    每素材一页（en+zh），稳定 slug，自足成篇
  /infrastructure.md 基础设施自足说明页（输入-动作-产出表格化）
  人面每页嵌 JSON-LD + 机器孪生链接
```

## 四、双面同源管线

```
facet 市场 API（唯一真源，loadListedPacks 单一上市判据）
  → scripts/plaza-export.mjs（构建期）
      → snapshot.json（fallback 面 + 审计面）
      → /catalog.json、/llms.txt|.full.txt、/materials/*.md、人面计数注入
  → 校验门：
      - ai_readable 六条 lint（每节自足/实体写全/术语唯一/输入-动作-产出/自足断言/provenance 必带）
      - catalog.json 与 /api/packs 数目对账（差非零即红）
      - llms.txt 链接可达断言；五语 parity 门沿用 check-locales
```

HTML 画廊双层新鲜度：加载后客户端拉 `/api/packs` 实时刷新；失败静默退回构建期快照并标注
"快照截至 X"——页面上永远看得见数据新鲜度。

## 五、改名波及面（零 API 改）

| 面 | 改什么 |
|---|---|
| 壹座 web | `packs.tabs.market`、footer `entries.packs`、app-center tagline、onboarding 提及（zh 6 处 + 四语平行） |
| facet shell | `facetIntro.title/subtitle`、`facetFooter.entries.packs`（五语） |
| CONTEXT.md | 新增「素材广场（Materials Plaza）」+「素材（Material）」词条，Avoid：插件市场、应用商店、资源广场 |
| native-lexicon | v5：MODIFIED 首需求（品牌 bullet + store 终词 + brand scenario），带全场景超集 |
| 不动 | 全部路由/API/DB/代码键/manifest 字段 |

## 六、里程碑切片

1. 词汇改名班（change: rename-agent-materials-plaza）——五语 parity 绿，生产 grep 旧名零残留。
2. 官网骨架 site-plaza/——五语真机眼见，兄弟站互链往返，雷池+Caddy 上产。
3. 清单真源管线——数目对账门绿；快照 fallback 实测（断 API 起站不空）。
4. AI 面精修——无上下文模型冷读三问全对（这是什么/怎么装/截至何时）；lint 门入 CI。
5. 双面走查——人：五语真机；AI：真实 agent 从 llms.txt→catalog.json→material md→真装一个包全链零人工。

## 七、风险与待拍

1. 域名 DNS 由域主加（A → 雷池 103.236.89.212，TTL 先 600s）——外部动作。
2. 新鲜度语义：双层（快照截至 + 实时）口径需走查确认可接受。
3. 五类素材是封闭集合吗？扩类走 `category` 枚举版本字段，不塞最近一类。
4. llms.txt 生态尚在形成期——JSON-LD + 自足 Markdown 为主承载，llms.txt 加分面，不押注单一标准。
5. www 官网（fd-official-web，另仓）products/facet 页加指向广场链接——记录为后续件，不入本仓 change。
6. registry 仓库的 landing 品牌串同口径改「壹座·智能体素材广场」——registry 侧另记（v4 已有先例注记）。
