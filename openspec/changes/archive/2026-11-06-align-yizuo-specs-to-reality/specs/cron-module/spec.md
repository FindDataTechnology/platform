## MODIFIED Requirements

### Requirement: Job scheduling API
The system SHALL support three schedule forms for tasks whose trigger is a schedule: one-shot at an absolute time, one-shot at a relative delay from acceptance, and recurring either on a cron expression or on an every-N interval rule (number 1–200 × unit minute/hour/day/week). A recurring task MAY carry a maximum run count; on reaching it the task transitions to completed automatically. Each task carries a prompt and its target-persona/session binding. Management operations — list, remove, pause, resume, run-now, and **update** (change name/prompt/schedule/max-runs while preserving the task id, its execution history, and its paused state) — SHALL remain available over the existing cell WebSocket surface using the existing `cron_*` message and event types. Interval validation SHALL reject units outside the supported set with a structured error.

#### Scenario: Create a recurring job
- **WHEN** a client sends a job-create request with a cron expression and a prompt
- **THEN** the system SHALL create a task with a schedule trigger and broadcast its status with an identifier, schedule, and next-run time

#### Scenario: Create an interval job

- **WHEN** a client sends a job-create request with an interval rule (e.g. every 90 minutes) and a prompt
- **THEN** the system SHALL create a recurring task anchored at acceptance that fires at each elapsed period

#### Scenario: Interval unit outside the supported set is refused

- **WHEN** a client sends a job-create or update request with an interval unit of `month` or `year`
- **THEN** the system SHALL reject it with a structured validation error naming the supported units

#### Scenario: Create a one-shot job
- **WHEN** a client sends a job-create request with an absolute time and a prompt
- **THEN** the system SHALL create a task scheduled to run once at that time

#### Scenario: Pause and resume
- **WHEN** a task with a schedule trigger is paused
- **THEN** its schedule SHALL stop firing until it is resumed
- **AND** on resume a recurring task SHALL continue from the next future occurrence

#### Scenario: Run now
- **WHEN** a run-now request is sent for a task
- **THEN** the task SHALL execute once immediately regardless of its schedule, without affecting future scheduled occurrences

### Requirement: Downtime and expiry lifecycle
Recurring schedules whose occurrences passed while the runtime was down SHALL follow the catch-up tolerance discipline: occurrences inside the tolerance window (2× period, 6-hour floor; kill switch `PLATFORM_CRON_CATCHUP`) SHALL be made up once with a make-up marker, and occurrences beyond the window SHALL NOT execute — the gap SHALL be recorded on the task as a missed record and surfaced through the explicit missed-beat alert (openspec: task-engine). One-shot schedules whose time passed while down SHALL mark their task expired at load. This discipline is the single authority for catch-up semantics; residency and wake surfaces (openspec: cell-gateway, cell-lifecycle) reference it and SHALL NOT redefine it.

#### Scenario: Missed occurrences are not replayed
- **WHEN** a daily task's cell was down longer than the catch-up tolerance window across one scheduled occurrence and starts afterwards
- **THEN** the missed occurrence SHALL NOT execute
- **AND** the task SHALL record a missed marker for it
- **AND** future occurrences SHALL fire normally

#### Scenario: Missed occurrence inside the tolerance window is made up once

- **WHEN** a daily task's cell was down briefly across one scheduled occurrence and starts afterwards
- **THEN** the occurrence SHALL be made up exactly once with a make-up marker
- **AND** future occurrences SHALL fire normally

#### Scenario: Missed occurrences beyond the tolerance window are recorded and alerted

- **WHEN** a task's cell was down longer than the tolerance window and occurrences were skipped
- **THEN** the skipped occurrences SHALL NOT execute
- **AND** the task SHALL record the miss and an explicit missed-beat alert SHALL be emitted naming the task and count
- **AND** future occurrences SHALL fire normally

#### Scenario: One-shot expired during downtime
- **WHEN** the cell starts and a one-shot task's time is in the past
- **THEN** the task SHALL be marked expired without executing

### Requirement: Update preserves identity and history
An update changing the schedule SHALL recompute the next occurrence from the new form while keeping the task id, its execution history, and its paused state. An update MAY change name, prompt, schedule form, max-runs, and the target persona/session binding (re-binding detaches the old session attachment and attaches the new target while preserving history). Pause/resume is honored as-is.

#### Scenario: reschedule keeps the record
- **WHEN** a running-since-weeks daily job is updated to `0 10 * * 1-5`
- **THEN** the same id keeps its history rows and now fires weekday 10:00, unpaused if it was unpaused

#### Scenario: retarget keeps the record

- **WHEN** a task is updated to a different target persona
- **THEN** the same id keeps its history rows and future occurrences fire on the new target
