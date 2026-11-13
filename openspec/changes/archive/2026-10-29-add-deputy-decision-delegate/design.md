## Context

拍板车道现状（openspec: agent-fleet-decision-lane，已上产）：escalate（MCP 工具）→ decision_items（open）→ 主人批复/驳回 → 注入管线（5 条/轮）或立即执行 → delivered；72h 惰性过期（只在读舰队页/escalate 时清扫）；防洪 = 10/岗位/天 + 队列 50。主人是唯一裁决者，schema 无裁决者身份字段。实测（2026-10-28）：66 条 open、20 条历史 resolved，重复升级占大头且无去重。

## Decision 1：委托裁决是「同一状态机上的另一裁决者」，不是新状态

选项：(a) 加 `delegated` 等新状态；(b) 保持五态（open/approved/rejected/expired/delivered），增加**裁决者维度**（resolved_by / resolved_by_model / ruling_evidence 字段）。采纳 (b)：状态机与 `DECISION_TRANSITIONS`、注入管线、过期语义全部不动；deputy 的裁决就是一个 approved/rejected，只是 resolved_by=deputy。审计靠新字段，不靠状态枚举膨胀。

## Decision 2：路由是字段，在 escalate 时同步打上

`route: 'owner' | 'deputy'` 在 escalate 落库时按当次生效策略计算（规则先行，确定性）。理由：策略评估必须同步（岗位在等升级回执）、必须可解释（哪条规则路由的）、且不得被 deputy 事后影响。`reCollection`（主人收回）= 更新 route 字段，非状态迁移。

## Decision 3：强制授权在服务端 resolve 路径上，不在提示词里

常务岗的 MCP `resolve` 工具在服务端逐项校验：类别 ∈ 委托白名单、severity ≤ maxSeverity、日预算未超。越权 → 结构化 403 + 条目转 route=owner。理由：提示词约束可被长上下文稀释，而「AI 把花钱决策批了」是不可逆事故；服务端闸让委托的信任模型可被测试钉住。config-change / 人事 / 花费三类硬编码不可委托（config-change 的批准触发动作回调，见 agent-fleet-decision-lane 既有 spec）。

## Decision 4：常务岗 = 舰队内 persona 岗位，不是独立服务

- 报数管线、节奏调度、MCP 工具面、记忆集成全部继承——常务岗自己的巡逻回合产出就是「做到什么地步」的观测面。
- cell 级独立集群（跨舰队）留 v2：需要新的跨舰队工具面与隔离设计，当前一个重度用户先受益于 per-fleet。
- 头像/命名遵循产品词典（主人可改）。

## Decision 5：去重做两层，语义归并用「提交方声明 + 相似度」而非硬编码

- **同步层（escalate 时）**：同 member + 近 7 天 + 相似（embedding 或提交方声明的 topic 键）→ 关联既有项（escalations+1），不落新行。拒绝跨岗位归并。
- **常务岗巡逻层**：对存量做归并 triage（把 66 条压缩成唯一事项集），并维持问题单跟踪视图。
- 不做全局跨岗位去重：不同岗位报告同名基础设施问题可能是不同视角，误并会吞掉真实信号。

## Decision 6：执行追踪用字段回填，不用状态迁移

`delivered` 保持终态，增加 `executed_at` / `executed_session_id`（送达回合完成时由回合完成钩子回填）；`outcome` 从该回合的报数/会话派生，不落新表。理由：状态机迁移需要动 `DECISION_TRANSITIONS` 与所有读面，而事实就是两个字段；「批了没执行」= delivered 且无 executed_at。

## Decision 7：记忆双向——判例读 + 作为写

- 读（判例）：deputy 裁决前读主人过往同类裁决（decision 历史 + 主人记忆 D7 读缝），依据文本 MUST 引用判例（拍板项 id 或记忆条目），保证代理裁决与主人偏好一致。
- 写（汇报）：裁决即时镜像（复用拍板送达的 `memoryRefClientFor` 缝，resolved_by=deputy）+ 常务岗巡逻回合的报数 + 按策略频率的 digest（进主人记忆 reference 层）。

## Decision 8：角标口径变更要显式迁移

「等你 N 件」从「open 总数」改为「route=owner 的 open 数」。发布时存量 66 条按策略重路由（一次性 triage pass），否则角标语义变了数值没变。主人设置面需明示新口径。

## Risks

- **代理误裁**：服务端闸 + 判例约束 + no-context-takeover 式预算封顶 + 主人可随时收回；deputy 裁决的条目在 UI 与 owner 裁决视觉区分，出错可 reopen（既有语义）。
- **判例污染**：deputy 的裁决本身会成为「历史」，若把 deputy 裁决当判例喂回去会自我强化——判例源 SHALL 只取 owner 的裁决（resolved_by=owner）。
- **prompt 注入**：拍板项的问题文本来自岗位回合（可能含被注入内容）；deputy 读队列时的上下文隔离与工具白名单沿用现有 MCP 治理，裁决输出走 schema 校验（validateResolution 扩展）。
- **预算失控**：dailyBudget 是硬闸（服务端计数），deputy 巡逻节奏本身也是成本——默认 1 小时并可配。