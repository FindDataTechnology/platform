# chart-data-binding Specification

## Purpose

Binds a captured time-series chart to the MCP read call that produced its data, so the chart can be refreshed from its source without re-running a model turn, under a strict read-only replay gate with defined failure semantics.

## Requirements

### Requirement: A binding is a first-class, shareable data source

The system SHALL persist chart data bindings as rows independent of any resource: a binding identifies one MCP read call (server, tool, arguments) plus the mapping that extracts `(period, value)` pairs from its response, and SHALL carry a lineage key derived deterministically from that identity. Multiple chart resources (including multiple series of one chart) MAY reference the same binding; a binding that no resource references SHALL NOT be replayed by any automatic trigger and SHALL be removed by the retention/cleanup path. Bindings SHALL be limited to the time-series read tools of supported servers (v1: `fd-open-data-mcp` `read_series` and `read`); a chart that is not time-series, or whose data came from any other tool (web search, RAG, shell, memory, a non-supported server or tool), SHALL remain an unbound static snapshot and SHALL be presented as such. The binding SHALL record the series' unit as first observed; the unit is part of the data contract (see the observation-history capability).

#### Scenario: two charts over one data source share one binding

- **WHEN** two chart resources are bound to the same server, tool, arguments, and mapping
- **THEN** both reference the same binding row (one lineage key)
- **AND** refreshing either updates the shared observation data both render from

#### Scenario: an unbindable chart stays a static snapshot

- **WHEN** a chart's data did not come from a supported time-series read call — for example a category comparison chart, or a series fetched through web search
- **THEN** no binding is created for it
- **AND** it is presented in the UI as an unbound chart with no source line and no refresh affordance

### Requirement: Bindings are created from three sources with a fixed priority

A binding SHALL be attachable to a chart resource from three sources: **declared** (the agent explicitly declares the data call through the declared channel), **confirmed** (the user picks from same-turn call candidates presented on the chart), and **inferred** (exactly one same-turn MCP call maps onto the recorded option with high confidence). When sources conflict, the priority SHALL be declared > confirmed > inferred: an explicit user confirmation SHALL override a prior inferred binding; a later declared binding for the same series SHALL override a confirmed one. A binding SHALL record its origin. Every same-turn candidate the user is offered SHALL be an MCP call that actually executed in the turn that produced the chart, with its exact name and arguments — never a guessed or reconstructed call.

#### Scenario: the declared binding wins over an earlier inferred one

- **WHEN** a chart already carries an inferred binding and the agent later declares a different data call for the same chart
- **THEN** the declared binding replaces the inferred one
- **AND** the binding's recorded origin reflects the change

#### Scenario: user confirmation from real candidates

- **WHEN** the user opens the binding affordance on a chart whose turn executed two MCP calls
- **THEN** both calls are offered as candidates with their exact tool names and arguments
- **AND** picking one attaches that call as the binding with origin `confirmed`

#### Scenario: no unique match means no inference

- **WHEN** a chart's turn executed two MCP calls whose responses could both plausibly map onto the recorded option, or none can
- **THEN** no binding is inferred automatically
- **AND** the chart remains eligible for user confirmation

### Requirement: The agent can declare a binding through a registered tool

The declared channel SHALL be a tool registered in the agent's roster (visible to every preset and persona, like the existing tool-search bridge), whose arguments name the exact MCP tool called, its arguments, and the period/value mapping used for the chart. The declaration SHALL be validated against the calling agent's actually-visible roster — a declared tool that is not mounted SHALL be rejected with a reason the model can relay to the user. The tool SHALL be read-only with respect to platform state: declaring a binding SHALL NOT execute the data call, install anything, or mutate any extension, credential, or session.

#### Scenario: a declaration lands

- **WHEN** the agent calls the declared-channel tool after drawing a chart from a `read_series` call, naming the tool, arguments, and mapping
- **THEN** the binding is attached to the chart captured from that turn with origin `declared`
- **AND** the tool's result confirms the registration

#### Scenario: a declaration for an unmounted tool is refused with a reason

