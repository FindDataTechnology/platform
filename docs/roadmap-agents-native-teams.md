# 路线重定义 · AI Agents Teams 执行平台

> 立项：2026-10-29（产品叙面会话 → paas 侧落地）。本文是**路线**文档，不是需求单；
> 五条线各自有独立 OpenSpec change 承接（见 §6 立案次序）。术语真源见 §2。

---

## 1. 定位变化（一句话）

壹座从「AI 助手 + 一堆面板」**升维为 AI Agents Teams 的执行平台**：
**未来的线上执行工作主要由不同的 AI agents teams 完成，不再是人。**

由此推出三条硬约束，它们决定后面每一条设计：

1. **团队是一等公民（Team-as-a-First-Class-Citizen）。** 不是「一个会话里挂几个专家」，
   而是「一支会自己干活、自己汇报、自己进化的组织」是平台的原生对象。今天 `agent-fleet-core`
   已经把「舰队(Fleet)」立为 cell 一等公民（岗位/组织树/节奏/KPI 槽位/编排边/拍板队列/花销投影），
   方向已对，缺的是**命名与心智模型**和**管理面**。
2. **平台要能被 AI 自己迭代。** 用户点名了两类参照：*harness 2 的自迭代开源解*、*hermes agents
   那种「自己总结、自己进化 skills」的解*。落地为 §5 的「团队自迭代闭环」，不是锦上添花，是
   「替代人类大部分工作」这个目标的必要条件——否则平台本身还是人肉维护的产品。
3. **信息平权与机会公平是价值锚，不是 slogan。** 落到产品上：模板与官方资产**公开可浏览**
   （§4 线3）、记忆与人/团队的产出**互相可继承**（永忆 × 智语 × 团队，§4 线5）、
   官方 teams 让新人**零成本看懂平台**。

---

## 2. 命名裁定（本次路线带来的词表变更）

现行词表（`native-lexicon`，2026-10-28 归档）：常驻组织=**集群/Cluster**、临时编组=**阵列/Array**、
分发单位=**能力包/Pack**、商店=**能力市场**。

2026-10-30 用户对词表做了第二次裁定（覆盖 10-28 的三词），五语言显示层全量改写、
代码键/API/事件/spec 目录名照旧零翻译：

| 现行 | 改为 | 说明 |
|---|---|---|
| 集群 / Cluster | **智能体团队 / Agent Team** | 用户 2026-10-29 明令。 |
| 阵列 / Array | **小组 / Group** | 用户 2026-10-30 明令。会话内临时编组。 |
| 能力包 / Pack | **智能体 / Agent** | 用户 2026-10-30 明令。安装单位。 |
| 能力市场 | **智能体市场 / Agent Market** | 用户 2026-10-30 明令。 |
| 壹座·Packs（品牌） | **壹座·智能体基础设施** | 用户 2026-10-30 明令。registry 落地页品牌串在对侧仓，挂账。 |
| 壹座·智能体工作室 / Agent Studio（构建面品牌） | **智能体构建器 / Agent Builder** | 用户 2026-11-01 明令。`/agents` 升格四区门面（构建/供给/我的创作/调优）；ja エージェントビルダー、es Constructor de Agentes、fr Constructeur d'Agents；路由/slug/testid 零改（add-agent-builder-hub）。 |

代码键/API/事件/spec 目录名仍一律含 `fleet`，**永不翻译**（沿用 native-lexicon 的既有纪律，
改名是显示层的活）。

> 用户口中的「ai agents builder teams / ai agents teams builder teams」（第 2 条线）不是第四种词，
> 而是**用「团队」这个一等公民造出来的两类官方团队**：一类帮用户**搭团队**（架构师/装配），
> 一类帮用户**造团队要用的智能体**（智能体作者）。它们本身就是 §4 线5 的「官方 teams」。

---

## 3. 产品架构（五层，自下而上）

```
┌─ L5 自迭代闭环 ───────────────────────────────────────────────────────┐
│  团队自提案 → 人/信号批 → 铸版发版 → 订阅者跟新（fleet-owner-iteration） │
│  skills 自我总结/进化（hermes 式）· 平台自身被 AI 改（harness 式）     │
├─ L4 沟通与记忆底座 ──────────────────────────────────────────────────┤
│  智语（多智能体共席/IM 桥/网站嵌入）× 永忆（L0→L1→L2 蒸馏、digest 注入） │
│  = 「agents teams 之间与人类交流」+「teams 之间共享信息」的新底座        │
├─ L3 分发与模板 ──────────────────────────────────────────────────────┤
│  壹座·智能体基础设施（原生多语言）· 智能体市场 · 舰队模板（用—养—传闭环）· 官方团队 │
├─ L2 执行 ────────────────────────────────────────────────────────────┤
│  **智能体团队**（一等公民）：岗位/组织树/节奏/KPI/编排边/拍板/报数/花销   │
│  —— 万星线上部署与执行平台 ——                                         │
├─ L1 运行时 ──────────────────────────────────────────────────────────┤
│  DeepSeek Harness (dsh) runtime · 一 cell 一进程 · MCP/SaaS 连接器     │
└──────────────────────────────────────────────────────────────────────┘
```

