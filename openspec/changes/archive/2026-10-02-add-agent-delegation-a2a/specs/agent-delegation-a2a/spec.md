# agent-delegation-a2a Delta

## Purpose

The cross-agent delegation domain: a cell's persona delegates work to a MARKET Agent Service — the per-cell caller identity (registry M2M, invoke-only), a2a-target task semantics (remote-slot execution with a delegation-depth header), two-level discovery (category summary + on-demand search), and caller-side politeness.

## ADDED Requirements

### Requirement: Delegated calls carry the deployment's gateway credential

Outbound a2a task calls SHALL ride the deployment's registry service credential — the SAME credential human a2a chats ride today — as the gateway credential (`X-Authorization`), with no per-cell provisioning in this change. The credential's absence SHALL fail those calls with a structured error, never a silent fallback to another token. Per-cell invoke-only identities (attribution, per-cell revocation) are deferred to the platform-ops slice; the `paas-agent-callers` invoke-only scope prepared for that future stands ready but grants nothing until an identity maps to it.

#### Scenario: Delegation rides the service credential

- **WHEN** a delegated a2a task call leaves the cell
- **THEN** its X-Authorization carries the deployment's registry service credential, exactly as a human a2a chat does

#### Scenario: Missing credential fails loudly

- **WHEN** a delegation to a market agent is attempted while the service credential is unset
- **THEN** the task fails with a structured error naming the missing credential, and no other token is used in its place

#### Scenario: The invoke-only scope stays dormant

- **WHEN** the registry's scopes are inspected after this change
- **THEN** the paas-agent-callers scope exists with only the invoke_agent action and maps to no identity the platform provisions today

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