- **WHEN** the agent declares a binding naming a tool that is not in its visible roster
- **THEN** the declaration is rejected, nothing is bound
- **AND** the rejection result states the reason so the model can tell the user

#### Scenario: declaring never executes the data call

- **WHEN** the agent declares a binding
- **THEN** no MCP data call is executed as part of the declaration
- **AND** the first data fetch happens only when a refresh is triggered

### Requirement: Replaying a binding is gated by a per-tool read-only allowlist

The system SHALL maintain an explicit per-tool allowlist of replayable read tools, defaulting to deny, configured per deployment; a tool not on the allowlist SHALL never be called by any automatic or manual refresh. The allowlist SHALL be maintained as data (configurable without a code change). An allowlist entry SHALL name the server and the exact tool name; prefix or pattern matches SHALL NOT be accepted as allowlist semantics. The replay caller SHALL authenticate with the same per-user registry credential the dsh child uses for that server; a missing, stale, or expired credential SHALL fail the refresh per the failure semantics below, not bypass the gate.

#### Scenario: an off-allowlist tool is never replayed

- **WHEN** a binding (however created) names a tool that is not on the deployment's read-only allowlist
- **THEN** no refresh call is made for it
- **AND** the binding is presented as not refreshable with a reason naming the allowlist

#### Scenario: the replay uses the user's registry credential

- **WHEN** a refresh executes the bound data call
- **THEN** it authenticates with the same registry credential source the agent runtime uses for that server
- **AND** no separate or elevated credential is introduced

### Requirement: Refresh triggers and the cheap freshness gate

A bound chart SHALL be refreshable by explicit user action. It MAY additionally refresh on open when its data is older than a per-binding TTL, and on a per-binding cron rule the user sets. Every refresh tick — manual, on-open, or scheduled — SHALL first consult a cheap freshness signal (the source's coverage statistics for the bound concept) and SHALL skip the series read when nothing moved upstream since the last observation; a manual refresh SHALL always perform the series read regardless of the gate. A refresh SHALL NOT trigger any upstream data fetch: only cache-read tools are replayable, and the read-through/force-fetch variants SHALL NOT be invoked by any automatic trigger.

#### Scenario: a manual refresh always reads

- **WHEN** the user activates refresh on a bound chart
- **THEN** the bound data call is executed and the observation recorded, regardless of the freshness gate

#### Scenario: a scheduled tick skips when upstream has not moved

- **WHEN** a scheduled refresh tick runs and the freshness signal is unchanged since the last observation
- **THEN** no series read is made
- **AND** the refresh is recorded as skipped-for-freshness, not as an error

#### Scenario: refresh never forces an upstream fetch

- **WHEN** any refresh of a bound chart executes
- **THEN** it calls only the bound cache-read tool
- **AND** no read-through or force-fetch variant is invoked

### Requirement: Refresh failure keeps the last good data and says why

A refresh that fails — unreachable server, authentication failure, tool error, unit mismatch, or a response that does not satisfy the mapping contract — SHALL NOT modify the chart's rendered data, SHALL NOT blank or delete the chart or its history, and SHALL mark the binding stale with a machine-readable reason and a timestamp. Stale markings SHALL clear on the next successful refresh. Consecutive failures of a scheduled binding SHALL back off exponentially up to a bound ceiling; the manual refresh path SHALL NOT be rate-limited by this backoff. A stale chart SHALL remain fully readable and its source line SHALL show the age of its data instead of hiding it.

#### Scenario: a failed refresh leaves the chart intact

- **WHEN** a refresh fails because the server is unreachable
- **THEN** the chart still renders its last good data
- **AND** the binding is marked stale with a reason and timestamp
- **AND** the chart's source line reports how old the shown data is

#### Scenario: stale clears after recovery

- **WHEN** a refresh succeeds after one or more failures
- **THEN** the stale marking is cleared
- **AND** the observation history records both the failures and the recovery

#### Scenario: unit mismatch is refused, not silently rescaled

- **WHEN** a refresh returns points whose unit differs from the unit recorded on the binding
- **THEN** the refresh is refused with a unit-mismatch reason
- **AND** no points from that response are written