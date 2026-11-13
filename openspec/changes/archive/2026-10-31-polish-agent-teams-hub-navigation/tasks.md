# Tasks: polish-agent-teams-hub-navigation

## 1. 切换条常显 + 选中即路由

- [x] 1.1 `FleetsPage.tsx` 删除 `!selected` 隐藏分支：切换条在 `/fleets` 三 hub 态与 `/fleets/:fleetId` 团队态一律渲染；点卡片/行/经营面入口改为导航 `/fleets/:id`（页内 selectedId 展开机制移除）；既有单测断言更新且 `teams-view-switch` 全绿
- [x] 1.2 来源态高亮：从某视图点进团队时 sessionStorage 记录来源视图，团队态下切换条高亮来源、点任一视图离开团队落回之；深链直达无来源则不高亮；新增/更新 e2e 三断言（团队态切换条可见、来源高亮、后退回源视图含滚动）
- [x] 1.3 后退语义验证：`/fleets?view=owner → 点团队 → 浏览器后退` 回经营面而非默认综合看板；e2e 一条断言锁死

## 2. 终词改名「经营」

- [x] 2.1 五语言 `agentTeams.views.owner` 值改写（zh-CN「经营坞」→「经营」，en "Owner board"→"Operations"，es/fr/ja 同语义落值；键/路由/查询参数零改动）；跑 locale 完整性门绿
- [x] 2.2 全树 grep「经营坞/Owner board/オーナーボード」确认活面残留清零（归档 spec、docs 历史、台账按冻结史条款不回改，清单式记录例外）
  - 例外清单（非用户面，均为代码注释，未改）：`web/src/components/fleet/OwnerBoardStrip.tsx:1`、`web/src/lib/fleet-owner-api.ts:1`、`server/routes/fleets.js:1128`

## 3. 门与收口

- [x] 3.1 `test:unit` teams 相关合同套（fleet-core 21/21、fleet-batch 6/6、fleet-architect 11/11、fleet-decision-lane 10/10）+ `fleet-hub` e2e 6/6 + web typecheck + biome + locale 门 + `openspec validate` 全绿
- [x] 3.2 真机走查挂账登记（滚动切换条全态可见 + 改名上眼），台账 §15.102 记录本刀终态与挂账

