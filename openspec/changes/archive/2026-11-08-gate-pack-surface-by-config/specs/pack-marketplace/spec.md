## ADDED Requirements

### Requirement: 市场面只在网关前置部署出现

市场界面（浏览、详情、订阅、我的包、创作/发布）SHALL 只在部署报告 `packMarketplace`
为真的形态下可达；`/api/config` 报告 `packMarketplace: false` 时，市场面自身的路由
（`/packs` 及其深链 `?tab=`、`?deployCastPack=`）SHALL 拒绝渲染市场壳并重定向到
agent-market 门面（`/agents`），不得留在原地呈现一个没有市场可连的空壳。

判据 SHALL 在市场面自己的路由/页面里执行，而不是依赖某个上层容器是否挂载它——挂载点
会随信息架构搬迁（agents 中心页已于 2026-11-06 拆解，`/packs` 于 2026-11-07 以独立
路由恢复），而这条边界不该随挂载点搬家丢失。判据所用的配置 SHALL 在首绘前已就绪，
避免首次渲染时把网关前置部署误判为本地部署。

非市场面不受此限：已装包管理（更新/卸载）属于运行域，两个部署形态都 SHALL 保留。

#### Scenario: 本地部署访问市场深链

- **WHEN** `/api/config` 报告 `packMarketplace: false`，用户访问 `/packs?tab=market`
- **THEN** 应用重定向到 `/agents` 并渲染 agent-market 门面
- **AND** 市场面（`packs-page`、市场页签、市场卡片）不出现

#### Scenario: 网关前置部署行为不变

- **WHEN** `/api/config` 报告 `packMarketplace: true`，用户访问 `/packs`
- **THEN** 市场面正常渲染，页签与市场列表可用
