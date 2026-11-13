# harness-adapter 变更（add-harness-adapter）

## Purpose

Defines the agent-level harness adapter contract: how the agent-runner drives any AI harness
(dsh today, ACP-speaking agents like Claude Code next) through one interface — spawn, turns,
usage, lifecycle, and capability self-report — so serving a deployed agent is independent of the
harness process behind it.

## ADDED Requirements

### Requirement: The harness adapter contract is agent-level and harness-neutral

The runner SHALL drive every hosted agent through a harness adapter implementing one contract:
spawn a harness runtime for one composed agent home, run a turn for a session id (returning the
assistant text and any usage the harness reports), cancel/stop the runtime, expose the runtime
pid for footprint sampling, and report its capabilities. The contract SHALL be agent-level only:
density tricks (multi-agent co-hosting), wire session namespacing, persona/model parking, and
live-control RPCs are harness-implementation details and SHALL NOT appear in the interface.
Two adapters SHALL be interchangeable behind the interface — a test suite drives the same
contract assertions against every adapter implementation.

#### Scenario: Adapters are interchangeable behind the contract

- **WHEN** the contract test suite runs against the dsh adapter and an ACP adapter
- **THEN** both satisfy the same spawn/turn/stop/pid/capabilities assertions without
  harness-specific branches in the test body

#### Scenario: Harness-specific depth stays inside the implementation

- **WHEN** the ACP adapter is inspected
- **THEN** it exposes no pod-density, wire-namespacing, or preset-parking surface — those
  concepts exist only in the dsh adapter's internals

### Requirement: Capabilities are self-reported and absence degrades open

An adapter SHALL report its capabilities (at minimum: whether live model switching, session
cancel, streaming deltas, and per-session persona selection are available). Callers SHALL
degrade open on absent capabilities: a missing capability field means unknown, not unsupported —
the runner keeps its legacy paths, and a control call against an unsupported capability SHALL
fail with a structured error naming the missing capability rather than silently no-op or crash.

#### Scenario: A control call on an unsupported capability fails structurally

- **WHEN** the host asks an ACP-adapter agent for a live persona switch it does not support
- **THEN** the call fails with a structured error naming the unsupported capability, and the
  agent's current composition is untouched

#### Scenario: Absent capability metadata degrades open

- **WHEN** an adapter reports no capabilities at all (older implementation)
- **THEN** the runner proceeds with its legacy paths and never refuses the agent for
  missing capability metadata

### Requirement: The ACP adapter drives any ACP-speaking agent binary over stdio

The ACP adapter SHALL drive an external harness process over stdio using the Agent Client
Protocol: `initialize` handshake, lazy `session/new` per conversation context (absolute cwd),
optional `session/set_config_option` for model selection, `session/prompt` per turn settling on
the reported stop reason, `session/cancel` for cancellation, and usage parsed from the wire's
`usage_update` notifications when present. A harness whose declared binary cannot start, whose
handshake fails, or whose turn ends without assistant text SHALL surface the same structured
error families the dsh path uses (cold-start failure, failed turn, empty turn) so metering and
billing semantics stay uniform across harnesses. Sessions SHALL persist across adapter restarts
by the same session id when the ACP agent supports session resume; where it does not, a
restarted adapter SHALL start the conversation fresh and SHALL NOT mix histories.

#### Scenario: An ACP turn returns assistant text and usage

- **WHEN** a deployed ACP-harness agent serves one A2A turn
- **THEN** the turn settles with the assistant's text, and usage is recorded when the wire
  carried `usage_update`

#### Scenario: An empty ACP turn settles as a failed turn

- **WHEN** an ACP harness's turn ends without any assistant text
- **THEN** the turn fails with the same empty-turn error family the dsh path uses, and the
  meter records it as a failed turn

#### Scenario: Restart continuity follows the ACP agent's own resume support

- **WHEN** the ACP adapter restarts and a known session id receives another message
- **THEN** the conversation resumes when the ACP agent supports it; otherwise it starts fresh
  on that context without mixing histories and without error

### Requirement: Harness selection is declared per deployment and gated at deploy time

A deployment descriptor MAY declare its harness (`harness` field; absent = the runner's default
harness). The runner SHALL report the harnesses it can host in its heartbeat, and the deploy
gate SHALL refuse — naming the missing harness and the target runner — a deployment whose
declared harness is not in the target runner's reported set; unknown or absent self-report
SHALL degrade open, exactly like the model-roster gate. Routing a deployment to a runner SHALL
use the existing runner assignment channel; no second placement mechanism SHALL be introduced.

#### Scenario: A harness-mismatched deployment is refused at deploy time

- **WHEN** a descriptor declares `harness: acp-claude-code` and the target runner reports only dsh
- **THEN** the deploy is refused with an error naming the harness and the runner

#### Scenario: The heartbeat reports hostable harnesses

- **WHEN** a runner with both dsh and ACP adapters heartbeats
- **THEN** its runner_stats row carries the harness set the deploy gate reads

#### Scenario: Unknown harness metadata degrades open

- **WHEN** the target runner's heartbeat carries no harness field (older runner)
- **THEN** the deploy proceeds under the legacy behavior
