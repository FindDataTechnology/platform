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

### Requirement: A billing-rejected key parks the agent's turns

When a deployed role's turn fails with an LLM-reported failure, the runner SHALL classify the failure by probing the role's pinned LLM key against the provider's zero-spend model-list endpoint — the same billing gate the turn passed through, exercised without any upstream spend. When the probe reports the key rejected by the billing gate (insufficient balance, or an invalid key), the runner SHALL park the role: rhythm self-turns and day-rollover digests are skipped while parked, and an inbound message turn fails fast with a structured parked error (code `-32012`) whose message names the rejection reason and the time the role was parked, without issuing an LLM request. Parking is automatic and distinct from deployer pause: it SHALL NOT mark the registry entry paused, and it SHALL NOT survive a key re-pin — a descriptor change that re-materializes the role clears the park. While parked, the runner SHALL re-probe on a configurable slow cadence and SHALL resume the role automatically when the probe passes, emitting a fleet event on park and on resume that carries the reason. A probe that passes, that fails for transport reasons, or that targets a provider type the runner cannot probe SHALL NOT park — such turns keep the behavior they had before this change. The runner's health report SHALL annotate a parked role with the reason and park time without changing the lifecycle states it already reports.

#### Scenario: An exhausted key parks the role after one failed turn

- **WHEN** a role's pinned key is rejected by the billing gate with insufficient balance and a rhythm self-turn or rollover digest fails with the LLM-failure code
- **THEN** the runner probes the key, parks the role with reason insufficient-balance, emits the park event, and issues no further LLM request for that role's self-turns or digests until it resumes — the minute-cadence rollover check does not retry the digest

#### Scenario: An inbound message to a parked role fails fast

- **WHEN** an A2A message or stream request arrives for a parked role
- **THEN** the caller receives code `-32012` with a message naming the rejection reason and park time, no LLM request is made, and no child is cold-started for that turn

#### Scenario: An invalid key parks with its own reason

- **WHEN** the probe reports the pinned key invalid rather than under-funded
- **THEN** the role is parked with reason key-invalid, distinct from insufficient-balance, so the deployer can tell re-keying from recharging

#### Scenario: Recharging resumes the role without operator action

- **WHEN** a parked role's key passes the probe on a later slow-cadence re-probe
- **THEN** the role is un-parked, the resume event is emitted with the original reason, and the role's next self-turn, digest, and message run normally

#### Scenario: An upstream flake does not park

- **WHEN** a turn fails with the LLM-failure code but the probe passes
- **THEN** the role is not parked, the failed turn is metered as before this change, and the role's next scheduled turn runs

#### Scenario: A key re-pin clears the park

- **WHEN** a parked role's descriptor changes its billing key reference and the role re-materializes
- **THEN** the park is cleared and the first turn on the new key proceeds — and parks again only if that key is also rejected

#### Scenario: Deployer pause and automatic park are independent

- **WHEN** a parked role is paused by its deployer and later resumed
- **THEN** callers receive the paused error while paused, and after resume the park still gates turns until a probe passes

#### Scenario: A runner restart bounds the regression to one turn

- **WHEN** the runner restarts while a role's key is still rejected
- **THEN** at most one failed turn for that role is issued before it is parked again

#### Scenario: An unprobeable provider keeps today's behavior

- **WHEN** a role runs on a provider type the runner cannot probe
- **THEN** its LLM-failure turns are handled exactly as before this change and the role is never parked

#### Scenario: Health reports the park alongside the lifecycle state

- **WHEN** the health endpoint reports a parked role
- **THEN** the role's entry carries the park reason and park time in addition to its existing lifecycle state

### Requirement: In-flight asks ride the serving stream

A served agent's `ask_user_question` tool SHALL have an answerer: the runtime home of every served child SHALL carry the user-questions provider, composed after every other overlay, so the tool resolves through the serving lane instead of failing for want of a provider. An ask raised during a turn SHALL be forwarded only to a `message/stream` caller that opted in by sending the `X-Serving-Ask: 1` request header; it SHALL ride the same stream as the turn's deltas as an `ask` event carrying the ask id, the session id, the question batch exactly as the runtime's inquiry seam shaped it (question id, question, optional header/detail/options with label and optional description, optional multi-select), and the deadline by which the ask must be answered. The stream SHALL remain open while the ask is pending and SHALL resume delivering deltas, the final message and termination once the ask resolves.

