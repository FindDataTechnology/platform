# a2a-agent-serving Delta

## MODIFIED Requirements

### Requirement: Deploy action composes registry-native assets

The platform SHALL offer a deploy action (「部署为服务」) on published pack versions whose agents carry a serving contract, gated to pack creators and admins, and idempotent per (pack version, agent id). The action SHALL: publish each of the pack's skills as a registry skill entry under a pack-scoped path with restricted visibility; register one registry agent entry per serving-contract agent with `supported_protocol: "a2a"`, the runner's backend URL as the proxy backend, and a `metadata` deployment descriptor limited to small fields (persona, MCP references, skill paths, serving contract, effective work rhythm); and compose the AgentCard from the serving contract's manual card fields, defaulting to values derived from the agent's name/description/tags when absent. The effective work rhythm SHALL be the deployer's override when the deploy request carries one, else the manifest's declared rhythm; the descriptor records the effective value (openspec: agent-residency). The action SHALL NOT embed the full manifest or skill bodies in the agent entry.

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
- **THEN** the descriptor records the override as the effective rhythm in the first case and the manifest default in the second

## ADDED Requirements

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
