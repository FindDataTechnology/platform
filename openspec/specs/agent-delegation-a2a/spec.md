# agent-delegation-a2a Specification

## Purpose

The cross-agent delegation domain: a cell's persona delegates work to a MARKET Agent Service — the per-cell caller identity (registry M2M, invoke-only), a2a-target task semantics (remote-slot execution with a delegation-depth header), two-level discovery (category summary + on-demand search), and caller-side politeness.

## Requirements

### Requirement: Delegated calls carry the deployment's gateway credential

Outbound a2a task calls SHALL ride the cell owner's PERSONAL registry credential (this requirement supersedes the shared-deployment-credential form; same requirement, C-lite settlement) (the per-user market credential the connect flow already stores) as the gateway credential (`X-Authorization`) — the platform ensures the owner's registry account carries the invoke-only caller group, so the personal credential passes the invoke gate with per-user attribution (ADR-0013's C-lite settlement). Deployments without an owner credential (single-owner local machines) SHALL use the deployment's registry service credential and SAY SO in the turn's error surface; the credential's absence on a hosted cell SHALL fail those calls with a structured connect-guidance error, never a silent substitution.

#### Scenario: The owner's credential carries the delegation

- **WHEN** a delegated a2a task call leaves a hosted cell whose owner connected the market
- **THEN** its X-Authorization carries the owner's personal registry credential, and the invoke gate attributes the call to that user

#### Scenario: An unconnected owner is guided to connect

- **WHEN** a delegation is attempted on a hosted cell whose owner has no stored registry credential
- **THEN** the task fails with a structured error directing the user to connect the MCP market, and no other token is used in its place

#### Scenario: The invoke-only scope maps to real identities

- **WHEN** the registry's scopes are inspected after this change
- **THEN** the paas-agent-callers scope carries only the invoke_agent action and is assigned to connecting platform users by the platform's connect flow

#### Scenario: Delegation rides the service credential

- **WHEN** a delegated a2a task call leaves a deployment running under the explicit service-credential fallback
- **THEN** its X-Authorization carries the deployment's registry service credential, stated as such in the deploy surface's configuration notes

#### Scenario: Missing credential fails loudly

- **WHEN** a delegation to a market agent is attempted while no usable credential exists (no owner credential, no service credential)
- **THEN** the task fails with a structured error naming the missing credential, and no other token is used in its place

#### Scenario: The invoke-only scope stays dormant

- **WHEN** no platform user has connected the market in a deployment
- **THEN** the paas-agent-callers scope exists with only the invoke_agent action and maps to no identity until a user connects

### Requirement: An a2a target executes as a remote task

A delegated task whose target is `{type: "a2a", ref}` naming a catalog a2a entry SHALL execute as one A2A `message/stream` call to that agent's registry gateway route (`{registry}/agent/{path}/`, where `{registry}` is the registry gateway base URL resolved from the deployment's registry configuration — never a hard-coded example domain), sent with the cell caller credential on `X-Authorization`, the deployment's agent credential on `Authorization`, and a delegation depth header (below). The streamed reply text SHALL land in the task's dedicated session exactly like a persona execution's output, and the existing aggregation turn SHALL treat it as any finished task. An a2a-target execution SHALL NOT switch or occupy the cell's runtime persona.

#### Scenario: The reply lands as the task output

- **WHEN** a delegated a2a task's stream completes
- **THEN** its text is recorded in the task's dedicated session and the fan-out aggregation summarizes it like any other child task

#### Scenario: No persona switch for remote targets

- **WHEN** an a2a-target execution runs
- **THEN** the cell's interactive runtime keeps its persona and turn stream untouched

#### Scenario: Unknown a2a target is rejected at creation

- **WHEN** a delegate call names an a2a ref that is not in the cell's catalog
- **THEN** the task is not created and the tool returns a structured error naming the unknown target

### Requirement: Outbound delegation calls carry a depth that hops

Every outbound a2a task call SHALL carry `X-Delegation-Depth`: 1 for a human-originated delegation, and the cell's own inbound depth plus one when the cell is itself serving a delegated turn. The header SHALL NOT be set on non-delegation A2A traffic (a human chatting with a market agent is depth 0). The runner side of the bound is specified under `agent-runner` (depth ≥ 3 refused).

#### Scenario: Human delegation is depth one

- **WHEN** a persona delegates to a market agent from a human conversation
- **THEN** the outbound call carries X-Delegation-Depth: 1

#### Scenario: Chained delegation increments

- **WHEN** a delegated turn in this cell delegates onward to another market agent
- **THEN** the outbound call carries this cell's inbound depth plus one

#### Scenario: Plain chats carry no delegation depth

- **WHEN** a human chats with a market agent through the cell's a2a entry
- **THEN** the outbound stream carries no delegation depth header