Each hosted agent SHALL accept `POST /ask-answer` at its own route, behind the same backend credential check as the turn methods, taking `{askId, answers}` or `{askId, cancelled: true}` and returning the runtime's receipt: `{accepted: true}` for the first submission that lands on a pending ask and `{accepted: false}` with a reason for an unknown or already-resolved ask id. The first submission wins; a later one changes nothing.

Callers that did not opt in — a `message/stream` call without the header, every `message/send` call, delegation and bot callers — SHALL NOT wait on the ask: the runner SHALL decline it immediately so the tool resolves with a result stating that the caller cannot answer questions, and the turn completes on its normal path.

An ask SHALL be bounded by the turn budget: its deadline is the turn's budget end less a grace interval, the runner SHALL cancel an unanswered ask when the deadline passes so the agent can finish its turn, and the turn budget's hard stop remains the last resort and is otherwise unchanged. While an ask is pending the stream SHALL carry keepalive comment frames at least every 15 seconds so idle proxies between the runner and the caller do not drop the stream; comment frames SHALL NOT appear when no ask is pending.

#### Scenario: Served child carries the ask provider

- **WHEN** a served child is composed for a deployment (solo or pod)
- **THEN** its runtime home's overlay order ends with the user-questions overlay after the notify overlay
- **AND** an `ask_user_question` call from that child reaches the serving lane instead of failing with a no-provider error

#### Scenario: Opt-in stream receives the ask and stays open

- **WHEN** a `message/stream` call carries `X-Serving-Ask: 1` and the agent calls `ask_user_question` mid-turn
- **THEN** the stream emits an `ask` event with `askId`, `sessionId`, the question batch in the seam's shape, and `deadlineAt`
- **AND** the stream is not terminated and no `message` or `done` event has been sent yet

#### Scenario: First answer resolves the ask and the turn continues

- **WHEN** the caller posts `{askId, answers}` to `/ask-answer` for a pending ask
- **THEN** the response is `{accepted: true}`
- **AND** the tool call resolves with those answers, the agent continues, and the stream later delivers the turn's deltas, final `message` and `done`

#### Scenario: Cancel resolves the ask as closed by the user

- **WHEN** the caller posts `{askId, cancelled: true}` for a pending ask
- **THEN** the response is `{accepted: true}`
- **AND** the tool call fails with a user-closed error and the agent's turn continues to completion

#### Scenario: A late or unknown answer changes nothing

- **WHEN** `/ask-answer` is posted for an ask id that is unknown or already resolved
- **THEN** the response is `{accepted: false}` with a reason
- **AND** the earlier resolution stands

#### Scenario: Non-opt-in callers never wait on an ask

- **WHEN** the agent calls `ask_user_question` during a `message/send` turn, or during a `message/stream` turn whose request lacked `X-Serving-Ask: 1`
- **THEN** the ask is declined immediately, the tool result states the caller cannot answer questions, and the turn completes on its normal path within its usual timing

#### Scenario: The ask deadline precedes the budget hard stop

- **WHEN** an opt-in caller never answers a pending ask
- **THEN** the runner cancels the ask at `deadlineAt` (budget end less grace) and the agent's turn finishes normally
- **AND** the turn budget hard stop is not triggered by the pending ask alone

#### Scenario: Keepalive only while an ask is pending

- **WHEN** an ask is pending on an opt-in stream for longer than 15 seconds
- **THEN** the stream carries SSE comment frames at least every 15 seconds until the ask resolves
- **AND** a stream with no pending ask carries no comment frames

#### Scenario: The answer route is credential-gated

- **WHEN** `/ask-answer` is posted without the deployment's backend credential while the runner has one configured
- **THEN** the request is rejected with the same unauthorized response the turn methods give, and the pending ask is unaffected

### Requirement: 部署 agent 的工作记忆经平台缝代采与挂载

