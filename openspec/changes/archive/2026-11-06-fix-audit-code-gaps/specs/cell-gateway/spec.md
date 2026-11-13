## MODIFIED Requirements

### Requirement: Cells start on demand and are always-on by default

The gateway SHALL spawn, suspend, wake and destroy cells as directed by the durable cell
registry and each cell's residency policy: `always` cells are kept resident while
the gateway runs; a cell of policy `on_demand` SHALL be started for traffic or for a due
scheduled task; a cell of policy `ephemeral` follows traffic alone. An idle
`suspended` cell whose scheduled work is due SHALL be woken by the gateway's duty ring rather
than held resident — the former "enabled cron jobs or bots block reaping" exemption is
superseded for registry-tracked deployments (a legacy no-registry deployment mode keeps the
cron/bot reaping exemption byte-for-byte). Scheduled work due for wake covers cron-expression
jobs, interval recurring jobs, and future one-shot jobs per the lifecycle semantics
(openspec: cell-lifecycle). Cold-parking a cell means the user's chat cold-starts on next visit, and due work runs via wake — with the
honest caveat that a wake requires the gateway to be running.

#### Scenario: due scheduled work wakes a suspended cell

- **WHEN** a `suspended` cell holds an interval recurring job whose next occurrence is due
- **THEN** the duty ring wakes the cell so the in-cell task engine can fire the occurrence
- **AND** the cell is parked again after its quiet period

#### Scenario: first visit cold-starts the user's cell

#### Scenario: scheduled jobs block reaping

#### Scenario: concurrent first requests spawn one cell

#### Scenario: replacing a record terminates the old process

#### Scenario: no orphan process survives record removal

#### Scenario: low headroom refuses residency with a readable reason

#### Scenario: headroom recovery re-admits residency

#### Scenario: unreadable metrics fail open

#### Scenario: legacy no-registry deployments keep the reaping exemption

- **WHEN** a legacy deployment without a cell registry holds enabled cron jobs or bots
- **THEN** the reaping exemption behavior is preserved byte-for-byte
