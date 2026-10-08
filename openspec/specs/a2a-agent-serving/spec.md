# a2a-agent-serving Specification

## Purpose
Defines the serving contract on pack roles and the lifecycle of Agent Services deployed from it: how a deploy action composes registry-native assets (skill entries + agent entry), how deployment propagates, and how upgrade, undeploy, and rollback behave.

## Requirements

### Requirement: Deploy action composes registry-native assets

The platform SHALL offer a deploy action (「部署为服务」) on published pack versions whose agents carry a serving contract, gated to pack creators and admins for public packs and to the pack's owner for private packs (openspec: pack-visibility), idempotent per (pack version, agent id), and admitted only when the deployer's billing balance passes the platform-billing gate. The action SHALL: publish each of the pack's skills as a registry skill entry under a pack-scoped path with restricted visibility; register one registry agent entry per serving-contract agent with `supported_protocol: "a2a"`, the runner's backend URL as the proxy backend, and a `metadata` deployment descriptor limited to small fields (persona, MCP references, skill paths, serving contract, effective work rhythm, effective turn budget, effective model, billing key reference); compose the AgentCard from the serving contract's manual card fields, defaulting to values derived from the agent's name/description/tags when absent; and mint the per-agent billing key per platform-billing. The deployer's rhythm and budget overrides, and any deploy-time model choice, SHALL be recorded as the deployment's initial service config (openspec: agent-service-config) — rewritable afterwards on the serving config surface — not as one-shot request parameters; the descriptor records the resulting effective values. A deploy-time model choice SHALL pass the same write-time lane validation as any later config write. The action SHALL NOT embed the full manifest, skill bodies, or any key secret in the agent entry.

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
