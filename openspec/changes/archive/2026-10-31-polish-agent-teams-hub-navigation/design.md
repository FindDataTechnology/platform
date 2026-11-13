# Design: polish-agent-teams-hub-navigation

## Context

见 proposal.md - Why。现状：`FleetsPage` 用页内 `selectedId` state 展开驾驶舱并 `!selected` 隐藏切换条；`/fleets/:fleetId` 深链与页内选中是两套并行机制，点卡片走的是后者（偏离 spec「一点进驾驶舱」的路由条款）。

## Goals / Non-Goals

**Goals**：一套机制——选中即路由；切换条全态可见；改名只动 i18n 值。
**Non-Goals**：驾驶舱内部布局、`?view=` 参数语义、cockpit 数据链。

## Decisions

**D1 · 删除页内 selected 分支，选中=导航到 `/fleets/:id`。**
备选（保留页内 state、仅把切换条常显）否决：双机制并存下"后退/书签"仍只覆盖深链一路，两套状态要各修各的高亮，比统一到路由更贵。统一到路由后 `?view=` 只属于 hub 态（`/fleets`），团队态无视图歧义。

**D2 · 切换条在团队态渲染时高亮"来源视图"，来源由进入路径决定，深链无来源则不高亮。**
备选（团队态强制高亮综合看板）否决：从经营/管理点进的人回头想找的是原视图。来源态存 sessionStorage 级别即可，刷新后按"无来源"处理，不新增持久层。

**D3 · 改名走 i18n 值改写（键/API/查询参数全不动），沿用 lexicon v4 "键不动改值"先例。**

## Risks / Trade-offs

- [页内 state 改路由会触碰选中相关既有测试] → 更新断言而非跳过；`teams-view-switch` e2e 三条新断言（团队态可见/来源高亮/后退回源视图）。
- [来源态 sessionStorage 在跨标签页场景失真] → 可接受降级为"无来源=不高亮"，不引入后端状态。

## Migration Plan

纯前端+文案，一次滚版即全量；回滚=代码回退，键未动故 i18n 回退无损。

## Open Questions

无。