### Requirement: Discovery is two-level

The `delegate_task` tool description SHALL carry only a category summary of the market's online a2a agents (counts per category), never the full roster. A separate `search_agents` tool SHALL return, for a keyword query, a page of candidates (name, description, category, catalog id) from the currently online a2a entries — the delegating persona picks a ref from those results. That page SHALL be bounded (default 8, caller-settable up to 50) AND SHALL report the number of MATCHES together with whether the page was truncated; a capped page SHALL NOT be presented as the whole match set. The page order SHALL be deterministic (independent of the catalog's scan order), so the same query yields the same page. The summary and search results SHALL derive from the same catalog view that serves human a2a chats, with no separate discovery store.

#### Scenario: The tool description stays small

- **WHEN** the delegation tools are materialized into a cell
- **THEN** the delegate description carries category counts, not the individual agents

#### Scenario: Search returns ranked candidates

- **WHEN** the persona calls search_agents with a keyword
- **THEN** the result lists at most N online a2a agents matching the keyword with their names, descriptions, and catalog ids

#### Scenario: A ref must come from discovery or the roster

- **WHEN** a delegate call names an a2a ref that search or the catalog cannot resolve
- **THEN** the task is refused as an unknown target

#### Scenario: 截断时必须说出真实匹配数

- **WHEN** 关键词匹配到 12 个在线 a2a 条目而默认页只有 8 条
- **THEN** 结果携带匹配总数 12 与「已截断」标志，`search_agents` 的文本写明「showing 8 of 12 matches」并提示收窄关键词或提高 limit

#### Scenario: 页大小有上界且可放大

- **WHEN** 调用方要求 limit=20（或超出上界的 999）
- **THEN** 返回至多 20 条（999 时按 50 封顶），非法或非正的 limit 回落默认 8

#### Scenario: 同一查询得到同一页

- **WHEN** 同一批在线条目以不同内部顺序被搜索两次
- **THEN** 两次返回的候选页完全相同（按名称、再按 id 的确定性排序）

### Requirement: 出站 A2A 调用受明确时限约束且超时可归因

每一次出站 A2A 调用 SHALL 受一个明确的时间上界约束。上界到点时调用 SHALL 以结构化、可归因的失败结束
（错误类别进入既有错误分类，供回合台账记录），SHALL NOT 继续挂起等待远端。调用方提供了取消信号时，
内部上界与外部取消 SHALL 联动生效；两者任一先到 SHALL 结束该调用。上界到点 SHALL NOT 以未捕获异常
的形式影响宿主进程——无论调用方是否提供取消信号。

#### Scenario: 无取消信号时上界结束调用

- **WHEN** 一个未提供取消信号的出站 A2A 调用指向一个接受连接但永不返回事件的远端
- **THEN** 该调用在声明上界处结束，返回结构化超时失败，宿主进程继续存活

#### Scenario: 提供取消信号时两者联动

- **WHEN** 调用方在内部上界之前主动取消其控制器
- **THEN** 该调用立即以取消失败结束，内部上界随后到点不再产生第二个动作（不得抛出未捕获异常）

#### Scenario: 上界到点不得逃逸为未捕获异常

- **WHEN** 内部上界到点，且调用方提供了取消信号
- **THEN** 宿主进程不产生未捕获异常、不退出；该调用以结构化失败结束

#### Scenario: 上界内正常返回不受影响

- **WHEN** 远端在上界之内正常返回结果
- **THEN** 返回的文本与本次变更前一致，调用方行为不变

### Requirement: 委托回合的单次远端调用以该回合下传的预算为上界

由巡时/派发/接棒等车队回合发起的 A2A 调用，其上界 SHALL 取调用方下传的回合预算；客户端 SHALL NOT
以内建默认值顶替已下传的预算。回合预算小于远端无响应时长时，SHALL 在预算内以结构化失败结束该回合，
并释放其占用的执行位。调用方未下传预算时，SHALL 回退到一个明示的有界默认值，SHALL NOT 无界等待。

#### Scenario: 远端无响应时回合在预算内失败

- **WHEN** 一支车队岗位的回合上界为 N，其 A2A 目标在 N 内无任何事件
- **THEN** 该回合约在 N 处落为失败、错误归类为超时、执行位释放给下一个回合

#### Scenario: 下传的预算不被内建默认值顶替

- **WHEN** 调用方下传的回合预算为 N 且 N 小于客户端内建默认值，远端在该预算内无任何事件
- **THEN** 该调用约在 N 处结束（而非在默认值处结束，也非永不结束）

#### Scenario: 未下传预算时有界兜底

- **WHEN** 调用方既未提供取消信号、亦未下传回合预算，远端无任何事件
- **THEN** 该调用在默认上界处结束，SHALL NOT 挂起等待远端
