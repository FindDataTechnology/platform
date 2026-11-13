# Proposal: add-cockpit-edge-graph

## Why

驾驶舱 v2 的「边图主位」决议(底账 §十五)目前只做到了面板置顶+列表呈现——编排关系仍是文字行,超过四五条边后形状不可感。完整边图 = 岗位为节点、编排便为有向边的分层图,一眼看清「谁触发谁、流转到哪、谁裁决」。

## What Changes

- **编排图组件**(新 `web/src/components/FleetGraph.tsx`,纯 SVG 零新依赖):分层布局(源=定时/事件等外部节点与无入边岗位,沿声明边分层,环按回边画曲线不参与分层),岗位芯片(标题+类型色)+外部源虚拟节点(cron/事件信号),边为类型色贝塞尔曲线+箭头,图例;隐式派发许可**不画边**(顶部聚合条沿用既有 implicitAll 文案);fanout 的裁决关系入边悬停提示(详单在下方既有列表)。
- **面板接线**:编排区顶部插图(现有文字列表保留在其下,作精确读法);未声明编排或无边不渲染图。
- i18n:orch.graph 标题 + 图例复用 orch.edge.*。

## Capabilities

### New Capabilities
(无)
### Modified Capabilities
- `agent-fleet-cockpit`: ADDED——驾驶舱以分层有向图呈现编排声明(节点/边/图例/隐式聚合不画边/未声明不渲染)。

## Impact

- 代码:新组件+FleetsPage 接线+五语言两键;纯前端,typecheck 既有回归即验收,浏览器眼见随下班车。
- 非目标:节点拖拽编辑、实时回合动画、状态着色(下期)、图上写操作。
