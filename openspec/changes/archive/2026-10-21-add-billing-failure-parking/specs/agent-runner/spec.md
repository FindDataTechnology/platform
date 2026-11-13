## ADDED Requirements

### Requirement: A billing-rejected key parks the agent's turns

When a deployed role's turn fails with an LLM-reported failure, the runner SHALL classify the failure by probing the role's pinned LLM key against the provider's zero-spend model-list endpoint — the same billing gate the turn passed through, exercised without any upstream spend. When the probe reports the key rejected by the billing gate (insufficient balance, or an invalid key), the runner SHALL park the role: rhythm self-turns and day-rollover digests are skipped while parked, and an inbound message turn fails fast with a structured parked error (code `-32012`) whose message names the rejection reason and the time the role was parked, without issuing an LLM request. Parking is automatic and distinct from deployer pause: it SHALL NOT mark the registry entry paused, and it SHALL NOT survive a key re-pin — a descriptor change that re-materializes the role clears the park. While parked, the runner SHALL re-probe on a configurable slow cadence and SHALL resume the role automatically when the probe passes, emitting a fleet event on park and on resume that carries the reason. A probe that passes, that fails for transport reasons, or that targets a provider type the runner cannot probe SHALL NOT park — such turns keep the behavior they had before this change. The runner's health report SHALL annotate a parked role with the reason and park time without changing the lifecycle states it already reports.

> Code note (apply-time correction): the parked code is `-32012`, not the originally drafted `-32011` — `-32011` is already the a2a delegation depth bound (`agent-runner/a2a.js`, archived change add-agent-delegation-a2a D4). A structured parked error must be distinguishable by code alone, so it takes the next free runner code.

#### Scenario: An exhausted key parks the role after one failed turn

- **WHEN** a role's pinned key is rejected by the billing gate with insufficient balance and a rhythm self-turn or rollover digest fails with the LLM-failure code
- **THEN** the runner probes the key, parks the role with reason insufficient-balance, emits the park event, and issues no further LLM request for that role's self-turns or digests until it resumes — the minute-cadence rollover check does not retry the digest

#### Scenario: An inbound message to a parked role fails fast

- **WHEN** an A2A message or stream request arrives for a parked role
- **THEN** the caller receives code `-32012` with a message naming the rejection reason and park time, no LLM request is made, and no child is cold-started for that turn

#### Scenario: An invalid key parks with its own reason

- **WHEN** the probe reports the pinned key invalid rather than under-funded
- **THEN** the role is parked with reason key-invalid, distinct from insufficient-balance, so the deployer can tell re-keying from recharging

#### Scenario: Recharging resumes the role without operator action

- **WHEN** a parked role's key passes the probe on a later slow-cadence re-probe
- **THEN** the role is un-parked, the resume event is emitted with the original reason, and the role's next self-turn, digest, and message run normally

#### Scenario: An upstream flake does not park

- **WHEN** a turn fails with the LLM-failure code but the probe passes
- **THEN** the role is not parked, the failed turn is metered as before this change, and the role's next scheduled turn runs

#### Scenario: A key re-pin clears the park

- **WHEN** a parked role's descriptor changes its billing key reference and the role re-materializes
- **THEN** the park is cleared and the first turn on the new key proceeds — and parks again only if that key is also rejected

#### Scenario: Deployer pause and automatic park are independent

- **WHEN** a parked role is paused by its deployer and later resumed
- **THEN** callers receive the paused error while paused, and after resume the park still gates turns until a probe passes

#### Scenario: A runner restart bounds the regression to one turn

- **WHEN** the runner restarts while a role's key is still rejected
- **THEN** at most one failed turn for that role is issued before it is parked again

#### Scenario: An unprobeable provider keeps today's behavior

- **WHEN** a role runs on a provider type the runner cannot probe
- **THEN** its LLM-failure turns are handled exactly as before this change and the role is never parked

#### Scenario: Health reports the park alongside the lifecycle state

- **WHEN** the health endpoint reports a parked role
- **THEN** the role's entry carries the park reason and park time in addition to its existing lifecycle state
