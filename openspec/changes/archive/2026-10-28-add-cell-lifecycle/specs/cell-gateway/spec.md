## MODIFIED Requirements

### Requirement: Cells start on demand and are always-on by default

The gateway SHALL spawn, suspend, wake and destroy cells as directed by the durable cell
registry and each cell's residency policy (see `cell-lifecycle`): user traffic starts an
`unbound`/`suspended` cell on arrival; a cell of policy `always` SHALL remain running while
the gateway runs; a cell of policy `on_demand` SHALL be started for traffic or for a due
scheduled obligation and SHALL be drained and suspended after a configurable quiet period;
a cell of policy `ephemeral` SHALL be bounded in lifetime and destroyed at expiry. A
suspended cell whose scheduled work is due SHALL be woken by the gateway's duty ring rather
than held resident — the former "enabled cron jobs or bots block reaping" exemption is
superseded: holding scheduled work no longer forces residency, because suspension no longer
means missing the schedule. The deployment SHALL document the offline contract: a suspended
cell means the user's chat cold-starts on next visit, and due work runs via wake — with the
honest caveat that a wake requires the gateway to be running.

The gateway SHALL maintain at most one cell process per user at any time: concurrent first
requests for the same user SHALL collapse onto a single spawn (the in-flight spawn is
registered before the spawn begins, not after it returns), and a cell record SHALL never be
replaced while its process is still alive — a replacement SHALL first terminate the recorded
process. A cell process whose record was replaced SHALL NOT be left running unreachable.

#### Scenario: first visit cold-starts the user's cell

- **WHEN** an authenticated user with no running cell (`unbound` or `suspended`) makes a
  request
- **THEN** the gateway starts their cell and serves the request once the cell is ready

#### Scenario: scheduled jobs block reaping

- **WHEN** a cell holds enabled cron jobs or bots and its residency policy is `always`
- **THEN** the gateway leaves that cell running — the residency policy, not the job
  inventory, is now what keeps scheduled work resident; under `on_demand` the duty ring,
  not residency, carries the schedule

#### Scenario: concurrent first requests spawn one cell

- **WHEN** two requests for the same user arrive while that user's cell is still starting
- **THEN** exactly one cell process is spawned and both requests are served by it

#### Scenario: replacing a record terminates the old process

- **WHEN** a cell is spawned for a user whose previous record still holds a live process
- **THEN** the previous process is terminated before or during the replacement, leaving at
  most one live process for that user

#### Scenario: no orphan process survives record removal

- **WHEN** a cell record is dropped or replaced (share-respawn path, idle stop, crash
  recovery, destroy)
- **THEN** no live process for that user remains without a record, and a subsequent ensure
  starts exactly one fresh cell

## ADDED Requirements

### Requirement: The gateway persists a durable cell registry and re-arms demand at boot

The gateway SHALL persist the cell registry (per `cell-lifecycle`) in its own durable store
and SHALL treat it as the source of truth for which cells exist. On startup the gateway
SHALL enumerate the registry and rebuild the demand surface without waiting for user
traffic: cells of policy `always` SHALL be spawned; cells of policy `on_demand` with
scheduled obligations SHALL have their wake timers re-armed from the persisted task
schedules; cells past their `ephemeral` bound SHALL enter the destroy flow. A cell whose
registry state and live process disagree SHALL be reconciled toward the registry (extra
process stopped, missing obligation re-armed).

#### Scenario: rolling the gateway no longer silences fleets

- **WHEN** the gateway restarts while account cells hold enabled scheduled work
- **THEN** after boot, before any user returns, the gateway has rebuilt each cell's demand
  surface — `always` cells spawning and wake timers armed — so fleet rounds resume firing
  on their schedule

#### Scenario: registry row survives process loss

- **WHEN** a cell process dies unexpectedly (crash, kill) and the gateway itself stays up
- **THEN** the registry row persists with its residency policy and workload summary, and the
  cell's next demand (traffic or due schedule) spawns a fresh process against the same row

### Requirement: Duty ring wakes suspended cells at their due schedule

The gateway SHALL run a duty loop that evaluates `suspended`/`on_demand` cells' persisted
task schedules (cron expressions and timezones in the data-root task records) and SHALL
spawn a cell when one of its obligations comes due. The duty decision SHALL read only
persisted data (registry rows and data-root task records) and SHALL NOT probe or spawn a
cell merely to inspect it. After the woken cell's obligations drain and its quiet period
lapses, the gateway SHALL suspend it again.

#### Scenario: due schedule wakes the cell, quiet suspends it

- **WHEN** a `suspended` cell's persisted cron schedule reaches a due occurrence
- **THEN** the duty ring spawns the cell, its task engine executes the round (including any
  applicable catch-up), and after the quiet period the cell is `suspended` once more

#### Scenario: duty decision is pure and read-only

- **WHEN** the duty loop evaluates a cell with no live process
- **THEN** the decision derives entirely from registry data and the data-root task records,
  with no probe or temporary spawn of that cell

### Requirement: Operator-driven cell destroy with audit tombstone

The gateway SHALL offer an administrative destroy action for an account cell (subscription
end, expiry, operator teardown): it SHALL refuse while the cell has a running process unless
forced, stop the cell, remove its data root, and leave a tombstone row in the registry with
the destroy reason and timestamp. Destroyed-user traffic SHALL NOT respawn the cell (the
tombstone suppresses the demand surface until the row is explicitly cleared by an operator).

#### Scenario: destroy refuses over live work unless forced

- **WHEN** an operator destroys an account cell that has a live process, without the force
  flag
- **THEN** the action is refused naming the live state; with the force flag the cell is
  stopped, its data root removed, and a tombstone recorded

#### Scenario: destroyed user does not respawn on traffic

- **WHEN** an authenticated request arrives for a destroyed cell
- **THEN** the gateway does not spawn a cell for it and answers with the destroyed state
