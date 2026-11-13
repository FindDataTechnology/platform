# cron-module Specification (delta)

## MODIFIED Requirements

### Requirement: Job scheduling API
The system SHALL support three schedule forms for tasks whose trigger is a schedule: one-shot at an absolute time, one-shot at a relative delay from acceptance, and recurring either on a cron expression or on an every-N interval rule (number 1–200 × unit minute/hour/day/week/month/year, optionally pinned to a time-of-day phase). A recurring task MAY carry a maximum run count; on reaching it the task transitions to completed automatically. Each task carries a prompt and its target-persona/session binding. Management operations — list, remove, pause, resume, run-now, and **update** (change name/prompt/schedule/max-runs while preserving the task id, its execution history, and its paused state) — SHALL remain available over the existing cell WebSocket surface using the existing `cron_*` message and event types.

#### Scenario: Create a recurring job
- **WHEN** a client sends a job-create request with a cron expression and a prompt
- **THEN** the system SHALL create a task with a schedule trigger and broadcast its status with an identifier, schedule, and next-run time

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

## ADDED Requirements

### Requirement: Relative one-shots are anchored to the server's real clock
A create request carrying a relative delay SHALL be resolved by the server at acceptance time into an absolute run time computed from its own clock; the server SHALL NOT accept a client-computed wall time for the relative form, and SHALL reject delays that are not positive. The stored task SHALL carry the resolved absolute time so restart restores it unchanged.

#### Scenario: 「8 分钟后」 lands eight minutes out
- **WHEN** a client creates a one-shot with a 8-minute relative delay
- **THEN** the resolved run time is creation time + 8 minutes on the server clock, and the broadcast shows that absolute occurrence

#### Scenario: stale client cannot schedule in the past
- **WHEN** a client tries to express a one-shot for a moment that has already passed
- **THEN** the create is rejected with a structured error instead of silently deferring to a future date

### Requirement: Interval rules are the truth, human text is derived
For a recurring task on an every-N interval, the next occurrence SHALL be computed from the stored rule (anchor, unit, number, optional time-of-day phase), not from a coerced cron approximation. Unit/number combinations the five-field cron cannot express (e.g. every 40 days) SHALL be schedulable. Locale human-readable renderings are presentation only and MUST NOT feed back into scheduling math.

#### Scenario: every 40 days schedules correctly
- **WHEN** a task is created with interval unit=day, number=40
- **THEN** occurrences step 40 days apart from the anchor and the list renders a localized phrase without any cron coercion

### Requirement: Finite runs close themselves out
A recurring task with a maximum run count SHALL count completed scheduled executions (run-now and re-runs included as completed executions), transition to `completed` on reaching the cap, stop firing, and expose progress (executed/cap) on the task record.

#### Scenario: task retires at its cap
- **WHEN** the third run completes for a max-runs=3 recurring task
- **THEN** the task shows `completed`, no further occurrences fire, and history retains all three runs

### Requirement: Update preserves identity and history
An update changing the schedule SHALL recompute the next occurrence from the new form while keeping the task id, its execution history, and its paused state. An update MAY change name, prompt, schedule form, and max-runs; changing the target persona/session binding is not part of update.

#### Scenario: reschedule keeps the record
- **WHEN** a running-since-weeks daily job is updated to `0 10 * * 1-5`
- **THEN** the same id keeps its history rows and now fires weekday 10:00, unpaused if it was unpaused
