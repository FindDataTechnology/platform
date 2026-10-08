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

A delegated task whose target is `{type: "a2a", ref}` naming a catalog a2a entry SHALL execute as one A2A `message/stream` call to that agent's registry gateway route, sent with the cell caller credential on `X-Authorization`, the deployment's agent credential on `Authorization`, and a delegation depth header (below). The streamed reply text SHALL land in the task's dedicated session exactly like a persona execution's output, and the existing aggregation turn SHALL treat it as any finished task. An a2a-target execution SHALL NOT switch or occupy the cell's runtime persona.

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

The `delegate_task` tool description SHALL carry only a category summary of the market's online a2a agents (counts per category), never the full roster. A separate `search_agents` tool SHALL return, for a keyword query, at most the top N candidates (name, description, category, catalog id) from the currently online a2a entries — the delegating persona picks a ref from those results. The summary and search results SHALL derive from the same catalog view that serves human a2a chats, with no separate discovery store.

#### Scenario: The tool description stays small

- **WHEN** the delegation tools are materialized into a cell
- **THEN** the delegate description carries category counts, not the individual agents

#### Scenario: Search returns ranked candidates

- **WHEN** the persona calls search_agents with a keyword
- **THEN** the result lists at most N online a2a agents matching the keyword with their names, descriptions, and catalog ids

#### Scenario: A ref must come from discovery or the roster

- **WHEN** a delegate call names an a2a ref that search or the catalog cannot resolve
- **THEN** the task is refused as an unknown target
