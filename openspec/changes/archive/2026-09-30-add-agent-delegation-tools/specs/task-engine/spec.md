## ADDED Requirements

### Requirement: Manual trigger executes immediately
A task with trigger `manual` SHALL be enqueued for execution at creation — no schedule is attached, and the engine's serial primary-slot policy applies unchanged. Schedule-side lifecycle SHALL NOT apply to manual tasks (no paused, expired, or completed schedule states); re-run of a terminal execution SHALL remain available. Schedule-triggered semantics are untouched.

#### Scenario: Manual task executes on creation
- **WHEN** a task is created with trigger `manual`
- **THEN** an execution is enqueued immediately and runs under the serial policy

#### Scenario: No schedule-side states on manual tasks
- **WHEN** a manual task's execution is terminal
- **THEN** the task carries the execution lifecycle state (done, failed, or interrupted) and no schedule status beyond its absence of a schedule

#### Scenario: Re-run a manual task
- **WHEN** the user requests a re-run of a manual task whose execution ended failed
- **THEN** a fresh execution is enqueued on the same task and dedicated session
