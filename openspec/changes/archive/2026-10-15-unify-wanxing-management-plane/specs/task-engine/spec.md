## ADDED Requirements

### Requirement: The task engine exposes a read-only stats snapshot

The task engine SHALL expose a stats snapshot derived purely from its own store and execution
state: the count of scheduled tasks, executions by lifecycle state (at minimum running and
queued), the worker pool's occupancy (cap, busy, idle), and recent terminal-outcome counts.
The snapshot SHALL contain counts and identifiers only — never task prompts or other user
content — because it feeds platform-level telemetry. Sampling the snapshot SHALL have no side
effects on execution.

#### Scenario: The snapshot reports execution and worker-pool state

- **WHEN** one execution is running, two are queued, and the worker pool holds cap 4 with 1 busy
- **THEN** the stats snapshot reports those execution counts and `{cap: 4, busy: 1, idle: 3}`-shaped
  worker occupancy

#### Scenario: The snapshot carries no user content

- **WHEN** a scheduled task's prompt is set and executions entries exist
- **THEN** the snapshot's serialization contains no substring of that prompt

#### Scenario: The HTTP lane serves the snapshot under standard cell auth

- **WHEN** an authenticated request hits the cell's task stats endpoint
- **THEN** it answers the stats snapshot JSON; the route is NOT loopback-exempt
