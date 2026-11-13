# Design: add-cockpit-orchestration-view

> 纯前端小刀;API 面零改动(cockpit 已回 orchestration 视图对象)。

## D1 · 数据形状(既有)

`detail.orchestration = { mode, constraints, edges: [{kind, from, to, targets, aggregate, rounds, implicit, args?}] } | null`——null 即不渲染。岗位 ref→名:detail.members 建一次 Map。

## D2 · 渲染

树区上方一个 `data-testid="fleet-orchestration"` 面板:第一行模式徽章 + 约束摘要(有才显);边列表每行 `<kind 徽章> 描述`,描述规则:
- trigger:`cron → 岗位名`(边自带 cron 字段则显,否则「定时」)
- report:`岗位名 ↑ 报数`
- dispatch:`岗位名 → 岗位名(派发许可)`
- handoff:`岗位名 → 岗位名(接棒)`
- fanout:`岗位名 ⇒ [名,名] · 聚合:all|first|裁决:名`
- event:`信号源(bot:xx) → 岗位名(唤醒)`
implicit 边加「隐式」小标。类型徽章色:trigger=灰、report=绿、dispatch=蓝、handoff=琥珀、fanout=紫、event=青(既有 tailwind 调色板内)。

## D3 · 不做

边图可视化、写操作、事件流面板改造、移动端差异适配。
