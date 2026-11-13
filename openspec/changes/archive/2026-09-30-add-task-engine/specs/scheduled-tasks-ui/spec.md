## MODIFIED Requirements

### Requirement: Scheduled-task management page
Both the web app and the miniprogram SHALL provide a task management page (the 唯一任务中心) listing all tasks — not only scheduled ones — with their trigger kind, target persona, prompt, lifecycle state, schedule and timezone label and next run (schedule-triggered tasks), last execution timestamp, and last outcome. The list SHALL update live from the task/job event surface (`cron_*` events) without requiring a manual refresh.

#### Scenario: Browse jobs
- **WHEN** the user opens the task page
- **THEN** all tasks are listed with trigger kind, persona, prompt, lifecycle state, next run where a schedule applies, and last outcome

#### Scenario: Scheduled tasks render as the schedule-trigger category
- **WHEN** the page lists a mix of schedule-triggered and other tasks
- **THEN** each entry shows its trigger kind, and scheduled entries keep showing schedule, timezone, and next run

#### Scenario: Live update
- **WHEN** a task's state changes while the page is open
- **THEN** the affected row SHALL update without a manual refresh

### Requirement: Job actions
Each task entry SHALL offer pause, resume, delete, and run-now actions for schedule-triggered tasks, and a re-run action for executions that ended in `failed` or `interrupted`, with immediate feedback, reflecting optimistic state that reconciles with the broadcast task status.

#### Scenario: Pause from the list
- **WHEN** the user pauses an enabled scheduled task
- **THEN** the entry shows paused state
- **AND** the task's schedule stops firing

#### Scenario: Delete confirmation
- **WHEN** the user deletes a task
- **THEN** the system asks for confirmation before removal

#### Scenario: Re-run a failed task
- **WHEN** the user taps re-run on a task whose last execution failed
- **THEN** the entry reflects a queued execution
- **AND** the reconciled broadcast state shows the fresh execution running
