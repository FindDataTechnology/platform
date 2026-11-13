## ADDED Requirements

### Requirement: Failed executions follow the configured retry policy

The engine SHALL apply a configurable retry policy to failed executions: retries follow exponential backoff with a bounded attempt count, are disabled by default (preserving the current fail-fast behavior unless enabled via configuration), and MAY be overridden per task kind. Manual re-run (existing requirement) is unaffected. A task whose retries are exhausted SHALL transition to `failed` (terminal, human-visible, re-runnable manually). Retry policy misconfiguration SHALL fail closed to the default (no retry). Each attempt SHALL be recorded on the task's execution history.

#### Scenario: Retry disabled by default preserves fail-fast

- **WHEN** a task execution fails with no retry policy configured
- **THEN** the task transitions to `failed` immediately and no automatic re-execution is scheduled

#### Scenario: Configured policy retries with backoff then succeeds

- **WHEN** a retry policy is enabled (max 3 attempts, exponential backoff) and an execution fails twice then succeeds
- **THEN** the engine re-executes the task after the backoff delay for each failed attempt and the task reaches `done` on the third execution
- **AND** each attempt is recorded on the task's execution history

#### Scenario: Retries exhausted stay terminal and manually re-runnable

- **WHEN** every attempt of a retried task fails
- **THEN** the task transitions to `failed` after the final attempt, no further automatic executions occur, and manual re-run remains available

## ADDED Requirements

### Requirement: Out-of-window missed cron beats alert explicitly

When the task engine determines a scheduled beat was missed outside the catch-up tolerance window (the existing record-only path), the engine SHALL emit an explicit alert event (same channel discipline as the metering unconfigured alert) naming the task and miss count. Silent swallowing of out-of-window misses SHALL NOT occur: the miss record alone is not sufficient.

#### Scenario: Long outage loses beats and alerts

- **WHEN** a cell is stopped longer than the catch-up tolerance window and a recurring task misses beats
- **THEN** on boot the missed beats are recorded as today AND an alert event naming the task and count is emitted
