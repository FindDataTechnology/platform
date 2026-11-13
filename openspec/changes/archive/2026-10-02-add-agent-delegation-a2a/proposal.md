# Proposal: add-agent-delegation-a2a

## Why

委派今天只认本 cell 的 persona（`delegate_task` 的 target 恒为 `{type:"persona"}`，a2a change 时明确列为非目标推迟）——市场的 Agent 服务只能被人聊，没有任何 agent 能调用它们协作。Agent 平台程序的协作层（切片 ②，承 grill 共识与 ADR-0010/0013）把委派目标扩到市场的 a2a agent：cell 里的任何角色可以「让市场 agent 替我干一件事」，结果作为任务回到发起会话。探察已钉死全部承重事实：invoke 门=scope 规则 `{agent,actions:[invoke_agent]}`（本机 registry 仅 admin 域有，需一条 ops 前置建 scope）；程序化凭证=`/api/management/iam/users/m2m`（无替用户铸 token 的 API）；调用面 X-Authorization 专用。

## What Changes

- **cell 调用身份（每 cell 一个 M2M caller）**: 平台为 cell 自动开通一个 registry M2M 服务账户（挂 `paas-agent-callers` 组 → 新 scope 仅含 `{agent:"*",actions:["invoke_agent"]}`），凭证存 cell 侧，只用于经网关调用 a2a agent——不碰市场订阅、不发技能。ops 前置一次性：建 scope 与组映射。
- **委派目标扩到 a2a**: `delegate_task` 的 target 增 `{type:"a2a", ref:<catalog agent id>}`；任务经引擎照常排队/聚合，执行为**远端槽**——平台作 A2A 客户端 `message/stream` 到该 agent 的网关路由（复用既有 a2a fork 机器），输出落任务专属会话，汇总回合不变。人格槽的串行策略照旧适用于远端槽的排队纪律。
- **防环：深度上限断链**: 出站 a2a 任务调用带 `X-Delegation-Depth` 头（人发起=1，每跳 +1）；runner 对 depth ≥3 的来话回显式 JSON-RPC 错误拒绝执行——跨请求环在 3 跳内必断，不做全局环检测。
- **并发上限**: runner 对每 agent 的委派来源回合（depth ≥1）设可配置并发上限（默认 2），排队面照旧不失败。
- **两级发现**: `delegate_task` 工具描述只带市场 a2a agent 的**分类摘要**（如「市场·数据分析 3 个」）；新工具 `search_agents(关键词)` 按需返回前 N 个候选（名/简介/分类）供选择——不把全量清单塞进每个 cell 的工具面。
- **权限与计量**: 跨 agent 委派走既有权限模式（echo 先问）；runner 侧 meter 照记（kind=message），cell 侧任务照记 token——③ 的结算接线不动。

## Capabilities

### New Capabilities

- `agent-delegation-a2a`: 跨 agent 委派域——cell 调用身份（M2M caller 的开通/存储/用途边界）、a2a 目标的任务语义（远端槽执行、深度头、结果落会话）、两级发现（分类摘要 + search_agents）、cell 侧并发礼貌。

### Modified Capabilities

- `agent-delegation-tools`: 「Delegate creates a manual task bound to the target persona」目标模型扩 a2a（场景承载 + 新场景：委派市场 agent 成任务、a2a 目标不受自委派检查）；「Delegation tools are available to all personas」工具面增 search_agents。
- `task-engine`: 「A task is the unit of work given to a persona」目标类型增 a2a（catalog 在场的 a2a 条目即为合法 ref；执行走远端槽，槽种口子为既有条款）。执行槽要求不动。
- `agent-runner`: 新增要求「Delegation depth and concurrency are bounded」——depth 头 ≥3 拒绝、每 agent 委派来源并发上限。

## Impact

- **Code**: `server/delegation-mcp.js`（target schema + search_agents + 分类摘要描述）、`server/routes/delegation.js`（a2a 目标校验：catalog 在场）、任务引擎执行路径（远端槽 = `server/agent-session.js` 的 streamA2aChat 改造为可复用执行器 + depth 头）、cell 侧 M2M 开通模块（registry admin API 客户端；凭证存储复用 registry-credentials 的存储面）、`agent-runner/a2a.js`（depth/concurrency 拒绝）、web/MP 任务卡（a2a 目标徽标）+ locales。
- **Ops 前置（一次性）**: 本机 registry 建 scope `paas-agent-callers`（仅 invoke_agent 规则）+ 组映射；平台侧配 M2M 开通用的 admin 凭证（复用 MARKET_REGISTRY_TOKEN）。DEPLOY.md 增 runbook。
- **决策依据**: ADR-0013（M2M 每 cell 调用身份、深度断环、两级发现）；探察事实见程序记忆 ② 节。
- **切片衔接**: ① 已上线（远端槽的排队纪律踩在其驻留生命周期上）；③（计费/准入/console）不动——委派烧被调方配额的现状由 depth+并发+invoke 门三层兜底（ADR-0011 day-one 决策）。

## Non-goals

- 发起方付费结算（③ 的换钥代理路线）；registry allowed_groups 调用时门控（上游不在 invoke 路径强制）。
- 跨请求全局环检测（深度上限即断环，grill 决策）。
- a2a agent 作为「发起方」再委派的人格侧限制（其 runner 侧 depth 拒绝已覆盖）；MC/控制台面。
- 文件/图表类 A2A artifacts（沿 a2a-agent-serving 既有 non-goals）。
