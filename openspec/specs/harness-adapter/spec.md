# harness-adapter Specification

## Purpose

Defines the agent-level harness adapter contract: how the agent-runner drives any AI harness
(dsh today, ACP-speaking agents like Claude Code next) through one interface — spawn, turns,
usage, lifecycle, and capability self-report — so serving a deployed agent is independent of the
harness process behind it.

## Requirements

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
harness). A pack's serving contract SHALL be able to declare that harness as a bounded NAME
(the runner-side allowlist resolves a name, never a command), and the manifest validator SHALL
admit that declaration — a gate that reads a field the publish path refuses is a broken seam.
The runner SHALL report the harnesses it can host in its heartbeat, and the deploy gate SHALL
refuse — naming the missing harness and the target runner — a deployment whose declared harness
is not in the target runner's reported set; unknown or absent self-report SHALL degrade open,
exactly like the model-roster gate. The heartbeat SHALL also carry the runner's pod co-hosting
mode (density) so fleet views can tell solo runners from pod runners; an absent density field
SHALL degrade open (read as a solo runner). Routing a deployment to a runner SHALL use the existing
runner assignment channel; no second placement mechanism SHALL be introduced.

#### Scenario: A harness-mismatched deployment is refused at deploy time

- **WHEN** a descriptor declares `harness: acp-claude-code` and the target runner reports only dsh
- **THEN** the deploy is refused with an error naming the harness and the runner

#### Scenario: A declared harness publishes and reaches the deploy gate

- **WHEN** a pack's serving contract declares `harness: acp-claude-code` and the pack is published
- **THEN** the manifest validates (the declaration is a legal serving key) and a deploy of the
  published version to a runner reporting only dsh is refused with the mismatch error

#### Scenario: The heartbeat reports hostable harnesses

- **WHEN** a runner with both dsh and ACP adapters heartbeats
- **THEN** its runner_stats row carries the harness set the deploy gate reads

#### Scenario: The heartbeat reports the runner's density mode

- **WHEN** a runner configured for pod co-hosting heartbeats
- **THEN** its runner_stats row carries a truthy pod density field, and a solo runner carries a
  falsy one

#### Scenario: Unknown harness metadata degrades open

- **WHEN** the target runner's heartbeat carries no harness field (older runner)
- **THEN** the deploy proceeds under the legacy behavior

### Requirement: Pack content materializes into the target harness's native layout

The runner's composition SHALL be harness-aware: a deployment's pack content — persona, skills,
MCP references, and data-workspace declaration — SHALL be materialized into the layout the
declared harness natively reads. For the default dsh harness this SHALL be the existing
private-home pipeline, unchanged; for an ACP harness this SHALL be a private per-agent
workspace carrying the persona as the harness's native project-instructions file, one
harness-native skill entry per pack skill, the MCP references on the harness's
session-creation channel as authorized streamable-http servers, and the data workspace
exposed through the process environment. Composition SHALL NOT materialize artifacts the
target harness cannot read (no dsh home for a non-dsh spawn). Pack parts with no honest
equivalent on the target harness SHALL fail closed with a structured error naming them
(deployment secrets) or degrade with a recorded warning (tool allowlists) — never silently
drop. Deployer billing SHALL be preserved across harnesses: a deployment pinning a billing
key reference authenticates its harness process with the deployer's key, uniform with the
dsh path's attribution semantics. A hosted harness name without a layout mapping SHALL serve
bare — workspace, environment, model — with the unmapped content parts named in a warning.

#### Scenario: An ACP deployment's pack content lands in the harness-native workspace

- **WHEN** an ACP-harness deployment with a persona, two skills, one MCP reference, and a
  data-workspace declaration is composed
- **THEN** its private workspace carries the persona as the harness's project-instructions
  file, one harness-native skill entry per skill, the MCP reference rides the
  session-creation channel as a streamable-http server bearing the caller's authorization,
  and the data workspace reaches the process as environment markers

#### Scenario: The dsh composition pipeline is unchanged

- **WHEN** a deployment on the default dsh harness is composed and spawned
- **THEN** it materializes exactly the private dsh home the runner produced before
  harness-aware composition — no harness-native workspace files appear in a dsh home, and
  no dsh home is built for a non-dsh spawn

#### Scenario: Deployment secrets are refused, not silently dropped

- **WHEN** an ACP-harness deployment declares deployment secrets and composition runs
- **THEN** composition fails with a structured error naming the secrets and the harness's
  lack of a controlled channel for them — the agent never starts half-credentialed, and the
  failure distinguishes itself from a fetch failure

#### Scenario: An unmapped harness serves bare with the gap named

- **WHEN** a hosted harness name has no layout mapping and its deployment declares pack
  content beyond the bare spawn inputs
- **THEN** the deployment still serves with its workspace, environment, and model, and a
  recorded warning names every content part that found no native mapping

#### Scenario: The deployer's billing key applies on the non-default harness

- **WHEN** an ACP-harness deployment pins a billing key reference while its runner holds a
  standing harness credential
- **THEN** the spawned harness process authenticates with the deployer's key, so its turns
  bill the deployer with the same attribution semantics as the dsh path
