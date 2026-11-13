# agent-runner 变更（add-harness-adapter）

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: A runner drives agents through a harness adapter

The runner's child management SHALL obtain its runtime driver from a harness adapter selected per deployment: the descriptor's declared harness when present and supported, else the runner's default harness. The adapter SHALL own the harness process lifecycle (spawn/initialize/stop) and the turn protocol; the manager SHALL keep owning composition (home materialization, billing key/secrets pinning), scheduling (capacity, warm zone, budgets), and metering — none of which may depend on which harness runs underneath. A descriptor declaring an unsupported harness SHALL fail that role's cold start with a structured error naming the harness (the deployment gate normally refuses earlier; the runner never assumes it did).

#### Scenario: The manager is harness-agnostic

- **WHEN** the same manager configuration hosts a dsh role and an ACP-harness role side by side
- **THEN** both roles get composition, queueing, warm-zone demotion, budget enforcement, and metering from the same manager paths, with the harness choice visible only in the adapter

#### Scenario: An unsupported harness fails the cold start structurally

- **WHEN** a role's descriptor declares a harness this runner cannot host and the deploy gate did not catch it (legacy entry)
- **THEN** the cold start fails with a structured error naming the harness, and the failure is retried per the existing cold-start escalation
