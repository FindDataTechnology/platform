# Proposal: modernize-lagging-surfaces

## Why

设计地基批（`harden-web-design-foundation`）给全站换上了可继承的原语与色彩词表；本单是「门面」批——2026-11-02 impeccable 生产视觉评审中判 2/4 的六面已经滑向「任意 SaaS 模板脸」，是「展示层大幅落后」观感的直接来源：Apps 被评审点名「icon-wall + 搜索框 + 蓝 CTA，可以是任何插件商店」；Memory 卡片节奏单调、durable/episodic 无分层、紫标签漏第二灯；Zhiyu 首页一屏三盏蓝 + 渐变英雄区（违背自家 Night Workbench 教义）；Fleets hub 九张卡同位九枚蓝链=灯成装饰、页头被筛选条压住；Resources 四根进度条蓝/青/橙/红集齐彩虹、统计数三种字号；Agents 饱和 emoji 头像与蓝 CTA 抢焦、卡内层级平坦。这批页面各自的功能契约是健全的（spec 与走查都过），落后的是**视觉与信息的组织方式**——正是地基批之后、只有门面批能治的病。

用户已裁决（2026-11-02）：方案形态 = C 混合三批，本单为批②。

## What Changes

六面在批①原语（Card / StatusPill / PageShell / EmptyState / Tabs / Tooltip）与「灯+状态+序列」三层色彩纪律之上重做门面，每面一条主判据：

- **Apps（`/apps`）**：去模板脸，执行 `app-center` 既有的「项目联邦」立意——每卡承载该产品**真实在场信号**（连接态用 StatusPill、可用性如实标注、最近使用节律），搜索/网格降为辅助；让这面一眼「只有壹座能长这样」。
- **Memory（记忆面板）**：durable / episodic 分层结构（分组标题 + 层级徽章走状态词表），卡片节奏按重要度分级（锚行/普通行两档），紫标签并入词表，时间线可读性优先于瀑布流。
- **Zhiyu 首页（`/zhiyu`）**：删渐变英雄区与三重蓝灯（输入环/CTA/胶囊同屏三亮），页头与输入的主次归位；空间列表走 Card/StatusPill；教义回正后首页应像「一间房的门口」而不是「一块展板」。
- **Fleets hub（智能体团队总览）**：撤卡片右下角九枚装饰蓝链（卡片整体可点即可），页头经 PageShell 归位于筛选条之上，成员头像与统计胶囊吃状态词表；编队视图的迷你图形保持现状（评审判为 authored）。
- **Resources（配额/计量面）**：多系列计量统一走 `--series-1..4` 序列色阶、单系列一律灯蓝；统计数字一套字号层级（大数/单位/标签三档）；tile 间距节奏统一。
- **Agents 目录（`/agents` 内构建器总门面的供给区）**：头像纪律（饱和 emoji 壁→统一单色 initials 卡或产品图标体系，二选一由 design 定），卡内层级重排（名称>描述>状态/统计>标签），标签数量上限 + 溢出收纳进 Tooltip。
- **Non-goals**：不改信息架构与路由（`agent-builder-hub` 管门户结构，本单只在其落位内换皮换层级）；不动数据层、端点、WS 契约；Chat / Studio / Machines 三面维持（评审 3/4，教义执行良好——refinement preserves，不碰）；miniapp 与官网不搭车。**非 BREAKING**。

## Capabilities

### New Capabilities

（无——本单是六条既有页面能力的表现层需求演进。）

### Modified Capabilities

- `app-center`: 卡片在场信号与「项目联邦」呈现的需求从功能可达升级为视觉可辨（连接态/可用性标注的呈现契约）。
- `memory-portal-ui`: 记忆浏览新增分层语义（durable/episodic 分组与徽章）为可测需求；色标须走状态词表。
- `zhiyu-room`: 首页呈现契约纳入「一盏蓝灯」纪律（禁渐变英雄区；主操作唯一亮灯）——房间行为与协议需求零改动。
- `agent-teams-overview`: hub 卡片网格的链接呈现、页头层级、状态胶囊词表化为需求。
- `resource-library-ui`: 计量多系列/单系列的色彩选择与统计数字层级成需求。
- `agent-catalog`: 目录卡头像体系、卡内信息层级、标签溢出呈现成需求（构建器四区结构不动）。

## Impact

- **web**：`pages/AppCenterPage.tsx`、`pages/MemoryPage.tsx`、`pages/ZhiyuPage.tsx`、`pages/FleetsPage.tsx`（hub 视图段）、`pages/ResourcesPage.tsx`、`pages/AgentsPage.tsx`（供给区面板）六面门面重做；全部消费批① `ui/` 原语，design-lint 棘轮随改随紧（六面的基线条目应清零）。
- **Server / API / WS**：零改动（纯展示与组织；数据源与端点原样）。
- **桌面**：同一代码自动覆盖；走查含桌面一次（parity 约束）。
- **i18n**：新分层标签、空态引导句等产生五语言增量串，`check:locales` 硬门照跑。
- **排期协调（开工前置，红线）**：① 批①`harden-web-design-foundation` 已合入；② 在途 change 收班——`add-agent-builder-hub`（12/14，AgentsPage 四区重组）、`add-knowledge-memory-surface`（10/13，MemoryPage）、`add-teams-hub-formation-board`（9/11，FleetsPage hub）——三支未归档前不得动同名文件，否则按并行会话劫持律撞车；③ 与批③ `unify-operate-states` 在 `zhiyu-room`/FleetsPage 上同文件不同需求段，本单先行、③ 后开。
- **验收**：六面生产截图批次过 impeccable 视觉复评（目标 ≥3/4 每面），e2e fast 全绿，真机走查（aloadtree 账号配方）六面各过一遍；Apps/Memory 两面须答得出「哪些元素让它只能是壹座」。
