# fleet-scheduler Specification

## Purpose

The resident control loop in the facet packs service (single writer, one replica, no election) that keeps the agent fleet's registry assignments aligned with runner health: stale/orphaned runners lose their entries to healthy targets by re-pointing, untagged deploys are auto-placed on the least-loaded machine, and desktop seats are never billed or moved by the cloud loop.

## ADDED Requirements

### Requirement: Runner health is classified from the observer board
The scheduler SHALL classify each runner on the fleet observer board as healthy or stale using a configurable staleness threshold (`staleMs`, default 90s) against `now() - seen_at`. Runner ids SHALL match `/^[a-z0-9][a-z0-9._-]{0,63}$/i` and carry a finite `seen_at`; malformed rows SHALL be ignored. Desktop seats (id prefixed `desktop-` or `desktop === true`) SHALL be excluded from both classifications — they are monitoring-only, not control subjects.

#### Scenario: stale runner is detected
- **WHEN** a runner's `seen_at` is older than `staleMs` and it is not a desktop seat
- **THEN** it SHALL appear in `stale(board)` and not in `healthy(board)`

#### Scenario: malformed board row is ignored
- **WHEN** a board row has an invalid id or a non-finite `seen_at`
- **THEN** it SHALL appear in neither classification

### Requirement: Failback re-points entries from stale or orphaned runners
On a tick, entries assigned to a stale runner (explicit `metadata.runner_id`, or untagged entries owned by the default runner) SHALL be re-pointed to the healthy runner with the most budget headroom (fewest children breaking ties), with a free port resolved for the target. The registry entry's url + assignment SHALL flip via `putAgent`. The move SHALL be a COLD rebuild: pack/persona re-materialize on the target's next poll, and warm session transcripts die with the dead node — the agent does not migrate its conversation.

#### Scenario: stale runner loses its entries
- **WHEN** a stale runner holds entries and at least one healthy target has room
- **THEN** each entry SHALL be re-pointed to the healthiest target with a resolved port
- **AND** no move SHALL occur without a healthy target with room

#### Scenario: board unreachable skips the pass
- **WHEN** `boardFetch` throws or returns no `runners`
- **THEN** the pass SHALL log and return `moved: 0`, mutating no entry

### Requirement: Recovery is hysteretic
A moved entry SHALL NOT move back when its original runner recovers: the recovered runner re-enters the pool as a TARGET only. A moved entry's assignment SHALL be rewritten to an explicit `runner_id` so subsequent passes treat it as deliberately placed.

#### Scenario: recovered runner does not reclaim entries
- **WHEN** a runner that lost entries later reports healthy again
- **THEN** its old entries SHALL stay on the target they were moved to
- **AND** the recovered runner SHALL be eligible only as a new placement target

### Requirement: Orphaned entries are reaped past a grace window
A runner that is absent from the board entirely (pruned by the observer) SHALL have its assigned entries treated as orphaned once its fleet row is past `orphanGraceMs` (default 600s). A brand-new runner still inside its grace SHALL keep its pre-assigned entries. Desktop seats pruned from the board SHALL NOT be treated as orphaned — their entries wait for the seat to return.

#### Scenario: pruned runner past grace loses entries
- **WHEN** an entry's runner is absent from the board and its fleet row is older than `orphanGraceMs`
- **THEN** the entry SHALL be re-pointed to a healthy target

#### Scenario: booting runner keeps its entries
- **WHEN** the absent runner's fleet row is younger than `orphanGraceMs`
- **THEN** its entries SHALL NOT be moved

### Requirement: Placement hint picks the least-loaded healthy runner
`pickPlacement(board, { exclude })` SHALL return the healthy non-desktop runner with the most remaining memory budget (`budget_mb_limit - budget_mb`), breaking ties by fewer children, excluding any named ids. It SHALL return `null` when no candidate remains. The deploy route SHALL use it to auto-place untagged deploys when the fleet holds more than one machine; a single-machine fleet SHALL keep the existing default assignment.

#### Scenario: untagged deploy is auto-placed
- **WHEN** a multi-runner fleet deploys an untagged agent
- **THEN** the deploy route SHALL place it on `pickPlacement`'s least-loaded healthy runner

#### Scenario: no candidate returns null
- **WHEN** every healthy runner is excluded or the board has none
- **THEN** `pickPlacement` SHALL return `null`

### Requirement: The loop is single-writer, interval-driven, and stoppable
`start()` SHALL schedule an immediate pass and then one pass every `intervalMs` (default 30s), with overlapping passes suppressed by a `running` guard and the timer unref'd. `stop()` SHALL clear the timer. Desktop seats SHALL be invisible to every control decision: never a failover source, never a placement target, never orphan-reaped.

#### Scenario: overlapping passes do not run
- **WHEN** a pass is still in flight when the next interval fires
- **THEN** the scheduled pass SHALL be skipped, not queued

#### Scenario: desktop seat is never a control subject
- **WHEN** a `desktop-` runner is offline or pruned from the board
- **THEN** its entries SHALL NOT be re-pointed, it SHALL NOT be picked for placement, and it SHALL NOT be orphan-reaped
