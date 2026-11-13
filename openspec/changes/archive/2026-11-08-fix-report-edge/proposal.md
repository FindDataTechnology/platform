# Proposal — fix-report-edge

## Why

`report` 是**死语法**（explore P2-2）：它在 `EDGE_KINDS` 里、六种语言都有文案
（`orch.edge.report` / `orch.phrase.report`）、驾驶舱也照它渲染「X ↑ 报数上行」——
但**没有任何代码消费它**。它声称描述的"报数拓扑"其实只由一处承载：`member.parentId`，
而报数通道与巡视上下文走的正是 `parentId`。

于是它可以随便写、写成假的也没人管：一条 `report: B→C` 会出现在图上，而 B 的报数照样
进它的真实上级。**声明与事实可以矛盾，且没人报错。**

## What Changes

- **派生**：`expandedEdges` 为每个有上级的岗位生成一条 `from=该岗, to=其上级` 的 report 边
  （`derived: true`），读时计算、不落库——拓扑从此完整且必然为真。
- **校验**：`validateOrchestration` 接受与该树一致的声明（不重复呈现），拒绝与之矛盾的声明
  并指名真实上级。
- **顺手**：`expandedEdges` 对 `orchestration: null` 幂等（原先会被默认参数漏过而抛错；
  生产两个调用方都有守卫，不构成线上缺陷，但函数不该依赖调用方）。

## Impact

- Affected specs: `agent-fleet-orchestration`（1 处 MODIFIED：orchestration 声明段）
- Affected code: `server/fleet-orchestration.js`（`expandedEdges` / `validateOrchestration` / 头注释）
- 生产数据核查：prod 2 支舰队、**零**条 report 声明，无迁移风险；其他 cell 若有"说谎"的
  声明，保存时会被明确拒绝并告知真实上级（一行删除即可）。
- **模板路径必须投影 `parentRef`**：舰队模板的成员用 `parentRef` 表达上下级，而编排校验读的是
  `parentId`；原先的投影只带 `id`/`targetKind`，于是官方种子里**真实存在**的
  `reviewer.parentRef=editor` 在校验时看不见——`content-factory-fleet` 因此被误判。
  投影补上 `parentId: parentRef` 后，官方种子库 11 个清单全过。
- 前端零改动：它本来就渲染 report 边。