一句话记忆：**团队是组织，pack 是组织的能力，智语是组织的会议室，永忆是组织的记忆体，
自迭代是组织的新陈代谢。**

---

## 4. 五条线逐条拆解

### 线1 · 壹座层：团队一等公民 + 改名 + 双看板
**目标**：团队成为心智中心；一个屏看全团队、一个屏快速编辑所有团队。

- **1a 改名**（`集群/Cluster → 智能体团队/Agent Team`）：纯显示层，i18n 五语言。
  现状：`web/src/locales/{zh-CN,en,es,fr,ja}/common.json` 的 `nav.fleets`、
  `trace.fleetBadge` 等 ~22 处（zh）+ ~11 处（en/es/fr）。键不动。
- **1b 团队一等公民**：`agent-fleet-core` 已有建队/建岗/换防/调速/补岗/存档，
  缺口是**发现与批量管理**——不能一眼看全、不能批量启停、不能在列表里直接改名/换模型。
- **1c 双看板**（核心缺口）：
  - **综合看板（Overview）**：跨团队聚合——全部团队在跑什么、谁失联/待补岗、等你 N 件拍板、
    近 24h 花销、健康。数据已有：`/api/fleets/overview` + `/api/fleets/owner/board`
    （后者已聚合状态计数+openDecisions+failing+spend+lastActivity），**缺的是把它们收进一个屏**。
  - **管理看板（Management）**：团队清单 + 每行快速编辑（改名/默认模型/启停/查看/进驾驶舱），
    批量动作（全部暂停/归档）。`GET /api/fleets` 已返回 memberCount/statusCounts/openDecisions，
    **缺的是行内 PATCH 与批量端点**（单团队 PATCH 已有 `PATCH /:id`）。
- **明确不做**：驾驶舱（`agent-fleet-cockpit`，画布式单团队深钻）**不合并进**综合看板——
  那是「看一支公司怎么运转」，综合看板是「看所有公司」，两个问题，两个面。

### 线2 · 两类官方「建队团队」（Builder Teams）
**目标**：用平台自己的团队一等公民，帮用户**基于基础设施与模板快速造出自己的团队**。

- **Builder A · 团队架构师（帮用户搭团队）**：`docs/fleet-architect.seed.json` 已有雏形——
  把自然语言编译成岗位树/节奏/编导边草稿 → diff → 批准 → apply（`POST /:id/orchestration/draft|apply`）。
  需要做的是**把它从单团队实例提升为一等公民模板/官方 pack**，并接上蓝图构造间（`add-blueprint-studio`）
  这条「蓝图→团队模板→上架」的既有链。
- **Builder B · 智能体作者（帮用户造团队要用的智能体）**：`packs/facade-builder`（分身工坊）已有。
  缺的是**统一的「造包」入口与官方作者向模板**，以及把 `docs/creating-packs.md` 这类文档
  接成平台内可跟随的教程。
- **明确不做**：Builder B **不做**独立的可视化 pack IDE（那是另一摊大工程）；先用种子+文档+校验闭环。

### 线3 · 壹座·智能体基础设施：原生多语言 + 公开文档
**目标**：packs 支持原生多语言；未登录客户也能看到官方资产。

- **3a 原生多语言**：契约**已经就位**（`pack-locale-tracks` spec + `lib/pack-locale.js` 的
  locale overlay + `web/src/lib/packs-api.ts` 已按请求 locale 投影）。缺口是**内容**——
  现网 packs 的 `i18n` 块基本为空，等于英文/其他语言一律回落中文。
  要做的是：给官方资产填副轨 + 校验/发布门把「zh 必填、副轨可选」钉死（`scripts/check-locales.js`
  已强制五语言键 parity，pack 侧需要同构规则）。
- **3b 公开文档与官方资产**：`registry-product-home` 已给匿名根路径落地页；但**控制台侧**
  packs 列表/详情/安装全部走 `requireMcpManage` 门（`server/routes/packs.js` 的 `requireGate`），
  未登录看不到官方资产。要做的是**公开只读浏览面**（浏览/详情/文档可读，安装/发布仍需登录）。
- **明确不做**：公开面**不下发** manifest 全文里的敏感结构（沿用 pack-visibility 的
  「探测教不出东西」原则）；公开读是新增门，不削弱既有私有/安装门。