承载部署 agent 的 runner SHALL 在平台缝上接入舰队记忆：回合观测由 manager 以该部署的记忆令牌投递到舰队记忆 capture API——与 usage 事件同缝、不要求 harness 自带 hooks。观测 SHALL 覆盖回合边界与工具调用两层：回合开始（`user-prompt-submit`，携带入站意图摘要）、每次工具调用（`pre-tool-use`，携带 `tool_name` 与参数摘要）、每次工具结果（`post-tool-use`，携带 `tool_name`、结果摘要与错误标记）、回合结束（`stop`，携带结果 / token / 时长）；工具层事件经 harness adapter 的可选事件回调取得（dsh 自 `session.event` 的 `tool/call` / `tool/result`，ACP 自 `session/update` 的 `tool_call` / `tool_call_update`），adapter 不支持该回调时观测退化为仅回合边界而非失败。摘要 MUST 在 runner 侧按部署配置的上限截断、在舰队记忆侧过既有脱敏；capture API 的事件形状不变。

每条观测 MUST 携带产生它的部署的 namespace，批次投递 MUST 按 namespace 分组——同一 runner 托管的多个部署交替产生观测时，任何部署的 namespace 下 MUST 只含该部署自己的事件（跨部署、跨 owner 永不串投）。观测与挂载的 agentId 坐标 SHALL 取部署描述符的 `metadata.agentId`（显示名不是坐标——改名 MUST NOT 更换 namespace 或产生新分区）；描述符缺 `metadata.agentId` 时 MUST 回落显示名。

部署的运行时组合 SHALL 自动携带舰队记忆的 MCP 挂载（dsh 经 profile patch、ACP 经 session 的 MCP 传递面，令牌解析与既有凭据纪律同源）：单 agent 组合携带该成员令牌；**pod 运行时组合**携带以 runner 令牌为整 pod 代铸的 pod 令牌（namespace `d/<packId>`），注入 pod 共享的 MCP patch。persona 记忆纪律文案 MUST 仅在该次组合实际携带记忆挂载时注入——挂载缺席（令牌铸造失败而降级）时组合 MUST 不含纪律文案，避免引导 agent 调用并不存在的工具。pod 成员的回合观测 MUST 按成员各自 agent scope 归因（`d/<packId>/<agentId>`），不落在 pod 共享 namespace。舰队记忆不可达时 MUST 降级开放：回合照常执行与计费，代采暂停且如实记录，恢复后继续——记忆缺失永不阻断服务。

#### Scenario: 同 runner 两部署交替观测各落各自 namespace

- **WHEN** 同一 manager 托管部署 A 与 B，A 产生观测排队后 B 产生观测，随后批次投递
- **THEN** A 的 namespace 批次只含 A 的事件、B 的只含 B 的事件；任一组投递失败只回排该组并计一次缺口，不影响另一组与任何回合

#### Scenario: dsh 部署产生观测与交接

- **WHEN** 一个 dsh 部署跑了数个回合并经 MCP 写出交接
- **THEN** manager 代采的回合观测与该交接都落在该部署的 `d/` namespace，可检索

#### Scenario: dsh 部署一个含工具调用的回合落四形状观测

- **WHEN** 一个 dsh 部署跑一个回合，其中调用了 N 次工具
- **THEN** 该部署 namespace 下按序落 1 条 `user-prompt-submit`（意图摘要）、N 条 `pre-tool-use`（各带 `tool_name` 与参数摘要）、N 条 `post-tool-use`（各带 `tool_name`、结果摘要，失败结果带错误标记）、1 条 `stop`（结果 / token / 时长），每条摘要不超过部署配置的上限

#### Scenario: ACP 部署同样接入

- **WHEN** 一个 ACP harness 部署（如 claude-code）跑回合并调用工具
- **THEN** 其 `tool_call` / `tool_call_update` 经 manager 缝落为同形的 `pre-tool-use` / `post-tool-use` 观测，其 MCP 组合含舰队记忆条目

#### Scenario: pod 组合挂载共享记忆且成员观测各归因

- **WHEN** 一个同 pack 多成员的 pod 冷启动（pod 令牌代铸成功）并跑两个成员的回合
- **THEN** pod 共享 MCP patch 含舰队记忆挂载行（pod 令牌）、各成员 persona 含纪律文案；成员 A 与 B 的观测分别落 `d/<packId>/<agentIdA>` 与 `d/<packId>/<agentIdB>`，共享 namespace 下无成员观测

#### Scenario: agentId 坐标不受改名影响

- **WHEN** 一个部署 agent 的显示名变更后重新部署并跑回合
- **THEN** 其观测与挂载仍使用同一 `metadata.agentId` 坐标，namespace 与既有分区连续

