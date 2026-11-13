## MODIFIED Requirements

### Requirement: Workers spawn on demand with persona affinity
The pool SHALL execute a due task targeting persona P on an idle worker bound to P. When no such worker exists and the pool is under its cap, one SHALL be spawned for P; when the pool is at cap, the task SHALL queue until a slot frees. A worker SHALL keep its persona for its entire lifetime. A worker's turn SHALL be prompted under the SAME per-round child conversation id the primary chain derives (`roundChildSessionId`), never the stable mirror session id: the mirror id stays the transcript/sidebar id, while the runtime conversation rotates per round so a worker round never re-reads its own accumulated history. The worker's collector, abort registry and slot watchdog SHALL all key on that child id.

#### Scenario: Spawn on demand
- **WHEN** a task targeting persona P is due, no worker bound to P exists, and the pool is under cap
- **THEN** a worker is spawned bound to P and the task executes on it

#### Scenario: Reuse an idle same-persona worker
- **WHEN** a task targeting persona P is due and an idle worker bound to P exists
- **THEN** the task executes on that worker without spawning another

#### Scenario: Queue at cap
- **WHEN** a task is due, no matching idle worker exists, and the pool is at its cap
- **THEN** the task remains queued until a worker slot frees, and no worker is spawned

#### Scenario: Worker round rotates its runtime conversation

- **WHEN** a fleet task executes on a worker slot
- **THEN** the runtime is prompted under `<mirror>#r<startedAt>` (not the mirror id), the transcript still lands on the mirror id, and the collector/abort/watchdog keys are the child id

#### Scenario: No cross-claim of one conversation

- **WHEN** the pool holds more than one slot
- **THEN** two workers SHALL NOT be prompted under the same child conversation id (the observed failure was `session "…" is already owned by …`, first seen the hour the cap went from 1 to 3)

