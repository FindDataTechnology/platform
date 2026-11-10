# a2a-agent-serving Specification

## Purpose
Defines the serving contract on pack roles and the lifecycle of Agent Services deployed from it: how a deploy action composes registry-native assets (skill entries + agent entry), how deployment propagates, and how upgrade, undeploy, and rollback behave.

## Requirements

### Requirement: Deploy action composes registry-native assets

The platform SHALL offer a deploy action (「部署为服务」) on published pack versions whose agents carry a serving contract, gated to pack creators and admins for public packs and to the pack's owner for private packs (openspec: pack-visibility), idempotent per (pack version, agent id), and admitted only when the deployer's billing balance passes the platform-billing gate. The action SHALL: publish each of the pack's skills as a registry skill entry under a pack-scoped path with restricted visibility; register one registry agent entry per serving-contract agent with `supported_protocol: "a2a"`, the runner's backend URL as the proxy backend, and a `metadata` deployment descriptor limited to small fields (persona, MCP references, skill paths, serving contract, effective work rhythm, effective turn budget, effective model, billing key reference); compose the AgentCard from the serving contract's manual card fields, defaulting to values derived from the agent's name/description/tags when absent; and mint the per-agent billing key per platform-billing. The deployer's rhythm and budget overrides, and any deploy-time model choice, SHALL be recorded as the deployment's initial service config (openspec: agent-service-config) — rewritable afterwards on the serving config surface — not as one-shot request parameters; the descriptor records the resulting effective values. A deploy-time model choice SHALL pass the same write-time lane validation as any later config write. The action SHALL NOT embed the full manifest, skill bodies, or any key secret in the agent entry.

A deploy request MAY carry an `agents` array naming a non-empty subset of the pack's serving-contract agent ids; the deploy then registers, configures, and records ONLY the named agents. An omitted `agents` key deploys every serving-contract agent exactly as before. Unknown, duplicate, or non-serving ids in the array SHALL be refused with a reason naming the id. When a subset is deployed, the billing-key admission rule (every deployed serving agent ends up bound) SHALL apply only to the selected agents: unselected serving agents keep their existing key and secret bindings untouched — not revalidated, not required, not dropped — because their live registry entries are not being replaced. A pasted billing key or an explicit secret-unbind aimed at a serving agent outside the selection SHALL be refused with a reason naming the agent, never silently ignored.

#### Scenario: Deploying a serving-contract role

- **WHEN** a creator triggers deploy on a pack version whose agent carries a serving contract
- **THEN** the registry gains one a2a agent entry and one skill entry per pack skill, and a second trigger for the same (version, agent) changes nothing

#### Scenario: Deploy is refused without the contract

- **WHEN** a creator triggers deploy on a pack whose agents carry no serving contract
- **THEN** the action is refused with a reason naming the missing contract

#### Scenario: Card defaults are derived

- **WHEN** the serving contract omits manual card fields
- **THEN** the registered AgentCard's display fields are derived from the agent's name, description, and tags

#### Scenario: Skills are gated on the registry

- **WHEN** the deploy action publishes pack skills as registry skill entries
- **THEN** those entries are not publicly listed to marketplace browsers outside the intended visibility

#### Scenario: The deployer rhythm override lands in the descriptor

- **WHEN** a deploy request carries a rhythm override differing from the manifest default, or carries none
- **THEN** the descriptor records the override as the effective rhythm in the first case and the manifest default in the second, and the override persists as the deployment's initial service config

#### Scenario: The deployer budget override lands in the descriptor

