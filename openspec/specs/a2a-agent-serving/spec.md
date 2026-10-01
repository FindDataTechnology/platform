# a2a-agent-serving Specification

## Purpose
Defines the serving contract on pack roles and the lifecycle of Agent Services deployed from it: how a deploy action composes registry-native assets (skill entries + agent entry), how deployment propagates, and how upgrade, undeploy, and rollback behave.

## Requirements

### Requirement: Deploy action composes registry-native assets

The platform SHALL offer a deploy action (「部署为服务」) on published pack versions whose agents carry a serving contract, gated to pack creators and admins, and idempotent per (pack version, agent id). The action SHALL: publish each of the pack's skills as a registry skill entry under a pack-scoped path with restricted visibility; register one registry agent entry per serving-contract agent with `supported_protocol: "a2a"`, the runner's backend URL as the proxy backend, and a `metadata` deployment descriptor limited to small fields (persona, MCP references, skill paths, serving contract); and compose the AgentCard from the serving contract's manual card fields, defaulting to values derived from the agent's name/description/tags when absent. The action SHALL NOT embed the full manifest or skill bodies in the agent entry.

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


### Requirement: Deployment propagates by polling within five minutes

The runner SHALL discover deployed Agent Services by polling the registry, and a deployment SHALL become callable within five minutes of the deploy action completing, without any push dependency. The deploy API response SHALL state the expected effective window, and the marketplace UI SHALL show a two-state status (「部署中」→「在线」) per deployed agent, derived from the registry entry's health.

#### Scenario: Deploy-to-callable latency

- **WHEN** the deploy action completes at time T
- **THEN** the Agent Service answers A2A requests at or before T+5min

#### Scenario: Status reflects health

- **WHEN** a deployed agent's registry health check turns unhealthy
- **THEN** the marketplace UI shows the agent as not 在线


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