### 线4 · 存量 packs 深度改造（命名/理念/规范）
**目标**：存量包符合新词表与规范。

- 现状盘点：`docs/legacy-pack-name-cleanup-requirements.md`（2026-10-27 需求单）已列清**长尾旧名**
  （`萬星舰队助手`/`数据-指标工坊`/`数据-自助分析` 等）与**旧类目**（daas/docs/data/authoring/company
  应向「线/供给域」统合）。姊妹单：集群改名批次、pack-i18n。
- 要做：按 §2 词表逐包改名（id 不变、显示名走新版）、category 归位、副轨录入。
- **明确不做**：packId/作者面/分组关系/版本纪律**零改**（沿用该需求单的纪律）。

### 线5 · 智语 + 永忆 + 官方 teams
**目标**：优化智语与永忆，发布官方 teams 让用户快速看懂平台。

- **5a 智语**：`zhiyu-room`（站内空间）/ `zhiyu-im-bridge`（IM 群桥）/ `zhiyu-widget`（网站嵌入）
  三件套已在产。要优化的是**与团队/记忆的连通**——空间内能否直接召唤一支部署的团队、团队报数能否进空间。
- **5b 永忆**：`memory-distiller`（L0 观测→L1 交接→L2 事实/经验，永不删页只 supersede）、
  `memory-eval`（接续成功率三臂对照）、`memory-federation`/`memory-visibility` 已在。
  要优化的是**团队记忆**——一个团队跨会话/跨换防的连续性（今天岗位换防清史会丢连续性，
  `agent-fleet-core` 的报数史/KPI 槽位连续性是已有的雏形，需与永忆对齐）。
- **5c 官方 teams**：发布一批「开箱即用」的官方团队（含 §2 的两类 Builder teams），
  配文档，作为新用户理解平台的样板。

---

## 5. 自迭代闭环（让 AI 自己迭代平台）

这是路线的**能力底座**，不是附属功能。分三层，从易到难：

### 5.1 团队自迭代（已在产，需收口）
`fleet-owner-iteration` 已实现完整环：配置/蓝图改动 → 拍板队列（带 diff）→ 批准 → 一键铸版发版
（vN+1）→ 市场上架 → 订阅者跟新提示。这是「团队自己改自己」的骨架，保持不动。

### 5.2 Skills 自我进化（hermes 式，缺）
参照「hermes agents 自己总结、自己进化 skills」：
- **触发**：一个回合/一个任务完成后，agent 自评「这次用了什么 skill、有没有更好路径」。
- **沉淀**：把可复用的路径写成 skill 候选（`custom-skills` / `skill-materialize.js` 已有落点），
  经 `memory-distiller` 式的「永不删页只 supersede」纪律入库，不直接覆盖既有 skill。
- **门**：新 skill 先 `memory-eval` 三臂对照（有/无该 skill 的接续成功率）过门才晋升——
  **AI 提的 skill 必须过评测门**，对齐 `memory-eval` 的既有科学门。
- **明确不做**：agent 不得自行改运行时/安全边界（沿用 action-gate 纪律：提议进拍板，人批生效）。

### 5.3 平台自迭代（harness 式，缺，最远）
参照「harness 2 的自迭代开源解」：
- 平台自身被 AI 改的前提是**CI 经济门 + 私有/公开仓通道 + 快照纪律**（见 AGENTS.md 出片律）。
- 现实约束：**私有 CI 2000 分钟/月/账号**，AI 自迭代的每一轮 build/test 都吃额度。
  所以平台自迭代必须走「**AI 提改动 → 离线评测/单测过门 → 人（或自动门）批 → 走公开仓免费线出片**」，
  **不能**让 AI 每轮直接烧私有 CI。这条是硬约束，写进 change 的 Non-goal。

---

## 6. 立案次序（建议）

按「依赖 + 价值/成本」排，每步一个 change，可独立交付（✅=已立案，⚡=改名已先行落地）：