- **WHEN** a deploy request carries a per-agent budget override, or the contract declares `budget.turnMinutes`, or neither
- **THEN** the descriptor records the override in the first case, the declared ceiling in the second, and no budget field in the third (the runner's deployment default applying instead), and any override persists as the deployment's initial service config

#### Scenario: The descriptor carries a key reference, never the key

- **WHEN** a deploy mints the per-agent billing key
- **THEN** the descriptor records the key's reference only, and no secret value reaches the registry

#### Scenario: A deploy-time model rides the same lane validation

- **WHEN** a deploy request carries a model choice that is not authorized on the deployer key's sub2api lanes, or violates the serving contract's model whitelist
- **THEN** the deploy is refused with the write-time lane validation error, and no agent entry is registered

#### Scenario: An agent subset deploys only the named agents

- **WHEN** a deploy request carries `agents: ["alpha"]` on a pack whose serving agents are alpha and beta
- **THEN** only alpha's registry entry is composed (or upserted) and recorded, beta's live entry and stored bindings are untouched, and the response's `deployed` lists alpha only

#### Scenario: A bad selection is refused naming the id

- **WHEN** a deploy request carries `agents` containing an id that is not a serving agent of the pack, a duplicate, or an empty array
- **THEN** the deploy is refused with a 400 naming the offending entry, and nothing is deployed

#### Scenario: Keys for unselected agents are refused, not ignored

- **WHEN** a subset deploy pastes a billing key for a serving agent outside the selection, or aims a secret null-unbind at one
- **THEN** the deploy is refused with a reason naming the agent and the selection, so an unselected agent's live entry never drifts from its stored bindings

#### Scenario: Billing admission scopes to the selection

- **WHEN** a subset deploy provides billing keys for every selected agent and the billing plane is linked
- **THEN** the deploy is admitted even though an unselected serving agent has no stored key binding, and that unselected agent's absence of a binding changes nothing for this deploy

### Requirement: Deployment propagates by polling within five minutes

The runner SHALL discover deployed Agent Services by polling the registry, and a deployment SHALL become callable within five minutes of the deploy action completing, without any push dependency and without any manual intervention: within the propagation window the platform SHALL keep re-probing the entry's health until it turns healthy, so the registry's routing surface becomes generatable without a manual toggle. The deploy API response SHALL state the expected effective window, and the marketplace UI SHALL show a two-state status (「部署中」→「在线」) per deployed agent, derived from the registry entry's health.

#### Scenario: Deploy-to-callable latency

- **WHEN** the deploy action completes at time T
- **THEN** the Agent Service answers A2A requests at or before T+5min

#### Scenario: Status reflects health

- **WHEN** a deployed agent's registry health check turns unhealthy
- **THEN** the marketplace UI shows the agent as not 在线

#### Scenario: Fresh deployment needs no manual re-toggle

- **WHEN** a newly deployed agent's first health probe fails because the runner has not yet picked the entry up
- **THEN** the platform re-probes automatically within the propagation window, and the entry reaches healthy — and facade calls stop failing with -32033 — with no operator action

### Requirement: Upgrade swaps in place with drain

Redeploying a new pack version for an already-deployed agent SHALL update the same registry agent entry and descriptor in place. The runner SHALL drain the old child: existing conversations continue on the old child until their in-flight turns complete or five minutes elapse, and new messages route to a child composed from the new version. No second registry entry SHALL be created for the upgrade.

#### Scenario: In-flight turn survives an upgrade

- **WHEN** an upgrade lands while a turn is streaming on the old child
- **THEN** the turn completes on the old child and the next message on that context is refused or routed per drain rules, not corrupted

#### Scenario: New messages hit the new version

- **WHEN** an upgrade has completed and a caller sends a message
- **THEN** the message is served by a child composed from the new version

#### Scenario: No entry proliferation

- **WHEN** a pack is redeployed three times at successive versions
- **THEN** the registry holds exactly one agent entry for that (pack, agent)

### Requirement: Undeploy is independent and unpublish does not cascade

Undeploying an Agent Service SHALL be an explicit action that stops the runner's child and delists the registry agent entry (and the pack-scoped skill entries). Unpublishing a pack version SHALL NOT undeploy its deployed Agent Services; the marketplace SHALL surface that the pack has deployed services when unpublish is attempted.

#### Scenario: Undeploy stops serving

- **WHEN** an admin undeploys an Agent Service
- **THEN** its registry entry is delisted and subsequent A2A calls to its route fail, while other deployed agents are unaffected

#### Scenario: Unpublish warns instead of killing

- **WHEN** a creator unpublishes a pack that has a deployed Agent Service
- **THEN** the service keeps running and the UI warns that a deployed service exists

### Requirement: Rollback is redeploy of an old version

Rolling back an Agent Service SHALL be performed by deploying a previously published pack version, which follows the in-place upgrade semantics. No separate rollback mechanism SHALL exist, and immutability of published versions SHALL guarantee the old behavior is reproducible.

#### Scenario: Rollback via old version

- **WHEN** v3 misbehaves and an admin deploys v2 for the same (pack, agent)
- **THEN** the registry entry is updated in place and the service serves v2's composition after drain

### Requirement: Pause and resume are first-class lifecycle actions

The platform SHALL offer pause and resume actions on a deployed Agent Service, deployer-gated, riding the same registry-native propagation as deploy (effective within the polling window). Pausing SHALL mark the registry entry paused and the runner SHALL answer callers with an explicit paused error, demote the child to the warm zone, and stop all injections (openspec: agent-residency). The platform's emergency stop SHALL trigger the same pause through a platform-authority endpoint; resume is one action and identical regardless of who paused. Undeploy semantics are unchanged and remain independent of pause.

#### Scenario: Pausing is deployer-gated and propagates

- **WHEN** a deployer pauses a deployed agent
- **THEN** the registry entry is marked paused within the polling window, and a caller thereafter receives an explicit paused error rather than a timeout

#### Scenario: The emergency stop reuses the pause path

- **WHEN** the platform triggers the emergency stop on an agent
- **THEN** the agent enters the same paused state and the deployer's resume action restores it

#### Scenario: Undeploy is unchanged by pause

- **WHEN** a paused agent is undeployed
- **THEN** undeploy proceeds exactly as for a serving agent — stop child, delist the registry entry

### Requirement: Deploy binds deployer-provided secrets per agent

The deploy action SHALL accept, per serving agent, a map of deployment secrets — arbitrary named values the deployed agent needs at runtime (for example a content-repository token) — minted and delivered by the deployer in the deploy request. Before binding, the platform SHALL validate each secret's name (short lowercase identifier), the per-agent count bound, and each value's size bound; secrets aimed at unknown or non-serving agents SHALL be refused. Bound secrets SHALL be stored under opaque platform-side references, and the deployment descriptor SHALL carry only those references, never the values; the registry entry, marketplace, and every card surface SHALL remain secret-free. Redeployment omitting secrets SHALL keep existing bindings; an explicit null per name SHALL unbind that name; bindings for agents that stop serving SHALL be dropped on redeploy. Logs, audit surfaces, and the deploy surface SHALL show at most a masked reference per secret.

#### Scenario: A deploy binds a deployer-provided secret

- **WHEN** a pack with a serving agent is deployed with a valid secret for that agent — name, count, and size all pass
- **THEN** the secret is stored under a fresh opaque reference, the descriptor carries the reference, and the deploy proceeds

#### Scenario: Secret values never ride public surfaces

- **WHEN** the registry entry, descriptor, marketplace payloads, or AgentCard are inspected
- **THEN** no secret value appears anywhere — only opaque references

#### Scenario: An invalid secret is refused at deploy time

- **WHEN** a pasted secret's name is malformed, the per-agent count is over the bound, a value exceeds the size bound, or it aims at an unknown or non-serving agent
- **THEN** the deploy is refused with a secret-invalid code and the failing reason

#### Scenario: Redeploy keeps, unbinds, and drops per lifecycle

- **WHEN** a pack with bound secrets is redeployed without secrets in the request, with an explicit null for one name, or after an agent stops serving
- **THEN** omitted secrets ride into the new descriptor, the nulled name is unbound, and the stopped agent's bindings are dropped

#### Scenario: Secret bindings are visible, values are not

- **WHEN** the deployer views a pack's deploy surface after deploying
- **THEN** each serving agent shows which secret names are bound, and no secret value is ever displayed or returned

### Requirement: Example prompts ride the AgentCard

The manual card fields SHALL include `examples`: at most three sample prompts (each a non-empty string of at most 200 characters) that discovery surfaces offer as one-click starters. Manifest validation SHALL accept the field only in that shape (absent keeps the card without it; malformed fails naming the entry), and the composed AgentCard SHALL pass declared examples through verbatim.

#### Scenario: Example prompts ride the card verbatim

- **WHEN** a serving contract declares `card.examples` with two sample prompts and the agent deploys
- **THEN** the registered card carries exactly those two strings

#### Scenario: A malformed declaration fails validation

- **WHEN** `card.examples` declares four entries, an empty string, or a 201-character string
- **THEN** manifest validation fails naming the serving entry, and nothing registers

#### Scenario: Absent examples keep the card shape unchanged

- **WHEN** a contract without `card.examples` deploys
- **THEN** the composed card simply lacks the field, byte-identical to the pre-change shape

### Requirement: Deployments are assigned to a fleet runner

The deploy surface SHALL keep a runner fleet registry (id, base URL, per-agent port base and span) seeded at boot from the legacy single-runner environment so the default deployment target and its computed serving URLs are byte-identical to the pre-fleet era. A deploy request SHALL accept an optional runner id, resolve it against the fleet registry, stamp the deployment descriptor with it, and compute the registered serving URL from that runner's base URL and port span. Deployments SHALL remain addressable regardless of assignment: the registry routes to whichever runner's URL the entry carries, and cross-runner agent-to-agent calls need no new path.

#### Scenario: The default deploy is byte-identical to the legacy era

- **WHEN** an operator deploys without naming a runner and the fleet table holds the seeded legacy row
- **THEN** the entry's serving URL and untagged assignment match exactly what the single-runner env produced

#### Scenario: A deploy assigned to a second runner lands on it

- **WHEN** a deploy names runner-b
- **THEN** the registry entry carries runner-b's URL and a `runner_id` tag, and runner-b alone hosts it

#### Scenario: The fleet list is readable over the internal face

- **WHEN** a service-credentialed caller requests the runners list
- **THEN** it receives the fleet rows (id, base URL, port geometry) for placement surfaces

### Requirement: Per-agent ports avoid collisions within a runner's span

A deploy SHALL resolve each serving agent's port against the occupancy of its runner slice: the hash slot when free, else the next free slot in the span, with the resolved value stamped as `port_override` in the descriptor and used verbatim in the registered URL. A redeploy of an entry that already carries a valid override SHALL keep it. A full span SHALL fail the deploy with an explicit span-exhausted error. A deploy whose registry listing fails SHALL fall back to the pure hash behavior rather than failing. A deploy with no collision SHALL add no port field and behave byte-identically to the pre-fleet contract.

#### Scenario: A colliding deploy moves to the next free slot on both ends

- **WHEN** an agent's hash slot is already occupied by another entry on the same runner slice
- **THEN** the descriptor carries a `port_override` for the next free slot and the registered URL serves from exactly that port

#### Scenario: A clean deploy adds nothing

- **WHEN** no same-slice entry occupies the hash slot
- **THEN** the descriptor carries no port field and the URL equals the hash-port form

#### Scenario: A full span fails loudly

- **WHEN** every slot of the runner's span is occupied
- **THEN** the deploy is refused with a span-exhausted error naming the runner

### Requirement: Deploys auto-place on the least-loaded healthy runner

When a deploy names no runner and the fleet table holds more than one runner, the deploy surface SHALL place the agent on the healthy runner with the most budget headroom (fewer children breaking ties), stamping the assignment explicitly. With a single fleet row, or when runner health is unreachable, the deploy SHALL keep the legacy behavior (untagged, default runner) rather than failing.

#### Scenario: An untagged deploy on a multi-runner fleet lands on the emptiest machine

- **WHEN** a deploy omits runnerId and the fleet holds several runners with differing load
- **THEN** the entry is stamped with the least-loaded healthy runner and its URL serves from that runner

#### Scenario: Health blindness degrades to the legacy default

- **WHEN** the health board is unreachable or the fleet holds one row
- **THEN** the deploy proceeds untagged exactly as before

### Requirement: A deploy-time model choice must resolve on the hosting runner's roster

A deploy-time (and config-write) model choice passes TWO existing gates — the serving contract's model whitelist and the deployment key's sub2api lanes. Neither knows what the hosting runner's dsh tree can actually resolve: a lane-authorized model absent from the runner's model roster fails SILENTLY in the child (provider resolution error → empty answer → a billed turn that returned nothing). The deploy action SHALL therefore also validate each requested model choice against the roster of the runner the deploy is placed on, sourced from that runner's fleet heartbeat (the observer board's runner stats). A config-write that pins a model on a LIVE deployment SHALL pass the same roster layer, resolving the hosting runner from the live registry entry's assignment (falling back to the fleet's default row) before the write lands. An explicit null (clearing the pin back to the declaration) is not a model choice and never hits the gate. Both gates SHALL degrade open when the roster cannot be known — the fleet scheduler is not armed, the board is unreachable, or the placed runner's heartbeat does not yet carry a roster (older runner image) — matching the scheduler's health-blindness discipline; they SHALL never block a write on missing observability. A roster is only authoritative when present as a list; an empty list refuses every model choice with the roster error.

