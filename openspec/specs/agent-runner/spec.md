# agent-runner Specification

## Purpose
Defines the multi-tenant runtime that hosts deployed Agent Services: per-role dsh children composed from the deployment descriptor, the A2A adapter surface, session mapping, child lifecycle policy, and inbound authentication against the registry gateway.

## Requirements

### Requirement: One dedicated runtime child per deployed role

The runner SHALL host each deployed Agent Service as a dedicated runtime child with its own private runtime home, composed from the deployment descriptor — OR, under pod mode (add-dsh-pod-adapter), as a member of the one shared pod runtime for its pack deployment (see: Same-pack serving agents may co-host in one pod runtime); in both shapes the member's composition SHALL be driven by the deployment descriptor: the role's persona, its declared skills (fetched from the registry's skill entries), and its declared MCP references. The runtime child SHALL be driven through a harness adapter (openspec: harness-adapter): the dsh harness is the default, and a descriptor MAY declare another harness the hosting runner supports — the child's observable behavior (composition from the descriptor, model precedence, service-quota inference, drain-and-respawn upgrades) SHALL be identical whichever harness hosts it. The child's (member's) inference model SHALL be the descriptor's effective model when it records one, else the runner's deployment-level default model (ADR-0019); and its inference SHALL consume the runner's service quota — never a user's. A change of the descriptor's effective model SHALL take effect by the upgrade-grade drain-and-respawn: in-flight turns drain, the runtime respawns on the new model within the five-minute window, and no other restart channel is introduced (in pod mode the drain-and-respawn unit is the pod). The child's MCP outbound calls SHALL authenticate with the runner's service credential.

#### Scenario: Composition from the descriptor

- **WHEN** the runner materializes a deployed role whose descriptor declares a persona, two skills, and one MCP reference
- **THEN** the child boots with that persona and exactly those skills and MCP servers available

#### Scenario: Model is a runner concern

- **WHEN** a deployed role serves a turn
- **THEN** the turn runs on the descriptor's effective model, or the runner's deployment default when the descriptor records none — regardless of any cell's model selection

#### Scenario: A model change drains and respawns

- **WHEN** the descriptor's effective model changes
- **THEN** in-flight turns drain (new turns during drain get the explicit drain error, not a hang), the runtime respawns on the new model, and the change is live within the five-minute window

#### Scenario: A second harness hosts with identical observable behavior

- **WHEN** a descriptor declares a harness other than dsh that its runner supports
- **THEN** the role serves A2A turns through that harness with the same descriptor-driven composition, the same metering/billing semantics, and the same drain-and-respawn upgrade discipline

### Requirement: A2A adapter surface

Each hosted Agent Service SHALL serve its AgentCard at `/.well-known/agent-card.json` and accept JSON-RPC `message/send` (synchronous) and `message/stream` (SSE streaming) at its route. Responses SHALL carry text parts only in v1; file or chart outputs SHALL NOT be emitted as A2A artifacts. The served card SHALL match the card registered for the agent in the registry. Unsupported A2A methods SHALL return the protocol's method-not-found error, not crash the child.

#### Scenario: Card is discoverable

- **WHEN** a caller fetches the well-known card path of a hosted agent
- **THEN** the response is a valid AgentCard matching the registry-registered card

#### Scenario: Send returns a completed message

- **WHEN** a caller invokes `message/send` with a text part
- **THEN** the response contains the agent's reply as text parts once the turn completes

#### Scenario: Stream delivers deltas

- **WHEN** a caller invokes `message/stream` with a text part
- **THEN** SSE events deliver the reply incrementally and terminate when the turn completes

#### Scenario: Unsupported method

- **WHEN** a caller invokes an A2A method the adapter does not implement
- **THEN** a JSON-RPC method-not-found error is returned and the child keeps serving

### Requirement: Context maps one-to-one to a runtime session

Each A2A `contextId` SHALL map to exactly one runtime session on the role's child, so a conversation continues across messages within the same context. When a child is reaped or drained, its sessions end; a caller continuing afterwards SHALL get a fresh session (or an error during drain), never a session that silently mixes histories.

