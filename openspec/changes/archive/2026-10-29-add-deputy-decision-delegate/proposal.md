## Why

拍板队列只进不出：66 条 open（公司式集群 39、萬星 19），唯一裁决者是主人手动，而 CEO 巡逻每轮把未解决的阻塞换措辞再升级（无去重），过期清扫又是惰性的——主人不打开舰队页队列就永不消化。实测（2026-10-28，台账 §15.79）显示 66 条里多数不是「二选一的判断」而是无人执行的问题单，且 38 条 high 中一批是真实的平台侧缺陷。主人需要一个可配置的委托机制：让一个 AI（常务岗）按主人授权替自己裁决/分流/跟踪，并用记忆系统汇报它做了什么、做到什么地步。

## What Changes

- **委托策略（可配置）**：cell 级默认 + 舰队覆写的 delegation policy——按类别路由（例行运营→常务岗独立裁；问题单→常务岗去重归并+跟踪；配置改动/人事/花钱→永远主人）、maxSeverity、日预算、裁决模型、digest 频率。escalate 时同步路由（route = owner | deputy）。
- **常务岗（决策代理）**：舰队内 opt-in 的 persona 岗位（模板/加岗），自带巡逻节奏；MCP 工具面 = 队列读取、裁决、上下文与判例读取、记忆读写。裁决走服务端强制授权（resolve 工具按策略校验，越权 403 并转回 owner）——AI 的权限由服务端闸定，不靠提示词。
- **裁决与判例**：裁决携带 `resolved_by`（owner|deputy）、`resolved_by_model`、`ruling_evidence`（依据 + 引用的主人过往判例）；判例读自主人记忆/决策历史，保持与主人过往裁决一致。
- **去重与问题单分流**：escalate 同步层按「同岗位 + 近 N 天语义相似」归并到既有项（治理重复升级的膨胀引擎）；问题单类由常务岗归并跟踪、一次性带分析上报，而非每轮重复。
- **执行追踪（做到什么地步）**：状态机在 `delivered` 后补 `executed_*`（回填送达回合）与 `outcome`（从该回合报数/会话派生）——「批了没执行」与「执行了且完成」可见。
- **记忆镜像与角标语义**：deputy 裁决/进度沿既有拍板送达缝镜像进主人记忆 reference 层；「等你 N 件」角标改计 route=owner 的 open 项——委托后不再算主人头上。
- **设置面**：主人可配置委托策略与查看常务岗活动（裁决历史/跟踪中的问题单/上报项）。

## Capabilities

### New Capabilities

- `agent-fleet-decision-delegate`：拍板委托——委托策略模型与路由、常务岗角色与工具面、服务端强制授权（mandate gate）、去重归并、裁决身份与判例、执行追踪、记忆镜像与角标语义。

### Modified Capabilities

- `agent-fleet-decision-lane`：拍板项新增 route 归属与裁决者身份（resolved_by/evidence）；「等你 N 件」徽章语义改为只计 route=owner；escalate 增加同步去重归并。
- `agent-fleet-core`：decision_items schema 增量（route/resolved_by/ruling_evidence/executed_*）；名册读面与拍板队列读面暴露裁决者身份与执行状态。

## Impact

- `server/routes/fleets-db.js`：decision_items schema 与策略读写、去重查询、路由字段。
- `server/routes/fleets.js`：escalate 同步路由 + 队列读面（按 route 过滤）+ 裁决路径的身份与强制校验；名册行角标计数口径。
- `server/fleet-decisions.js`：状态机/校验扩展（resolved_by、evidence、去重）；决策段渲染带裁决者身份。
- 新增：常务岗模板（persona + 工具面）与巡逻任务；deputy 专用 MCP 工具（或既有 fleet-mcp 扩展）。
- 前端：舰队页拍板队列显示裁决者/执行状态；设置面委托策略；侧栏角标计数口径。
- 记忆：`memoryRefClientFor` 镜像扩展到 deputy 裁决与 digest。
- 测试：决策车道既有合同（首裁定局/过期/送达/分段注入）回归 + 新增委托策略/强制授权/去重/执行追踪。
- 风险边界：config-change/人事/花钱三类 SHALL NOT 委托（沿用既有回调与审计语义）；常务岗越权由服务端拒绝而非提示词约束。