#### Scenario: 挂载缺席的组合不含纪律文案

- **WHEN** dsh / ACP / pod 组合因令牌铸造失败而无挂载行
- **THEN** 该次组合的 persona 不含记忆纪律文案；同一部署在挂载成功的组合中含该文案

#### Scenario: 记忆面停机不阻断回合

- **WHEN** 舰队记忆服务不可达
- **THEN** 部署回合照常执行、计费照常，manager 记录代采缺口并在服务恢复后继续投递

### Requirement: A listener bind failure isolates to its own agent

When a per-agent A2A listener fails to bind its port (address in use or any other listen error), the runner SHALL keep serving every other hosted agent: the failing listener SHALL be released, the failure SHALL be logged as a named warning (agent key, port, and the port_override remediation hint), and the process SHALL NOT crash. The runner MAY retry the bind on later reconcile cycles; repeated warnings for the same agent SHALL be rate-limited so a persistently occupied port cannot flood the log. A skipped listener SHALL leave the agent's reachability honestly degraded (its registered port answers nothing) rather than silently mis-routed.

#### Scenario: A hash collision with an existing listener does not crash the runner

- **WHEN** a newly reconciled agent resolves to a port another agent's listener already holds
- **THEN** the runner logs a named warning for the new agent, continues serving the existing listener and all other agents, and the process stays up

#### Scenario: The skipped agent retries and recovers after the port frees

- **WHEN** the occupied port is later freed (the occupant undeployed or moved) and a reconcile cycle re-runs
- **THEN** the runner binds the skipped agent's listener without a restart

#### Scenario: Persistent bind failure does not flood the log

- **WHEN** the same agent fails to bind on every reconcile cycle
- **THEN** the named warning is rate-limited per agent rather than emitted on every cycle

### Requirement: 对外可见文本不含推理痕迹

面向用户的文本输出（对话信道的文本增量）SHALL NOT 含模型推理痕迹（如 `<thinking>`/`<reasoning>`
等标记及其内容）。运行时 SHALL 在文本输出路径剥离闭合的推理块，未闭合的推理块 SHALL 剥至结尾，
剥离后为空时 SHALL 回兜底文本而非输出空回答。该剥离 SHALL 与出站通道（机器人渠道）共用同一实现。

#### Scenario: 闭合推理块被剥离

- **WHEN** 模型在文本增量中输出一段闭合的推理标记内容
- **THEN** 用户可见文本不含该标记与内容，其余文本原样呈现

#### Scenario: 未闭合推理块剥至结尾

- **WHEN** 模型输出的推理标记未闭合
- **THEN** 标记及其后内容一并被剥离，用户可见文本不以推理内容结尾

#### Scenario: 剥空回兜底

- **WHEN** 一条输出在剥离推理痕迹后为空
- **THEN** 系统输出兜底文本，SHALL NOT 输出空回答

### Requirement: Runner RSS sampling is platform-safe

The child manager's RSS sampler SHALL return null (caller falls back to the
fixed planning cost) on platforms where neither `/proc` nor a working `ps`
exists — concretely `process.platform === "win32"` short-circuits before any
subprocess is invoked. The sampler MUST NOT emit per-poll subprocess errors
on unsupported platforms.

#### Scenario: Windows runner polls without spawning ps

WHEN the manager samples child RSS on a win32 host
THEN no `ps` subprocess is attempted and no per-poll error text is emitted

#### Scenario: Linux sampling unchanged

WHEN the manager samples RSS on linux or darwin
THEN the existing /proc-then-ps behavior is preserved byte-for-byte

### Requirement: Profile scaffold carries a package identity

The dsh profile scaffold shipped in `dsh-profile-template/package.json`
SHALL declare non-empty `name` AND `version`, because the plugin-package
inventory extension (`identityFromManifest`) rejects manifests missing
either when a freshly materialized profile directory is scanned as an
anchor. A scaffold lacking `version` breaks the first LLM turn on any
platform whose profile dir is scanned directly (Windows desktop).

#### Scenario: Fresh desktop materialization completes its first turn

WHEN an agent home is materialized on a machine with no deployment tree and the served agent answers its first turn
THEN the plugin-package inventory extension resolves every active package without an identity error