#### Scenario: Continuity within a context

- **WHEN** a caller sends two messages with the same `contextId`
- **THEN** the second turn sees the first turn's history

#### Scenario: Fresh context after reap

- **WHEN** a child is idle-reaped and the caller sends a message with a new `contextId`
- **THEN** the runner cold-starts a child and the conversation starts fresh

### Requirement: Child lifecycle is bounded and queued

The runner SHALL keep a deployed role's child resident by default — idle reaping is no longer a standalone timer and applies only as warm-zone demotion under the host memory budget (openspec: agent-residency). The runner SHALL enforce a configurable maximum of concurrent children; a message arriving while at capacity SHALL queue until a slot frees, not fail and not evict a busy child. In pod mode the concurrency unit is the pod: the maximum counts pods, and capacity demotion/eviction acts on pods (demoting a pod warm-zones every member). Self-turns fired by the rhythm scheduler SHALL enter the same bounded queue as messages — one queueing discipline for every turn source. The runner SHALL expose a health endpoint reporting hosted agents and child states (resident, warm, starting, paused, serving), which the registry's health checks use; a pod member's state SHALL be derived from its pod's process state plus the member's own turn activity.

#### Scenario: Idle reap and cold start

- **WHEN** a child has been idle past the former reap interval and the host memory budget is not under pressure
- **THEN** the child stays resident and the next message is served with no cold start; the reap-and-cold-start path exists only for warm-zone re-warm after a budget demotion

#### Scenario: Capacity queues instead of failing

- **WHEN** all child slots are busy and a message arrives for a role with no child
- **THEN** the message is queued and served when a slot frees, without evicting a busy child

#### Scenario: Health reflects reality

- **WHEN** the registry health-checks a deployed agent whose child is cold-starting, warm, or paused
- **THEN** the health endpoint reports each state distinctly from serving

#### Scenario: Self-turns ride the same queue

- **WHEN** a rhythm due fires while all child slots are busy
- **THEN** the self-turn queues behind messages under the same discipline and never preempts a serving turn

### Requirement: Same-pack serving agents may co-host in one pod runtime

Under pod mode (opt-in runner configuration, default off — solo behavior byte-identical), the runner MAY host the serving agents of one pack deployment together in a single shared dsh process (a pod): one private runtime home materialized from the pack's member descriptors, one process, N member agents. Co-hosting SHALL be gated by eligibility: every member shares the deployment's billing key (or none declares one), same-named deployment secrets reference the same value, and the runtime's platform bridge reports the live methods pod serving requires (`preset/set`, `model/set`, `session/cancel`); a pack that fails any gate SHALL fall back to solo children per member — eligibility never refuses a deployment. Agents of different packs (or owners) SHALL NEVER co-host. Each member's persona preset, model, tool face, and turn budget SHALL be per-member and SHALL NOT weaken by co-hosting: sessions are namespaced per member inside the shared home so one member's conversation never lands in another's history, and the member's effective tool allowlist SHALL be its exact per-role face (the process-level guard carries the union; the per-member restrict narrows to the member's own allowlist at session composition). An external-context reap SHALL still find member-prefixed `srv-wx-*` sessions.

#### Scenario: Pod composition from the pack's descriptors

- **WHEN** the runner cold-starts a pod for a pack whose two serving agents declare different personas and models
- **THEN** one process hosts both members; each member's sessions compose with that member's persona preset and run on that member's effective model

#### Scenario: An ineligible pack falls back to solo

- **WHEN** a pack's serving agents carry two distinct billing key references, or the spawned runtime lacks a required live method
- **THEN** each member serves from its own dedicated child exactly as in solo mode, and the deployment never fails for pod ineligibility

#### Scenario: Cross-pack isolation is absolute

- **WHEN** the runner groups entries into pods
- **THEN** co-hosted members always share one pack deployment; no process, home, credential file, or MCP sidecar is ever shared across packs or owners

