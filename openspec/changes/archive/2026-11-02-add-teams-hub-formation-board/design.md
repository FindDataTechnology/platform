# Design: add-teams-hub-formation-board

## Context

见 proposal.md - Why。复用资产（代码核实）：`FleetGraph` 是零依赖纯 SVG 阵形图（GraphMember/GraphEdge/分层布局+kind 着色），组件级可参数化成 mini 形态；`CopilotDock` 是全局右停靠面（iframe 隔离 useChatStore 单例、board/preset 走 URL+postMessage、聚焦 preset 机制）；架构师三段工具面（草稿 dry-run→diff+成本→批准 apply）与编排变更广播均在产。性能前车之鉴：`fix-session-open-latency` 实测名册 N+1 把首帧拖到秒级——本刀阵形数据必须随聚合面一次到齐。

## Goals / Non-Goals

**Goals**：看板一眼见形、断线可见、点开进舱、副驾一句话改线（先 diff 后批准）。
**Non-Goals**：团队间超级节点拓扑、新编辑手势、驾驶舱与架构师语义变更。

## Decisions

**D1 · 聚合载荷扩展而非新端点。**
`GET /api/fleets/overview` 加每队 `formation:{members:[{id,title,targetKind,state}],edges:[{kind,from,to}]}` 紧凑摘要；字段增位向后兼容，老客户端忽略即走。备选（前端并发 N 次详情、或新 `/formation-summary` 端点）分别败给 N+1 教训与"第四份状态计算"禁令边缘。

**D2 · FleetGraph 参数化 mini 形态，不动布局算法。**
mini=去标签文字（节点缩为点+title tooltip）、密度参数、状态色覆盖；布局函数同一份。备选（看板另写简化图）否决：kind 着色/分层语义会分叉，驾驶舱与看板对同一编排呈现不一致。

**D3 · 副驾=复用 iframe 停靠面 + 架构师聚焦 preset，不新造对话组件。**
`CopilotDock` 的 store 隔离（iframe 各自文档/WS）恰好看板↔主聊天并存所需；聚焦 preset 机制现成指向架构师 pack（未安装=降级条款）。看板上下文经 URL/postMessage 注入（名册与选中队 id），架构师 tool 面零改动。

**D4 · 切换态持久化走用户偏好层（与侧栏折叠态同族），不落服务端新表。**

## Risks / Trade-offs

- [大团队（几十岗）mini 图溢出栅格] → mini 密度上限 + 超限缩略（"N 岗…"占位），完整阵形留给驾驶舱；不引入画布缩放。
- [载荷扩展让 overview 响应变胖] → 摘要字段裁到渲染必需（无历史/无 token 之类），栅格懒渲（视口外不实例化 SVG）。
- [副驾改线与看板态竞态（apply 后名册未刷）] → 重渲以编排广播为唯一真源，广播未到前 diff 面不承诺新态。

## Migration Plan

字段增位+纯增益 UI：服务端先上（载荷扩展对老客户端无害），web 后上。回滚=web 回退即可，载荷字段留存无害。

## Open Questions

无（mini 密度阈值、栅格列数在 apply 期按实测定）。
