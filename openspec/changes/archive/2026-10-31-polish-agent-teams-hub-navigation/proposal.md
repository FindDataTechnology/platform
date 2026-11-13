# Proposal: polish-agent-teams-hub-navigation

## Why

智能体团队 hub 的两处日常摩擦：其一，三视图切换条（综合看板/管理/经营坞）在选中一支团队时被实现整体隐藏（`FleetsPage` 的 `!selected` 分支），且选中走的是页内 state 而非路由——用户点进细分视图后切换条"消失"、URL 不变、浏览器返回也出不来，这同时偏离 agent-teams-overview「一点进驾驶舱」已有的"点卡片直达 `/fleets/:id`、不得就地展开"条款。其二，「经营坞」一词看不懂：那面装的是团队状态、花销、营收、版本跟新与迭代提议，本质是一张老板的经营账本，用户裁决终词为「经营」。

## What Changes

- 视图切换条常显：在 `/fleets` 的三种 hub 态（综合看板/管理/经营）与选中/进入某支团队的驾驶舱态下，三枚视图 tab 一律可见、可点；当前态高亮，点击离开团队回到对应视图。实现以路由为准（选中团队 = `/fleets/:fleetId`），删除"选中即隐藏切换条"的分支。
- 点卡片直达驾驶舱路由：综合看板/管理/经营三面上点开团队一律走 `/fleets/:id` 深链（对齐既有 spec），浏览器前进/后退与书签语义成立。
- 终词改名：`agentTeams.views.owner` 用户可见值 zh-CN「经营坞」→「经营」，en "Owner board" → "Operations"，其余副轨（es/fr/ja）按同一语义落值；**键与 API 不动**，历史文档/归档 spec 不回改（lexicon 冻结史条款沿用）。

**非目标**：不改三视图各自内容；不动驾驶舱内部布局（cockpit 自成一张脸的其余设计保留）；不引入面包屑组件（切换条常显后不需要）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-teams-overview`: 「一点进驾驶舱」补齐实现与 spec 的对齐条款（点开即路由，不就地展开）；新增「三视图切换条常显」需求——任何 hub 态与团队态下切换条可见可点、当前态高亮、离开团队不失忆。
- `native-lexicon`: 新增终词条款——owner 视图用户词「经营」，键不动、只改五语言值；历史文案冻结沿用既有 out-of-scope 条款。

## Impact

- Web：`web/src/pages/FleetsPage.tsx`（删 `!selected` 隐藏分支、选中改路由驱动、tab 在 `/fleets/:fleetId` 下渲染并正确高亮）。
- i18n：`web/src/locales/{zh-CN,en,es,fr,ja}/common.json` 各改 `agentTeams.views.owner` 一枚值（locale 完整性门跑绿）。
- 测试：`teams-view-switch` 相关既有单测/e2e 场景随行为更新（切视图后 back 语义、tab 在团队态可见）。
- 不动：`/api/fleets*` 读面、驾驶舱（FleetGraph/cockpit-v2）本体、`?view=` 查询参数既有语义。
