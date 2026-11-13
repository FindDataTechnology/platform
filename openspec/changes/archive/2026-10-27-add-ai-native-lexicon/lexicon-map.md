# lexicon-map.md — 词位改动总表（任务 1.1 交付物）

> 规则：**键名零改，只改值**。zh-CN 全量覆盖；en/es/fr/ja 同步（提案圈定 zh+en，模底发现另有 es/fr/ja 三语种同样承载舰队/集群词，一并以产品名词对待——舰队在任何语言用户侧都不再见客）。

## A. 动态集群 → 阵列 (Array)

zh 值内「集群」→「阵列」；en `cluster→array`；es `clúster→array`；fr `cluster→array`；ja `クラスター→アレイ`。

keys（zh/en/es/fr/ja 五语种同套键）：
- `agentsPage.myClusters` / `clustersEmpty` / `clusterDetail` / `clusterAgents` / `clusterTerminate` / `clusterTerminateHint`
- `composer.strip.clusterLoad` / `clusterLoadHint`（zh 值重写：去「运行编队」冗余说法）
- `chat.header.clusterBound` / `chat.header.clusterExpiring`，`chat.cluster.terminatedNotice`
- `tasks.fields.cluster`
- `clusters.composer.*`（title/clusterName/creating/created/createCluster/nameRequired/nameTooLong；zh 另有 addAllFromPack/noAgents 走 C 组）
- `packs.detail.cluster.title`（manifest cluster 块信息 → 阵列信息）
- **`fleets.kind.cluster` → 阵列 / Array**（加岗类型=existing-cluster 引用岗，动态义，非 fleet 同义词——不随 B 组）

## B. 舰队 → 集群 (Cluster)

zh「舰队」→「集群」；en `Fleet→Cluster`；es `Flota→Clúster`；fr `Flotte→Cluster`；ja `艦隊→クラスター`。

keys：`nav.fleets`、`nav.fleet`（zh 无此键）、`trace.fleetBadge`、`board.tab.fleet-summary`、`fleets.title/create/empty/nameLabel/detail.empty/tpl.awaitStart/tpl.start/tpl.newer/hints.paused/runs.empty/inspector.effortInherit`

特例：
- `fleets.tree.empty`（zh「…开始编队」）→「…开始组建」——「编队」词位废除，不留尾
- **`fleet.*`（无前 s）= Wanxing Fleet 桌面 runner 插件的寄存产品名，五语种一律不动**（品牌部件名，翻它会与设置页实际插件名错位）

## C. 功能集/功集/包 → 能力包；功能集市场 → 能力市场（zh 专属）

值内替换序：`功能集市场→能力市场` → `功能集→能力包` → `功集→能力包`（功集是历史错字变体，顺势归一）。

命中 keys：`agentsPage.market`、`agentsPage.clusterTerminateHint`、`chat.presetLink.missing`、`chat.assistant.packSection`、`extensions.mcp.fullSurfaceHint`、`settings.sections.packs`、`settings.connections.glossary.facet.desc`、`facetShell.tabs.packs/mine`、`facetDocs.*`（10 键）、`facetIntro.*`（6 键）、`facetFooter.tagline/entries.packs`、`packs.market.*`（2 键）、`packs.detail.*`（7 键）、`packs.mine.empty`、`packs.drafts.*`、`packs.editor.*`、`packs.bridge.reason.pack`、`customPresets.*`（4 键）、`presetPublish.*`（5 键）、`mcp.narrative.body`、`sessionSolution.savedAs`、`clusters.composer.addAllFromPack/noAgents`、`facetMine.*`（6 键）、`facetCurate.empty`

特例：
- `board.tab.my-packs` 我的包 → 我的能力包
- `appCenter.line.facet.tagline` → 「能力市场——发现、安装与创作能力包」
- en 侧 pack 词本已是 Pack，不动。

## 附节：服务端 agent 可见/看板字符串（1.4 扩展段）

locale 之外的六处字符串同样随词位改版（Literal 值改，语义/键不动）：
- `server/fleet-reports.js` 【舰队岗位身份】→【集群岗位身份】
- `server/fleet-context.js` 【舰队巡视上下文】舰队… →【集群巡视上下文】集群…（{{fleetContext}} 注入段，帖子转头/驾驶舱可见）
- `server/routes/fleets.js` 【舰队派发】→【集群派发】（dispatch 回执提示）
- `server/fleet-mcp.js` dispatch_post 描述：舰队派发→集群派发、fleet→cluster、cluster posts→array posts（**工具名/输入键零改**）
- `lib/board-adapters.js` 看板 title 舰队概况→集群概况
- `lib/action-preflight.js` 「萬星舰队」→「Wanxing Fleet」（对码设置页实际插件名）

## 不动清单（显式防误翻）

- `技能包`（zip 上传物）全部键：extensions.skills.package.* 等
- `fleet.*` 前缀全部键（Wanxing Fleet 品牌部件）
- `分身` / `AI 分身` / zhiyu 词汇v3 / 定时运行·交付·流转 等收官终词
- 萬星目录、萬星集群等外部产品线引用

## CMS 双语图解课程改版清单（任务 4.2 交付物，移交内容侧）

documentId `ialhphcq8nk7n2qvcqk9fkk2`（《舰队驾驶舱图解》zh/en 双 published）改版项：
1. 标题与全文「舰队驾驶舱」→「集群驾驶舱」；zh/en 各一遍
2. 涉及「创建舰队/舰队概况/舰队名称」等 UI 截图文案的段落，按 B 组新词重写引用（截图本身若含旧词需补拍——内容由截图时点版本决定）
3. 若文中示例引用官方种子名（公司式舰队），改为新显示名 AI 公司
4. 重发不影响线上阅读连续性：CMS 同 documentId 编辑后重新 publish 即可
