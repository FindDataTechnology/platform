# pack-usage-telemetry Specification

## Purpose

Internal supply feedback for the pack marketplace (roadmap M1): every completed chat turn is recorded with its acting agent's pack origin, so weekly-active-pack and per-pack usage aggregates answer supply decisions. A tiny ops-gated read surface; zero user-facing change.

## Requirements

### Requirement: Every completed turn records a usage row

For every completed turn the server SHALL record one row carrying timestamp, user identity, session, acting agent id, the agent's pack origin (null for local personas and custom presets), outcome, and duration. Recording SHALL be failure-isolated: a telemetry error SHALL never fail or delay the chat turn.

#### Scenario: A pack-agent turn lands its row

- **WHEN** a turn completes with a pack-sourced agent active
- **THEN** one row exists with that pack's origin, the user, the session, and the turn outcome

#### Scenario: A local turn lands a packless row

- **WHEN** a turn completes on the local persona or a custom preset
- **THEN** the row exists with a null pack origin and is aggregated separately

#### Scenario: Telemetry never breaks the turn

- **WHEN** the usage write fails
- **THEN** the turn completes normally and the failure is only logged

### Requirement: Aggregates answer the weekly-active question

The aggregate query SHALL return, per pack origin over the requested window (default 7 days): turn count, distinct active users, and last-used timestamp; packless turns SHALL be one separate line. The count of packs with at least one active user in a 7-day window SHALL be directly derivable.

#### Scenario: A seven-day window derives weekly actives

- **WHEN** the aggregate is queried for 7 days
- **THEN** each line carries turns, distinct users, and last-used, and the number of lines with a pack origin and ≥1 user is the weekly-active-pack count

#### Scenario: The packless bucket stays separate

- **WHEN** local and custom-preset turns exist in the window
- **THEN** they aggregate into their own line and never inflate any pack's numbers

### Requirement: The aggregate surface is ops-gated

The aggregate endpoint SHALL require the ops credential; unauthenticated or wrong-credential requests SHALL be refused with no data.

#### Scenario: The ops credential reads aggregates

- **WHEN** the endpoint is called with the ops credential
- **THEN** the aggregates are returned

#### Scenario: Anything else is refused

- **WHEN** the endpoint is called without or with a wrong credential
- **THEN** the request is refused and no usage data is exposed

### Requirement: Storage is bounded and pruned

Usage rows older than the retention window (default 180 days) SHALL be pruned on a recurring timer, not only at process start; pruned volume SHALL be reclaimed.

#### Scenario: Old rows are pruned on a timer

- **WHEN** rows age past the retention window while the process runs
- **THEN** a recurring prune removes them and the storage does not grow unbounded

### Requirement: Per-agent usage is readable by the role's own owner

The system SHALL expose a per-agent usage read surface returning, for the requested window (default 7 days): each `agent_id` with its turn count and last-used timestamp. This surface SHALL be gated on the requesting identity (a logged-in user reads their own usage; an auth-off deployment's requester is the machine owner) and SHALL NOT require the ops credential. It SHALL draw from the same `pack_usage_events` rows as the per-pack aggregate — no second recording path, no second source of truth.

#### Scenario: An owner reads which roles they actually use

- **WHEN** a logged-in user requests their per-agent usage over 7 days
- **THEN** each agent id they used carries a turn count and a last-used timestamp, and agents they never used are simply absent (not zero-filled as if measured)

#### Scenario: No usage data without a record

- **WHEN** the window contains no rows for the requester
- **THEN** the surface answers with an empty list, never fabricated rows

#### Scenario: Unidentifiable requester is refused

- **WHEN** the per-agent surface is called with no resolvable requester identity on an auth-on deployment
- **THEN** the request is refused and no usage data is exposed

### Requirement: The ops per-pack aggregate keeps its gate and grouping

The existing ops-gated per-pack aggregate SHALL remain unchanged by this capability: same endpoint, same ops-credential requirement, same per-pack grouping. The two surfaces SHALL read the same rows and SHALL NOT diverge in what they count.

#### Scenario: The ops aggregate is unaffected

- **WHEN** the per-agent surface is added
- **THEN** `GET /api/ops/pack-usage` keeps its ops-credential gate and its per-pack grouping exactly as before
