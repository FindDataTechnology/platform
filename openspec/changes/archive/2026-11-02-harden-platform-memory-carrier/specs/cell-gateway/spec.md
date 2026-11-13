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

Cell residency admission SHALL additionally consult a memory gate (per
`platform-memory-observability`): before spawning or resuming a resident cell the gateway
SHALL check container memory headroom against a configurable threshold; below the threshold
it SHALL refuse the residency with a readable reason (current usage, limit, headroom,
threshold) instead of spawning into an out-of-memory window. The gate SHALL fail open when
memory metrics are unavailable or unreadable (admit with a warning), and SHALL govern new
residency only — it MUST NOT evict or suspend already-resident cells. The refusal surfaces
through the same residency-decision evidence channel the lifecycle registry already writes,
so operators can see gate refusals next to spawn/wake/suspend decisions.

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

#### Scenario: low headroom refuses residency with a readable reason

- **WHEN** container memory headroom is below the configured threshold and a new residency
  (spawn or park-resume) is requested
- **THEN** the residency is refused and the refusal record carries current usage, limit,
  headroom, and the threshold — no new cell process is spawned into the low-memory window

#### Scenario: headroom recovery re-admits residency

- **WHEN** a residency was refused for low headroom and headroom later recovers above the
  threshold
- **THEN** the next residency request for that user proceeds normally under the unchanged
  lifecycle policy

#### Scenario: unreadable metrics fail open

- **WHEN** the memory gate cannot read cgroup or process metrics (missing paths, malformed
  values, non-Linux environment)
- **THEN** residency is admitted with a warning and cell lifecycle behavior is identical
  to a deployment without the gate