#### Scenario: A lane-authorized but roster-absent model is refused at deploy

- **WHEN** a deploy request carries a model choice that passes the whitelist and the key's lanes, but the placed runner's heartbeat reports a roster that does not include it
- **THEN** the deploy is refused with a roster error naming the model and the runner's available models, and no agent entry is registered

#### Scenario: A config write pins the same failure on a live deployment and is refused

- **WHEN** a config write pins a model that passes the whitelist and the key's lanes, but the LIVE deployment's hosting runner (from the registry entry's assignment, or the fleet default row) reports a roster that does not include it
- **THEN** the write is refused with the roster error before any registry PUT lands, and the deployment's pinned model is unchanged; an explicit null clear is never roster-checked

#### Scenario: The gate degrades open when the roster is unknowable

- **WHEN** the fleet scheduler is unarmed, the board fetch fails, or the placed runner's heartbeat carries no roster field
- **THEN** the deploy proceeds without a roster decision, exactly as before this gate existed

#### Scenario: The runner heartbeat carries the authoritative roster

- **WHEN** a runner emits its periodic runner_stats heartbeat
- **THEN** the payload carries the model id list its composed child profiles resolve (the same source the child settings.yaml is written from), and the observer board exposes it on the runner's stats row verbatim

### Requirement: Deploy is capacity-gated by the fleet waterline

A deploy that brings a NEW child onto the fleet (the pack has no in-service deployment) SHALL be refused when the best available target runner's memory headroom (`budget_mb_limit − budget_mb` from the fleet board) is below the configured waterline (`FLEET_CAPACITY_WATERLINE_MB`, default 512). The refusal SHALL be a structured 503 naming the runner, its headroom, and the waterline (`FLEET_AT_CAPACITY`), so the deployer knows what to wait for. Redeploys and upgrades of an already-in-service pack SHALL skip this gate — capacity pressure must never wedge a live service's lifecycle. When the fleet holds multiple runners, targets are considered in the scheduler's placement order and the first target with headroom at or above the waterline wins; all-below-waterline refuses. When the capacity signal is unknowable (scheduler unarmed, board unreachable), the gate SHALL degrade open — an observability gap never blocks a deploy (the same discipline as the model roster gate).

#### Scenario: A new deploy is refused below the waterline

- **WHEN** a deploy would add a new child and the best target runner's headroom is below the waterline
- **THEN** the request is refused with 503 `FLEET_AT_CAPACITY` naming the runner, its headroom, and the waterline, and nothing is written to the registry

#### Scenario: An upgrade skips the gate

- **WHEN** a pack already in service is redeployed (same or new version) while the fleet is below the waterline
- **THEN** the deploy proceeds exactly as before — the gate never wedges a live service

#### Scenario: A target above the waterline admits the deploy

- **WHEN** a new deploy targets a runner whose headroom is at or above the waterline
- **THEN** the deploy proceeds; with multiple runners the first placement candidate above the waterline is chosen

#### Scenario: Unknowable capacity degrades open

- **WHEN** the scheduler is unarmed or the board is unreachable during a new deploy
- **THEN** the deploy proceeds — the gate only refuses on a positive below-waterline reading

### Requirement: The access mode governs the deploy identity gate

The deploy gate SHALL admit the pack author, users in the configured creator group, and — when `PACK_ACCESS_MODE=open` — any authenticated user. In `closed` mode (the default, including unset) refusals SHALL be byte-identical to the pre-change contract. Opening the access mode SHALL change nothing else: private-pack visibility, in-service/foreign-deploy rules, billing-key validation, and the model gates all apply unchanged. The facet surface's `whoami` SHALL carry the effective `accessMode` so the active posture is observable.

#### Scenario: Closed mode keeps the exact refusal

- **WHEN** a user who is neither the author nor in the creator group deploys in `closed` mode
- **THEN** the 403 refusal is byte-identical to the pre-change contract

#### Scenario: Open mode admits any authenticated user

- **WHEN** `PACK_ACCESS_MODE=open` and an authenticated non-creator deploys a public pack
- **THEN** the deploy proceeds under that user's identity, with every downstream gate (billing key, model whitelist/lane/roster, capacity) unchanged

#### Scenario: The effective access mode is observable

- **WHEN** the facet `whoami` route is read
- **THEN** the response carries `accessMode` reflecting the deployment's effective setting



### Requirement: Port-occupancy listing degradation is visible

The deploy's port-occupancy map is built from a best-effort registry listing (the collision-avoidance contract). When that listing fails, the deploy SHALL still proceed with pure hash assignment (a registry hiccup must not refuse a deploy) but SHALL emit a named warning stating that collision detection is degraded — the silent form of this degradation let a hash collision reach the runner as a listener bind failure in production (2026-10-25, ledger §15.33).

#### Scenario: Registry listing failure warns instead of staying silent

- **WHEN** the occupancy listing fetch fails during a deploy
- **THEN** the deploy proceeds with hash-only port assignment and logs a warning naming the degradation and its consequence

#### Scenario: Healthy listing keeps the collision-avoidance contract

- **WHEN** the occupancy listing succeeds
- **THEN** a hash slot taken by another agent ring-probes the next free slot and stamps a port_override, exactly as before

### Requirement: 服务契约可声明会话工具面

服务契约 SHALL 支持可选键 `serving.toolFace`，v1 取值仅 `"chat"`：物化该部署时
SHALL 结构性裁掉内建工具面中的文件系统、命令执行、网络访问与子代理行，同时 SHALL
保留技能调用、访客问询与平台桥注入的工具（通知/问询/事项）。未声明该键的部署
SHALL 与现状逐字节一致。发布门 SHALL 校验取值枚举；未知档位以结构化错误拒绝。

#### Scenario: chat 面裁剪生效

- **WHEN** 一个角色以 `serving.toolFace: "chat"` 部署并物化
- **THEN** 其工具面不包含 bash/文件/网络/子代理工具，且包含技能调用、问询与桥注入工具

#### Scenario: 未声明零变化

- **WHEN** 一个服务契约不携带 `toolFace`
- **THEN** 物化产物与该键引入前逐字节一致

#### Scenario: 未知档位被拒

- **WHEN** 发布清单声明 `serving.toolFace: "yolo"`
- **THEN** 发布门以结构化错误拒绝，不上架

### Requirement: 部署按部署者租户化

部署 SHALL 为部署者的资产：同一包的同一服务角色 SHALL 允许多个部署者各自部署，
部署记账与计费绑定的唯一性 SHALL 为「包+角色+部署者」三元组。非包作者的部署
SHALL 注册到带部署者段的服务地址（段由部署者身份派生且稳定）；包作者的部署与
全部存量条目 SHALL 保持原服务地址逐字节不变。同部署者的重复部署 SHALL 为原地址
原地升级。任一部署者 SHALL NOT 因其他部署者的部署而丢失服务、计费绑定或配置。

#### Scenario: 第二部署者不覆盖第一部署者

- **WHEN** 部署者 B 部署一个已被部署者 A 部署过的包的角色
- **THEN** A 的部署、计费绑定与服务地址保持不变，B 获得独立的服务地址与计费绑定

#### Scenario: 存量条目零变化

- **WHEN** 审查任一本能力前已存在的部署条目
- **THEN** 其服务地址、记账与计费绑定与本能力引入前逐字节一致

#### Scenario: 生命周期动作限部署者

- **WHEN** 非本部署的部署者对该部署执行暂停/配置/解绑等生命周期动作
- **THEN** 与不存在同形拒绝（部署者本人与管理组除外）
