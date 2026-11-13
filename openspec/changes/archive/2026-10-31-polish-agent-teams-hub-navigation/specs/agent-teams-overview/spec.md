# agent-teams-overview Specification (delta)

## MODIFIED Requirements

### Requirement: 一点进驾驶舱

任一支团队在综合看板、管理面或经营面上的任一入口 SHALL 直达该团队的驾驶舱（路由变为 `/fleets/:fleetId`，既有深链），MUST NOT 以页内 state 就地展开单团队的深钻内容。点开后的团队态 SHALL 保留三视图切换条可见可达（见「三视图切换条常显」），浏览器后退 SHALL 回到点开前的 hub 视图与滚动位置。

#### Scenario: 卡片点击进驾驶舱

- **WHEN** 主人点击某支团队的卡片
- **THEN** 路由变为 `/fleets/<该团队 id>`，呈现该团队驾驶舱（画布/编队/检查器），综合看板不再是主位

#### Scenario: 后退回到点开前的视图

- **WHEN** 主人从经营面点开一支团队后按浏览器后退
- **THEN** 回到经营面（`/fleets?view=owner`），而非默认的综合看板

## ADDED Requirements

### Requirement: 三视图切换条常显

`/fleets` hub 的三视图切换条（综合看板 / 管理 / 经营）SHALL 在所有 hub 态与团队态（`/fleets/:fleetId`）下一律渲染可见：当前所在视图或团队所属来源视图高亮；点击任一视图 SHALL 离开团队态回到该视图；切换条 MUST NOT 因选中/进入某支团队而隐藏。团队态下点击切换条以外的返回途径（面包屑、导航重进）亦 SHALL 落回最近一次 hub 视图。

#### Scenario: 驾驶舱内切换条仍在

- **WHEN** 主人处于 `/fleets/<id>` 驾驶舱
- **THEN** 顶部可见综合看板/管理/经营三枚 tab，点击「管理」直达管理面表格

#### Scenario: 高亮跟住来源

- **WHEN** 主人从综合看板点开团队进入驾驶舱
- **THEN** 切换条呈现来源态（综合看板）为高亮，经营/管理可点

#### Scenario: 深链直接进团队也不破

- **WHEN** 主人以书签直接打开 `/fleets/<id>`
- **THEN** 驾驶舱照常呈现且切换条可见，点击任一视图正常落位（无来源态时不强制高亮）