#### Scenario: Sessions never cross members

- **WHEN** two members of a pod each receive a message on their own context
- **THEN** each turn's history contains only that member's conversation, and the shared home's session storage keeps their (namespaced) sessions distinct

#### Scenario: Any member's descriptor change drains the pod

- **WHEN** one member's descriptor changes (upgrade, model, tools, secrets, notify binding)
- **THEN** in-flight turns across the pod drain, the pod is rebuilt with the new composition, and member sessions resume from disk state after the rebuild

#### Scenario: Pod turns obey the pod in-flight discipline

- **WHEN** a pod's configured in-flight turn limit is reached and another turn arrives for any member
- **THEN** the turn queues under the existing bounded-queue discipline and is served when a lane frees — it never fails for concurrency and never preempts an in-flight turn

### Requirement: Inbound traffic is gateway-authenticated and bypass-proof

The runner SHALL accept A2A traffic only through the registry's reverse proxy: caller authentication and per-agent authorization (`invoke_agent`) are the gateway's `/validate` (the caller's gateway credential rides `X-Authorization`, which the gateway strips at egress), and the deployment's out-of-band A2A credential rides the standard `Authorization` header end-to-end (upstream 1.30.0's egress trust model — the gateway is not a credential broker). The runner SHALL require that credential on every request (card included), so calls lacking it — gateway-proxied or direct — are rejected; the runner SHALL NOT maintain its own caller accounts. Each agent SHALL be served at its own origin (the registry proxy maps `/agent/{path}/**` onto the registered URL's origin — upstream #1734), on a port derived deterministically from the registry path.

#### Scenario: Call without the agent credential is rejected

- **WHEN** a request reaches the agent's origin without the deployment credential in `Authorization` — whether direct or proxied through the gateway
- **THEN** the runner rejects it

#### Scenario: Proxied call with both credentials passes through

- **WHEN** a caller authorized by the gateway (`X-Authorization` validated at `/validate`) presents the deployment credential in `Authorization`
- **THEN** the runner serves the request, with no caller account existing on the runner

### Requirement: Delegation depth and concurrency are bounded

The runner SHALL refuse, with an explicit JSON-RPC error naming the bound, any A2A request whose `X-Delegation-Depth` is 3 or greater — a delegation chain is cut at three hops, which breaks every cross-request cycle without global tracking. The runner SHALL additionally bound concurrent delegation-originated turns (depth ≥ 1) per hosted agent to a configurable cap (default 2): over-cap requests queue under the existing bounded-queue discipline, never fail, and never preempt a serving turn.

#### Scenario: Deep chains are refused explicitly

- **WHEN** an A2A request arrives with X-Delegation-Depth: 3
- **THEN** the caller receives an explicit error naming the delegation depth bound, no turn runs, and no child is spawned

#### Scenario: Depth-two chains pass

- **WHEN** an A2A request arrives with X-Delegation-Depth: 2
- **THEN** the request is served normally

#### Scenario: Over-cap delegations queue instead of failing

- **WHEN** delegation-originated turns already fill an agent's concurrency cap and another arrives
- **THEN** the new request queues under the existing queueing discipline and is served when a slot frees

### Requirement: Facade-originated external contexts are idle-reaped

The runner SHALL reclaim runtime sessions under external contexts — the context namespace the facade derives for external callers — after a configurable idle period (default 24 hours), freeing session storage. Rhythm day-sessions and registry-path (internal) contexts SHALL NOT be subject to this reap. A message arriving on a reaped external context SHALL continue as a fresh conversation on that context — never an error, never a silently mixed history. Durable state across external requests belongs in the agent's own files, not session history.

#### Scenario: An idle external context is reaped silently

- **WHEN** an external context has been idle past the configured window and a message later arrives on it
- **THEN** the turn runs on a fresh session for that context, without error

#### Scenario: Internal and rhythm sessions are untouched

- **WHEN** the reap pass runs
- **THEN** rhythm day-sessions and internal (registry-path) contexts remain resident and unaffected

### Requirement: Turn budgets are enforced with a hard stop

The runner SHALL run every turn of a deployed role — messages, rhythm self-turns, and rollover digests alike — under that role's effective turn budget: the deployment descriptor's budget when present, else the runner's configurable deployment default. When a turn exceeds its budget, the runner SHALL stop the turn and the caller receives a structured error naming the budget bound, and the meter records the turn as a budget kill. In solo mode the stop is the child process: stopped and re-spawns on the role's next touch (the private home's file state and durable agent state survive). In pod mode the stop is cancel-first: the member's session is aborted through the platform bridge's native `session/cancel`; only when the cancel does not converge within a bounded window SHALL the whole pod be hard-stopped as the last resort. A role whose descriptor carries no budget SHALL behave exactly as before this change under the deployment default.

#### Scenario: An over-budget turn is hard-stopped with a named bound

- **WHEN** a role with an effective budget of N minutes runs a turn that exceeds it
- **THEN** the turn fails with a structured error naming the N-minute bound, the child process is stopped, and the next message on that role cold-starts a fresh child

#### Scenario: Durable state survives the stop

- **WHEN** a budget kill stops a child mid-turn
- **THEN** the role's private home, session storage, and any files the agent wrote remain on disk, and the next conversation continues from them

#### Scenario: Every turn source shares the budget

- **WHEN** a rhythm self-turn or rollover digest exceeds the role's effective budget
- **THEN** it is stopped under the same discipline as a message turn, and the meter records the kill

#### Scenario: No budget means the deployment default

- **WHEN** a deployed role's descriptor carries no budget field
- **THEN** its turns run under the runner's configurable deployment default, unchanged in behavior from before this change

#### Scenario: A pod member's over-budget turn cancels the member, not the pod

- **WHEN** a pod-hosted member's turn exceeds its effective budget
- **THEN** the member's session is cancelled through the bridge, the turn settles with the structured budget error, the meter records the budget kill, and the pod keeps serving the member's and its siblings' next turns

### Requirement: The runner fetches agent secrets over an authenticated channel and pins them into the child

The platform SHALL serve each deployment secret's value to the runner through a gateway route authenticated by the runner's service credential, keyed by the descriptor's secret reference; every fetch SHALL be audit-logged with the reference and agent, never the value. At child composition the runner SHALL pin every declared secret into that agent's private credentials file — the only channel that reaches the child, whose environment is scrubbed — under the secret's declared name. A declared secret whose value cannot be fetched SHALL fail that agent's composition loudly with the missing reference named; the runner SHALL NOT compose the child with a silently partial secret set, and SHALL NOT substitute any fallback value.

#### Scenario: The child receives its declared secrets

- **WHEN** a deployed agent whose descriptor declares two secret references composes
- **THEN** both values land in the child's private credentials file under their declared names, fetched by reference over the service-credential route

#### Scenario: A missing secret fails composition loudly

- **WHEN** a descriptor declares a secret reference the fetch cannot resolve
- **THEN** that agent's child fails to compose with the missing reference named, no partial secret set is installed, and no fallback value is substituted

#### Scenario: Every fetch is audited without the value

- **WHEN** the runner fetches a secret by reference
- **THEN** an audit record names the reference and the agent, and contains no secret material

### Requirement: Deployed children can notify bound channels through the bridge

The platform bridge row each deployed child composes SHALL expose a notification capability: the child may call `bot_notify(event, text[, channel])`, and the runner SHALL execute it with host authority — the platform relay token stays in runner configuration and SHALL never reach the child, whose environment is scrubbed. The deployment MAY bind one named notification channel per serving agent, set by the deployer at deploy time and recorded in the descriptor; a notify call on an unbound deployment SHALL be declined with a structured error naming the missing binding, never silently dropped. The runner SHALL forward accepted calls to the platform's bot relay route addressed to the bound channel (an explicit channel argument, when provided, SHALL name the same deployment-bound channel or be declined), enforce a per-agent notification rate bound, and return the relay's outcome or failure shape to the calling turn.

#### Scenario: A bound deployment delivers a notification

- **WHEN** a child whose deployment binds channel `ops-feishu` calls `bot_notify("ticket_done", "…")`
- **THEN** the runner posts the text to the platform relay addressed to `ops-feishu` with host-held credentials, and the turn receives the relay's success

#### Scenario: An unbound deployment is declined structurally

- **WHEN** a child whose deployment binds no channel calls `bot_notify`
- **THEN** the call is declined with a structured error naming the missing channel binding, and nothing is sent

#### Scenario: The relay token never reaches the child

- **WHEN** a deployed child's composition and environment are inspected
- **THEN** no relay credential is present — the token lives only in runner configuration

#### Scenario: Over-rate notifications are throttled per agent

- **WHEN** a child exceeds its per-agent notification rate bound
- **THEN** excess calls are declined with a rate error before any relay request, and the bound is per agent, not per runner

#### Scenario: Relay failures surface to the turn

- **WHEN** the platform relay refuses or fails a forwarded notification
- **THEN** the calling turn receives the relay's failure shape, and the runner keeps serving

### Requirement: Declared data workspaces are writable under the session sandbox

A deployed role whose descriptor declares an enabled data workspace SHALL run its sessions with a sandbox writable root that covers that data directory: file writes into it succeed under the default `workspace-write` posture without escalation, and the sandbox posture everywhere else is unchanged. Roles without a data-workspace declaration SHALL keep sandbox behavior identical to deployments predating the feature.

#### Scenario: Write inside the data workspace succeeds

- **WHEN** a session on a workspace-declared deployed role writes a file under its data directory
- **THEN** the write succeeds without approval or escalation, and a subsequent read of the same path returns the written content

#### Scenario: Writes outside the writable root remain denied

- **WHEN** the same session attempts a write outside its writable root (for example into the application tree)
- **THEN** the write is refused fail-closed exactly as before this change

#### Scenario: No declaration changes nothing

- **WHEN** a deployed role without a data-workspace declaration runs a turn
- **THEN** its sandbox writable root and launch parameters are indistinguishable from a deployment predating data workspaces

#### Scenario: Quota guardrail posture is unchanged

- **WHEN** a declared data workspace grows past its declared quota
- **THEN** the runner reports the breach (meter line + fleet event) and still neither deletes workspace data nor blocks turns

### Requirement: Turn events carry session and token attribution

回合生命周期事件（turn_started/turn_ended）SHALL 在 payload 中携带该回合的 `session`（运行时会话名——mission 派发回合即 `srv-mission-<id>`，外部上下文即其 `wx:` 名），使下游观测面能把回合归属到发起源；turn_ended SHALL 在 usage 可得时携带 `tokens`（输入/输出合计或原样 usage 摘要）。`tokens` 的合计 SHALL 兼容两种 usage 命名：OpenAI 风格总数（`total_tokens`/`totalTokens`/`tokens`）优先，dsh harness 风格分列（`inputTokens`/`input_tokens` + `outputTokens`/`output_tokens`，cache 不计入）求和回退；两形状都不匹配时字段缺席而非置空（不猜）。未知字段的既有消费方 SHALL 不受影响（纯增量载荷）；不可得时字段缺席而非置空。

#### Scenario: A mission dispatch turn attributes to its session

- **WHEN** 一个以 `mission:<id>` 上下文派发的回合在 runner 侧开始与结束
- **THEN** 对应 turn_started/turn_ended 事件的 payload.session 以该 mission 的会话名开头，turn_ended 带 tokens

#### Scenario: Existing consumers are untouched

- **WHEN** 升级后的 runner 服务既有 agent（spider-heal 等）
- **THEN** 其回合照常计量与上报，仅 payload 多出可选字段，无行为变化

#### Scenario: dsh harness 分列 usage 求和成 tokens

- **WHEN** 一回合的 assistant/message 事件携带 dsh harness 形状 usage（如 `data.usage = {inputTokens: 120, outputTokens: 30}`）
- **THEN** 该回合计量行与 turn_ended 事件的 tokens = 150（input+output 求和，cache 不计入）；OpenAI 风格总数命名仍按原样取用

### Requirement: A runner hosts only the entries assigned to it

The runner SHALL host only registry entries assigned to it: an entry whose descriptor carries `runner_id` belongs to the runner with that id, and an entry without one belongs to the default runner. The default assignment SHALL come from configuration that defaults to the runner's own fleet id, so a legacy runner with no new configuration keeps hosting every unassigned entry and a new runner with a distinct fleet id hosts only entries explicitly assigned to it. The runner SHALL report the harnesses it can host in its heartbeat (openspec: harness-adapter), so placement can honor a descriptor's declared harness.

#### Scenario: A legacy runner keeps the unassigned fleet

- **WHEN** the registry holds entries without `runner_id` and a runner whose default id equals its own fleet id polls
- **THEN** it hosts those entries exactly as before the sharding change

#### Scenario: A sharded runner hosts only its own entries

- **WHEN** the registry holds entries tagged `runner_id=runner-b` alongside unassigned entries and runner-b polls
- **THEN** runner-b hosts only the runner-b entries and never duplicates the unassigned or other runners' agents

#### Scenario: The heartbeat names the hostable harnesses

- **WHEN** a runner heartbeats its runner_stats row
- **THEN** the row carries the harness set this runner's adapters can host (absent = unknown, degrading the deploy gate open)

### Requirement: A runner drives agents through a harness adapter

The runner's child management SHALL obtain its runtime driver from a harness adapter selected per deployment: the descriptor's declared harness when present and supported, else the runner's default harness. The adapter SHALL own the harness process lifecycle (spawn/initialize/stop) and the turn protocol; the manager SHALL keep owning composition (home materialization, billing key/secrets pinning), scheduling (capacity, warm zone, budgets), and metering — none of which may depend on which harness runs underneath. A descriptor declaring an unsupported harness SHALL fail that role's cold start with a structured error naming the harness (the deployment gate normally refuses earlier; the runner never assumes it did).

#### Scenario: The manager is harness-agnostic

- **WHEN** the same manager configuration hosts a dsh role and an ACP-harness role side by side
- **THEN** both roles get composition, queueing, warm-zone demotion, budget enforcement, and metering from the same manager paths, with the harness choice visible only in the adapter

#### Scenario: An unsupported harness fails the cold start structurally

- **WHEN** a role's descriptor declares a harness this runner cannot host and the deploy gate did not catch it (legacy entry)
- **THEN** the cold start fails with a structured error naming the harness, and the failure is retried per the existing cold-start escalation

### Requirement: The runner honors a valid port override from the descriptor

The runner SHALL derive each hosted agent's listen port with the same shared definition the deploy side uses: a descriptor `port_override` that is an integer inside the runner's own span wins; anything absent, non-integer, or out of range falls back to the path hash. Health reporting SHALL show the same resolved port the listener binds.

#### Scenario: A valid override binds the stamped port

- **WHEN** an entry's descriptor carries `port_override` within the runner's span
- **THEN** the listener binds that port and health reports it

#### Scenario: Junk overrides fall back to the hash

- **WHEN** the override is non-numeric or outside the span
- **THEN** the listener binds the hash port exactly as before

### Requirement: A dead runner's agents are re-pointed to healthy runners

A control loop SHALL watch runner heartbeats and, when a runner's heartbeat is stale past the configured threshold, re-point its registry entries (url + runner assignment, port-collision-aware on the target slice) to the healthy runner with the most budget headroom. Entries of the fleet's default runner include its untagged entries. A re-pointed entry SHALL NOT move back when the old runner returns (hysteresis — the returned runner only receives new placements). When no healthy runner exists or no target has a free port slot, the loop SHALL take no action and log why.

#### Scenario: A stale runner's agent fails over

- **WHEN** a runner's heartbeat goes stale past the threshold and a healthy runner with headroom exists
- **THEN** the stale runner's entries carry the healthy runner's URL and assignment within the next loop pass, and the target hosts them on its next poll

#### Scenario: No healthy target means no action

- **WHEN** every runner is stale, or every healthy runner's port span is full
- **THEN** no entry is modified and the reason is logged

#### Scenario: A returned runner does not reclaim

- **WHEN** a failed-over runner's heartbeat resumes
- **THEN** previously moved entries stay where they are; only future placements may land on it

### Requirement: Materialized runtime homes stay owned by the serving identity

Every (re)materialization of a deployed role's private runtime home — pack update, upgrade respawn, or first touch — SHALL leave the home tree wholly owned by the identity the child runtime runs as, so the child can read its skills, presets, and credentials without permission errors. The runner's default deployment shape (the repository's compose) SHALL run the runner and its children as the image's non-root user, matching the serving identity by construction. When a materialization encounters a home whose existing tree is owned by a different identity: a privileged (root) runner SHALL recursively repair ownership to the configured serving identity and log the repair; an unprivileged runner SHALL fail composition with an explicit error naming the offending path and the remediation, never silently producing a mixed-ownership tree that bricks the child later.

#### Scenario: Pack update preserves child-readable ownership

- **WHEN** a pack update re-materializes a deployed role's home (skills, presets, settings, credentials all rewritten)
- **THEN** every rewritten path is owned by the serving identity and the child's next turn reads its skill files without permission errors

#### Scenario: A foreign-owned home is repaired when privileged

- **WHEN** the runner runs as root and materializes a home whose existing root is owned by another identity (a leftover from a differently-privileged generation)
- **THEN** ownership is recursively repaired to the configured serving identity before the child spawns, and the repair is logged

#### Scenario: A foreign-owned home blocks composition loudly when unprivileged

- **WHEN** an unprivileged runner materializes a home it does not own and cannot repair
- **THEN** composition fails with an explicit error naming the offending path and the remediation, and no half-materialized child serves

### Requirement: A failed cold start leaves no orphan and escalates to a respawn

A child spawn that fails — including an initialize handshake that exhausts its retries — SHALL terminate the already-spawned runtime process before the failure surfaces: no orphaned runtime may outlive the failed spawn or count against the host memory budget. The runner SHALL leave no half-built child entry (a later message re-spawns, never reuses the corpse). A failed cold start SHALL self-heal beyond the in-process retry: the runner retries the whole spawn with a fresh runtime process and backoff, up to a bounded number of respawn attempts; when the bound is exhausted the role surfaces a structured cold-start error distinct from transient turn errors, and the next message still attempts a fresh spawn — recovery never requires a container restart.

#### Scenario: No orphaned runtime after a failed initialize

- **WHEN** a child's initialize exhausts its retries and the spawn fails
- **THEN** the spawned runtime process is terminated, no orphaned process remains, and the host memory budget stops counting it

#### Scenario: A transient registration race self-heals without restart

- **WHEN** a child's initialize loses the adapter-registration race beyond the in-process retry window
- **THEN** the runner respawns the child fresh with backoff and the role serves its next message without a container restart

#### Scenario: Permanent cold-start failure is distinguishable and non-wedging

- **WHEN** respawn attempts are exhausted (e.g. the provider store is missing on this runner)
- **THEN** the role surfaces a structured cold-start error naming the failure, and the next message still attempts a fresh spawn — the runner never wedges until restart

### Requirement: The serving lane runs on a dedicated deployment with its own memory envelope

Serving 回合执行面（托管市场部署 agent 的 runner）必须是独立管理的部署单元：自己的内存包络（不与 registry 宿主机的其他负载、也不与用户会话平面同 cgroup）、声明式生命周期（GitOps 管理、镜像可滚）、且与任务车道 runner 不同故障域。常驻预算与包络对齐（预算 ≤ 容器上限减 runner 基座），并发上限按 M2 实测的单 child 足迹（≈540-600MB 含 sidecar）推算，不以 500-agent 注册闸门为约束。

#### Scenario: 独立部署承载存量条目
- **WHEN** serving runner 从裸容器形态迁入独立 Deployment（专用节点、hostNetwork、hostPath 数据根）且旧容器停止
- **THEN** 既有 fleet-scheduler 接管机制在旧 runner 心跳过期后自动把其条目（打标与未打标默认）改点到新 runner，新 runner 在下一个 poll 周期内冷重建并恢复 A2A 服务；改点目标由面板预算余量排序决定，新 runner（最大余量）承接全部条目。

#### Scenario: 切换期不发生双宿主
- **WHEN** 新旧 runner 并存（切换窗口内，registry 条目 URL 仍指旧 runner）
- **THEN** 新 runner 以「默认 runner 指向旧 runner」的配置惰性启动——它只物化显式打给自己标签的条目（初始为零），不为未打标条目 spawn child；旧 runner 死亡、条目被改点打上新标签后，新 runner 才开始托管。

#### Scenario: 切换后 fleet 默认行指向新 runner
- **WHEN** 接管波完成（无条目再挂在旧 runner 的行/标签下）
- **THEN** fleet 表删除旧 runner 行，新 runner 行成为默认行（列表首行）；新 runner 的「默认 runner」配置恢复为自身（收留未打标条目）；部署面的 legacy 种子 URL（全新 DB 的种子与面板盲退化路径的选址目标）更新为新 runner 地址。

#### Scenario: 内存包络与预算一致
- **WHEN** 独立 Deployment 的容器内存上限为 4Gi（requests=limits，QoS Guaranteed）
- **THEN** runner 常驻预算声明 ≤ 上限减基座（3328MB），并发 child 上限（8）高于预算可容纳数（≈5-6），预算是真实约束；面板展示的 budget_mb_limit 与之一致。

### Requirement: A turn that produces no assistant output settles as a failed turn

采集器 SHALL 把「会话转 idle 且本回合未收集到任何 assistant 文本」的回合按**失败回合**结算：child.turn 以结构化错误拒绝（错误码 -32005，消息言明回合无任何输出），而非以空文本成功返回。该语义 SHALL 对全部回合来源一致生效（A2A message、rhythm self-turn、rollover digest）。由此，计量行 SHALL 记 `ok:false`、turn_ended 事件 SHALL 带 `outcome:"error"`、A2A 面 SHALL 返回 JSON-RPC error（send）/`event: error`（stream）——下游计费按既有 outcome 语义自动免单。产生过文本的回合（含其后再次转入 idle）SHALL 维持既有成功结算，行为不变。

判定 SHALL 以「assistant 文本」为准（trim 后为空即零输出）；usage 缺席 SHALL NOT 作为判定输入（本 dsh 版本 usage 恒缺席——生产 700/700 ok:true 行 tokens:null 实证）。

#### Scenario: 零输出 idle 回合按失败结算并免单

- **WHEN** 一回合内 dsh 未产生任何 assistant 文本便会话转入 idle（如模型解析失败的静默空返）
- **THEN** child.turn 以 code -32005 拒绝；计量行记 ok:false；turn_ended outcome=error；A2A message/send 返回 JSON-RPC error（HTTP 200）；facade 判 outcome:error → waived 零计费

#### Scenario: 正常回合行为不变

- **WHEN** 一回合产生 assistant 文本后转入 idle
- **THEN** 成功结算、计量 ok:true、A2A 返回既有 result 形状——与升级前不可区分

#### Scenario: 自报失败的 LLM 回合维持既有错误码

- **WHEN** 一回合以 finish chunk reason.kind=error 结束（上游 5xx/429 已自报）
- **THEN** 维持既有 -32003 结算路径（与零输出 -32005 区分归因），计量/免单语义同上

#### Scenario: 全部回合来源同纪律

- **WHEN** rhythm self-turn 或 rollover digest 零输出转入 idle
- **THEN** 同按 -32005 失败结算；scheduler 既有错误处理吞下（不楔死节奏循环）
