# agent-fleet-cockpit Delta — add-cockpit-edge-graph

## ADDED Requirements

### Requirement: 驾驶舱以分层有向图呈现编排声明

已声明编排的舰队,驾驶舱编排区 SHALL 在文字列表之上呈现一张分层有向图:岗位为节点芯片(标题与类型标识),定时触发与事件信号源 SHALL 以外部源虚拟节点呈现,每条显式声明边 SHALL 为类型色的有向曲线(含箭头与类型图例);布局 SHALL 分层(源在左,沿边递增),声明环 SHALL 以回边曲线呈现且不参与分层。supervisor 隐式派发许可 SHALL NOT 画边——以聚合条呈现(既有文案)。fanout 的裁决岗关系 SHALL 至少在悬停提示中可见。未声明编排或无边时 SHALL 不渲染图(文字区与现状一致)。

#### Scenario: 流水线成形

- **WHEN** 一支声明 cron→抓取、抓取→清洗、清洗→撰稿 的舰队打开驾驶舱
- **THEN** 图中四节点三层(定时源/抓取/清洗/撰稿),三条边按类型着色,图例可见

#### Scenario: 隐式许可不画边

- **WHEN** 一支 supervisor 模式舰队(56 对隐式派发)打开驾驶舱
- **THEN** 图中不出现隐式派发边,聚合条一行呈现许可摘要;显式边照常画出

#### Scenario: 未声明零渲染

- **WHEN** 一支未声明编排的舰队打开驾驶舱
- **THEN** 不出现图区,视图与现状一致