| 序 | change | 线 | 依赖 | 体量 |
|---|---|---|---|---|
| 0 | ⚡ **词表改名已落地**（五语言 i18n 值改写，键不动；桌面机群/部署面 3 处按语义保留「集群」） | 1a | 无 | 小 |
| 1 | ✅ `add-agent-teams-first-class`（综合看板 + 管理看板 + 行内编辑 + 批量 + 词表 spec 收口） | 1b/1c | 0 | 中 |
| 2 | ✅ `add-official-pack-showcase`（**已实施**：gateway 匿名读开关+官方三段聚合+official 徽章+登录墙前段+市场筛选，测试 5/5+回归 77/77+e2e 3/3） | 3b | 无 | 中 |
| 3 | ✅ `add-official-packs-i18n`（12 份官方资产 en 副轨已填 + 防漂移门已建，validate 绿） | 3a | pack-locale-tracks 已归档 | 中 |
| 4 | ✅ `add-legacy-pack-rebrand`（已立案+在仓改名已执行：团队架构师/萬星机群助手；市场长尾三名与 category 归位待运营班） | 4 | 0 | 中 |
| 5 | ✅ `add-builder-team-templates`（**已实施**：两桥两桥子+三处接线+两份新种子+locale 门扩展+入口接线，单测 6/6+七套 85/85；e2e/铸造随走查班） | 2 | 1 | 大 |
| 6 | ✅ `add-zhiyu-team-memory`（**已实施**：f/ 记忆捕获+fleetContext 记忆段+空间订阅桥+一键召唤；单测 13/13+回归 165/165；真机走查随滚版班） | 5a/5b | 1、5 | 大 |
| 7 | ✅ `add-skill-self-evolution`（**已实施 f5aefc45**：v109 候选表+skill_propose 单工具桥+paas 侧 A/B 评测器（judge 同车道/匿名盲评/不劣于门）+web 待确认面+lineage；真机走查随滚版班） | 5.2 | memory-eval 已归档 | 大 |
| 8 | ✅ `add-official-starter-teams`（**已实施 f5aefc45**：五支说明卡入 packGuides（市场 id 实证入 STARTER_TEAMS）+HelpDialog 序列+公开教程 from-zero-to-first-team.md；浏览器走查随滚版班） | 5c | 5、6 | 中 |
| 9 | ✅ `define-agent-document`（**脊梁已立案**：agent-document 能力 spec——原子单元/单校验器/四发射口/编辑器≠生命周期/三桶规格书/无凭据；零代码） | 脊梁 | 2 | 小 |
| 10 | ✅ `move-pack-guides-to-manifest`（**已实施**：guide 入 manifest 六字段+发布 vN 门+第一批 5 支 starter v6 上产 API 实证；第二批 2 支原作者闸+4 支 unlisted 挂账） | 脊梁 | 9 | 中 |
| 11 | ✅ `add-agent-spec-sheet`（**已实施+归档**：共享三桶规格书组件 full/compact，市场详情/卡片/助手行三面接入，五语言） | 脊梁 | 9、10 | 中 |
| 12 | ✅ `add-agent-studio`（**已实施**：/studio 三栏画布+实时校验（复用发布门 dry-run）+双发射口；4.x AI 起草拆随 add-studio-ai-drafting） | 脊梁 | 11 | 大 |
| 13 | ✅ `fold-blueprint-into-studio`（**已实施+归档**：团队模式承载蓝图池+双轨不绕闸+共享三桶编辑器+/blueprints 重定向；真机全链 green→签字→封签 v7） | 脊梁 | 12 | 大 |
| 14 | ✅ `add-agent-fork-lineage`（**已实施+归档**：lineage-only 血缘块（forkOf）+读面种子+发射口携带+facet 跨域深链） | 脊梁 | 11 | 中 |
| 15 | ✅ `add-official-agent-gallery`（**已实施+归档**：官方筛选卡墙=投影升级（零新端点）+starter 标记+克隆深链） | 脊梁 | 11 | 中 |
| 16 | ✅ `add-agent-builder-hub`（一级门面「智能体构建器」四区：构建/供给/我的创作/调优；slug 复用 agents 零路由破坏；2026-11-01 立案） | 2 | 12、14 | 大 |
| 17 | ✅ `add-mcp-annotation-overlay`（供给注释层：MCP/tool/skill 三类对象 human 五语言轨（zh 主轨）+ canonical brief；registry metadata 透传零改码；含 mcpServers 进 pack i18n 白名单；2026-11-01 立案） | 3a | 16 | 大 |
| 18 | ✅ `add-tool-description-enrichment`（canonical 轨接运行时工具面：tool-filter 同款 overlay 通道，只增强不改名，publicFacing 跳过；2026-11-01 立案） | 5.2 | 17 | 中 |
| 19 | ✅ `add-persona-self-evolution`（角色桶自进化：persona_amend 提议→A/B 臂盲评→人批分流（自建预设物化 / pack persona 走 fork）→lineage；2026-11-01 立案） | 5.2 | 7、16 | 大 |

---

## 7. 不变式（任何线都不得违反）

- **代码键/API/事件/spec 目录名永不翻译**（`fleet` 恒在）。
- **上行内容类字段永不进白名单**（presence/manifest/cell_detail 的既有纪律）。
- **AI 提的一切生效动作过拍板/评测门**（action-gate + memory-eval），人（或自动门）批才落库。
- **私有 CI 额度是稀缺资源**：任何「AI 自迭代」轮次优先走公开仓免费线/离线评测。
- **每 change 只 `git add` 本变更文件**，勿 `-A`（并行会话常见）。
